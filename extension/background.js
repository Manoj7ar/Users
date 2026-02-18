/* global chrome */

// ── Config ─────────────────────────────────────────────────────
const DEFAULT_BACKEND_URL = 'http://localhost:8080';

// ── State ──────────────────────────────────────────────────────
let teachState = null;    // { sessionId, workflowName }
let executeState = null;  // { executionId, workflowId, totalSteps, stepIndex, running }
let geminiExecutionContext = null; // { runId, sourceTabId, query, workflowName }
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
      if (geminiExecutionContext) {
        pushGeminiLog('Execution stopped by user.');
        finishGeminiRun('Execution stopped by user.');
      }
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
      pushGeminiLog('All workflow steps completed.');
      await completeExecution(executionId);
      return;
    }

    pushGeminiLog(`Step ${stepIndex + 1}/${totalSteps}: capturing screenshot.`);

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
      pushGeminiLog(`Step ${stepIndex + 1}: screenshot failed, retrying.`);
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
      pushGeminiLog(`Step ${stepIndex + 1}: backend call failed, retrying.`);
      await sleep(2000);
      continue;
    }

    // Update popup step state
    notifyPopup({
      type: 'EXECUTE_UPDATE',
      subtype: 'step_update',
      step: { step_index: stepIndex, intent: result.intent ?? '', status: result.recovery_needed ? 'recovering' : 'executing' }
    });
    pushGeminiLog(`Step ${stepIndex + 1}: ${result.intent ?? 'processing'}.`);

    if (result.recovery_needed) {
      pushGeminiLog(`Step ${stepIndex + 1}: recovery needed - ${result.recovery_question ?? 'clarification requested'}`);
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
        pushGeminiLog(`Step ${stepIndex + 1}: executing ${result.action.type} action.`);
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await chrome.tabs.sendMessage(activeTab.id, {
            type: 'EXECUTE_ACTION',
            action: result.action
          });
        }
      } catch (err) {
        console.error('[USERS] action dispatch error', err);
        pushGeminiLog(`Step ${stepIndex + 1}: action dispatch failed.`);
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
    pushGeminiLog(`Step ${stepIndex + 1}: completed.`);

    if (executeState) executeState.stepIndex++;
  }
}

async function handleRecovery(executionId, stepIndex, resolution) {
  pushGeminiLog(`Recovery input received for step ${stepIndex + 1}: "${resolution}"`);
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
    pushGeminiLog(`Recovery request failed for step ${stepIndex + 1}.`);
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
  if (geminiExecutionContext) {
    finishGeminiRun(`Workflow "${geminiExecutionContext.workflowName}" completed successfully.`);
  }
  executeState = null;
  chrome.storage.session.remove('executeState');
}

