/* global chrome */

// ── Config ─────────────────────────────────────────────────────
const DEFAULT_BACKEND_URL = 'http://localhost:8080';

// ── State ──────────────────────────────────────────────────────
let teachState = null;    // { sessionId, workflowName }
let executeState = null;  // { executionId, workflowId, totalSteps, stepIndex, running }
let backendUrl = DEFAULT_BACKEND_URL;
let userId = 'local-user';

// ── Startup ────────────────────────────────────────────────────
chrome.storage.local.get(['backendUrl', 'userId'], (stored) => {
  if (stored.backendUrl) backendUrl = stored.backendUrl;
  if (stored.userId) userId = stored.userId;
});

try {
  const result = chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
  });
  if (result && typeof result.catch === 'function') {
    result.catch(() => {});
  }
} catch (_) {
  // Ignore if not supported in this Chrome version.
}

// ── Message Router ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'TEACH_START':
      teachState = { sessionId: msg.sessionId, workflowName: msg.workflowName };
      chrome.storage.session.set({ teachState });
      broadcastTeachModeOn();
      // Retry once in case the tab was still loading when TEACH_START fired.
      setTimeout(broadcastTeachModeOn, 350);
      sendResponse({ ok: true });
      break;

    case 'TEACH_STOP':
      teachState = null;
      chrome.storage.session.remove('teachState');
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        tabs.forEach((tab) => {
          if (tab.id) {
            sendTabMessageSafe(tab.id, { type: 'TEACH_MODE_OFF' });
          }
        });
      });
      sendResponse({ ok: true });
      break;

    case 'CONTENT_CLICK':
      handleTeachClick(msg, sender.tab);
      sendResponse({ ok: true });
      break;

    case 'EXECUTE_START':
      executeState = {
        executionId: msg.executionId,
        workflowId: msg.workflowId,
        totalSteps: msg.totalSteps,
        stepIndex: 0,
        running: true
      };
      chrome.storage.session.set({ executeState });
      runExecuteLoop();
      sendResponse({ ok: true });
      break;

    case 'EXECUTE_STOP':
      if (executeState) executeState.running = false;
      executeState = null;
      chrome.storage.session.remove('executeState');
      sendResponse({ ok: true });
      break;

    case 'EXECUTE_RECOVER':
      handleRecovery(msg.executionId, msg.stepIndex, msg.resolution);
      sendResponse({ ok: true });
      break;

    case 'SCREENSHOT_VERIFY':
      handleVerificationScreenshot(msg, sender.tab);
      sendResponse({ ok: true });
      break;

    case 'GEMINI_AGENT_RUN':
      if (!msg.query || !String(msg.query).trim()) {
        sendResponse({ ok: false, error: 'Query is required' });
        break;
      }
      handleGeminiAgentRun(String(msg.query), sender.tab).catch((err) => {
        console.error('[USERS] GEMINI_AGENT_RUN error', err);
      });
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
  return true; // keep channel open for async responses
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!teachState) return;
  if (changeInfo.status === 'complete') {
    sendTabMessageSafe(tabId, { type: 'TEACH_MODE_ON' });
  }
});

// ── TEACH: handle click from content.js ───────────────────────
async function handleTeachClick(msg, tab) {
  if (!teachState) return;

  let screenshotB64 = null;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // strip data URL prefix
    screenshotB64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  } catch (err) {
    console.error('[USERS] screenshot failed', err);
    return;
  }

  const stepIndex = msg.stepIndex ?? 0;

  try {
    const res = await apiFetch('/teach/step', 'POST', {
      session_id: teachState.sessionId,
      screenshot_b64: screenshotB64,
      transcript_segment: msg.transcriptSegment ?? '',
      click_context: msg.clickContext ?? '',
      step_index: stepIndex
    });

    // Notify popup
    chrome.runtime.sendMessage({
      type: 'STEP_CAPTURED',
      stepsCapured: res.steps_captured,
      stepNode: res.step_node
    });
  } catch (err) {
    console.error('[USERS] /teach/step error', err);
  }
}

// ── EXECUTE LOOP ──────────────────────────────────────────────
async function runExecuteLoop() {
  while (executeState && executeState.running) {
    const { executionId, stepIndex, totalSteps } = executeState;

    if (stepIndex >= totalSteps) {
      await completeExecution(executionId);
      return;
    }

    // Notify popup of current step
    notifyPopup({
      type: 'EXECUTE_UPDATE',
      subtype: 'status',
      text: `Capturing screenshot for step ${stepIndex + 1}…`
    });

    // Capture screenshot from the active tab
    let screenshotB64 = null;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) throw new Error('No active tab');
      const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
      screenshotB64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    } catch (err) {
      console.error('[USERS] screenshot error', err);
      notifyPopup({ type: 'EXECUTE_UPDATE', subtype: 'status', text: '⚠ Screenshot failed. Retrying…' });
      await sleep(2000);
      continue;
    }

    let result;
    try {
      result = await apiFetch('/execute/step', 'POST', {
        execution_id: executionId,
        step_index: stepIndex,
        current_screenshot_b64: screenshotB64
      });
    } catch (err) {
      console.error('[USERS] /execute/step error', err);
      await sleep(2000);
      continue;
    }

    // Update popup step state
    notifyPopup({
      type: 'EXECUTE_UPDATE',
      subtype: 'step_update',
      step: { step_index: stepIndex, intent: result.intent ?? '', status: result.recovery_needed ? 'recovering' : 'executing' }
    });

    if (result.recovery_needed) {
      // Pause loop and wait for recovery
      notifyPopup({
        type: 'EXECUTE_UPDATE',
        subtype: 'recovery',
        question: result.recovery_question,
        stepIndex
      });
      // Loop will resume after EXECUTE_RECOVER message
      executeState.awaitingRecovery = true;
      while (executeState && executeState.awaitingRecovery) {
        await sleep(300);
      }
      continue;
    }

    // Execute the action
    if (result.action) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await chrome.tabs.sendMessage(activeTab.id, {
            type: 'EXECUTE_ACTION',
            action: result.action
          });
        }
      } catch (err) {
        console.error('[USERS] action dispatch error', err);
      }
    }

    // Wait and let the page settle
    await sleep(1200);

    notifyPopup({
      type: 'EXECUTE_UPDATE',
      subtype: 'step_done',
      stepIndex,
      intent: result.intent ?? `Step ${stepIndex + 1}`
    });

    if (executeState) executeState.stepIndex++;
  }
}

async function handleRecovery(executionId, stepIndex, resolution) {
  let screenshotB64 = null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
      screenshotB64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    }
  } catch (err) {
    console.warn('[USERS] recovery screenshot capture failed', err);
  }

  try {
    await apiFetch('/execute/recover', 'POST', {
      execution_id: executionId,
      step_index: stepIndex,
      resolution,
      screenshot_b64: screenshotB64
    });
  } catch (err) {
    console.error('[USERS] /execute/recover error', err);
  }

  if (executeState) {
    executeState.awaitingRecovery = false;
  }
}

async function completeExecution(executionId) {
  try {
    await apiFetch('/execute/complete', 'POST', { execution_id: executionId });
  } catch (_) {}

  notifyPopup({ type: 'EXECUTE_UPDATE', subtype: 'complete' });
  executeState = null;
  chrome.storage.session.remove('executeState');
}

// ── Verification screenshot (from content.js) ─────────────────
async function handleGeminiAgentRun(query, sourceTab) {
  const sourceTabId = sourceTab?.id;
  if (!sourceTabId) return;

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const logs = [];

  const pushLog = (text) => {
    const entry = { ts: new Date().toISOString(), text };
    logs.push(entry);
    sendTabMessageSafe(sourceTabId, {
      type: 'GEMINI_AUTOMATION_LOG',
      runId,
      query,
      entry
    });
  };

  try {
    pushLog(`Received automation task: "${query}"`);
    const startUrl = inferAutomationStartUrl(query);
    const openedTab = await chrome.tabs.create({ url: startUrl, active: true });
    pushLog(`Opened new tab: ${startUrl}`);

    await waitForTabComplete(openedTab.id, 25000);
    pushLog('New tab finished loading.');

    if (startUrl.includes('google.com/search')) {
      const clicked = await clickFirstSearchResult(openedTab.id);
      if (clicked) {
        pushLog('Clicked first search result.');
        try {
          await waitForTabComplete(openedTab.id, 20000);
          pushLog('Destination page loaded.');
        } catch (_) {
          pushLog('Result click succeeded, but load wait timed out.');
        }
      } else {
        pushLog('No clickable result found; left search results open.');
      }
    } else {
      pushLog('Opened direct target URL from your request.');
    }

    const finalTab = await chrome.tabs.get(openedTab.id).catch(() => null);
    const finalUrl = finalTab?.url || startUrl;
    const summary = `Done. ${logs.length} steps logged. Final tab: ${finalUrl}`;
    sendTabMessageSafe(sourceTabId, {
      type: 'GEMINI_AUTOMATION_DONE',
      runId,
      query,
      summary
    });
  } catch (err) {
    const message = err?.message || String(err);
    pushLog(`Run failed: ${message}`);
    sendTabMessageSafe(sourceTabId, {
      type: 'GEMINI_AUTOMATION_DONE',
      runId,
      query,
      summary: `Run failed: ${message}`
    });
  }
}

function inferAutomationStartUrl(query) {
  const q = String(query || '').trim();
  const urlMatch = q.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) return urlMatch[0];

  const openMatch = q.match(/(?:open|go to|visit)\s+([^\s]+)/i);
  if (openMatch) {
    const candidate = openMatch[1].trim();
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(candidate)) {
      return `https://${candidate.replace(/^https?:\/\//i, '')}`;
    }
  }

  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn(value);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        finish(resolve);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    const timer = setInterval(() => {
      if (settled) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        finish(reject, new Error('Tab load timeout'));
      }
    }, 250);
  });
}

async function clickFirstSearchResult(tabId) {
  if (!tabId) return false;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const heading = document.querySelector('#search a h3, a h3');
        if (!heading) return false;
        const anchor = heading.closest('a');
        if (!anchor) return false;
        anchor.click();
        return true;
      }
    });
    return !!result?.[0]?.result;
  } catch (_) {
    return false;
  }
}
async function handleVerificationScreenshot(msg, tab) {
  if (!executeState) return;
  // Future: send to backend for verification check
  // For now, just let the execute loop naturally advance.
}

// ── Helpers ───────────────────────────────────────────────────
async function apiFetch(path, method, body) {
  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // popup may not be open, that's fine
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendTabMessageSafe(tabId, message) {
  try {
    const result = chrome.tabs.sendMessage(tabId, message);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (_) {
    // The target tab may not have a content script attached yet.
  }
}

function broadcastTeachModeOn() {
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        sendTabMessageSafe(tab.id, { type: 'TEACH_MODE_ON' });
      }
    });
  });
}