// ── Verification screenshot (from content.js) ─────────────────
async function handleGeminiAgentRun(query, sourceTab) {
  const sourceTabId = sourceTab?.id;
  if (!sourceTabId) return;
  if (geminiExecutionContext) {
    sendTabMessageSafe(sourceTabId, {
      type: 'GEMINI_AUTOMATION_DONE',
      runId: `run_${Date.now()}`,
      query,
      summary: 'Another Gemini automation run is already in progress.'
    });
    return;
  }
  if (executeState && executeState.running) {
    sendTabMessageSafe(sourceTabId, {
      type: 'GEMINI_AUTOMATION_DONE',
      runId: `run_${Date.now()}`,
      query,
      summary: 'Another execution is already running. Stop it before starting a new one.'
    });
    return;
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  geminiExecutionContext = {
    runId,
    sourceTabId,
    query,
    workflowName: ''
  };

  pushGeminiLog(`Received automation task: "${query}"`);
  let workflows = [];
  try {
    const listRes = await apiFetch(`/workflows/${encodeURIComponent(userId)}`, 'GET');
    workflows = listRes?.workflows || [];
  } catch (err) {
    pushGeminiLog('Could not fetch saved workflows from backend.');
  }

  const matchedWorkflow = findBestWorkflowMatch(query, workflows);
  if (matchedWorkflow) {
    geminiExecutionContext.workflowName = matchedWorkflow.workflow_name || 'workflow';
    pushGeminiLog(`Matched workflow: "${geminiExecutionContext.workflowName}".`);
    try {
      const startRes = await apiFetch('/execute/start', 'POST', {
        workflow_id: matchedWorkflow.workflow_id,
        user_id: userId
      });
      const totalSteps = Number(matchedWorkflow.step_count || 0);
      if (!startRes?.execution_id || totalSteps <= 0) {
        throw new Error('Execution start response missing required data');
      }

      executeState = {
        executionId: startRes.execution_id,
        workflowId: matchedWorkflow.workflow_id,
        totalSteps,
        stepIndex: 0,
        running: true
      };
      chrome.storage.session.set({ executeState });

      pushGeminiLog(`Started workflow execution with ${totalSteps} step(s).`);
      runExecuteLoop().catch((err) => {
        const message = err?.message || String(err);
        pushGeminiLog(`Execution loop failed: ${message}`);
        finishGeminiRun(`Workflow failed: ${message}`);
      });
      return;
    } catch (err) {
      const message = err?.message || String(err);
      pushGeminiLog(`Failed to start matched workflow: ${message}`);
    }
  } else {
    pushGeminiLog('No matching saved workflow found. Falling back to tab-opening mode.');
  }

  await runGeminiTabFallback(query, runId);
}

async function runGeminiTabFallback(query, runId) {
  pushGeminiLog(`Fallback mode: browsing for "${query}".`);
  try {
    const startUrl = inferAutomationStartUrl(query);
    const openedTab = await chrome.tabs.create({ url: startUrl, active: true });
    pushGeminiLog(`Opened new tab: ${startUrl}`);

    await waitForTabComplete(openedTab.id, 25000);
    pushGeminiLog('New tab finished loading.');

    if (startUrl.includes('google.com/search')) {
      const clicked = await clickFirstSearchResult(openedTab.id);
      if (clicked) {
        pushGeminiLog('Clicked first search result.');
        try {
          await waitForTabComplete(openedTab.id, 20000);
          pushGeminiLog('Destination page loaded.');
        } catch (_) {
          pushGeminiLog('Result click succeeded, but load wait timed out.');
        }
      } else {
        pushGeminiLog('No clickable result found; left search results open.');
      }
    } else {
      pushGeminiLog('Opened direct target URL from your request.');
    }

    const finalTab = await chrome.tabs.get(openedTab.id).catch(() => null);
    const finalUrl = finalTab?.url || startUrl;
    finishGeminiRun(`Fallback done. Final tab: ${finalUrl}`, runId);
  } catch (err) {
    const message = err?.message || String(err);
    pushGeminiLog(`Fallback failed: ${message}`);
    finishGeminiRun(`Run failed: ${message}`, runId);
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

function findBestWorkflowMatch(query, workflows) {
  if (!Array.isArray(workflows) || workflows.length === 0) return null;

  const normalizedQuery = normalizeWorkflowText(query);
  if (!normalizedQuery) return null;
  const queryTokens = tokenizeWorkflowText(normalizedQuery);

  let best = null;
  let bestScore = -Infinity;

  for (const workflow of workflows) {
    const workflowName = normalizeWorkflowText(workflow?.workflow_name);
    if (!workflowName) continue;

    const workflowTokens = tokenizeWorkflowText(workflowName);
    const sharedTokenCount = workflowTokens.filter((token) => queryTokens.includes(token)).length;
    const exactMatch = workflowName === normalizedQuery;
    const containsMatch = normalizedQuery.includes(workflowName) || workflowName.includes(normalizedQuery);

    let score = 0;
    if (exactMatch) score += 300;
    if (containsMatch) score += 180;
    score += sharedTokenCount * 35;

    const significantOverlap = workflowTokens.filter(
      (token) => token.length >= 4 && queryTokens.includes(token)
    ).length;
    score += significantOverlap * 15;

    const isCandidate = exactMatch || containsMatch || sharedTokenCount >= 2 || significantOverlap >= 1;
    if (!isCandidate) continue;

    if (score > bestScore) {
      bestScore = score;
      best = workflow;
    }
  }

  return best;
}

function normalizeWorkflowText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeWorkflowText(text) {
  return normalizeWorkflowText(text)
    .split(' ')
    .filter((token) => token.length > 1);
}

function pushGeminiLog(text) {
  const context = geminiExecutionContext;
  if (!context || !context.sourceTabId) return;
  sendTabMessageSafe(context.sourceTabId, {
    type: 'GEMINI_AUTOMATION_LOG',
    runId: context.runId,
    query: context.query,
    entry: {
      text: String(text || ''),
      timestamp: Date.now()
    }
  });
}

function finishGeminiRun(summary, runIdOverride) {
  const context = geminiExecutionContext;
  if (!context) return;
  if (runIdOverride && context.runId !== runIdOverride) return;

  sendTabMessageSafe(context.sourceTabId, {
    type: 'GEMINI_AUTOMATION_DONE',
    runId: context.runId,
    query: context.query,
    summary: String(summary || 'Run finished.')
  });
  geminiExecutionContext = null;
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

