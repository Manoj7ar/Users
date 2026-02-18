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

// ── Message Router ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'TEACH_START':
      teachState = { sessionId: msg.sessionId, workflowName: msg.workflowName };
      chrome.storage.session.set({ teachState });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs?.[0];
        if (activeTab?.id) {
          sendTabMessageSafe(activeTab.id, { type: 'TEACH_MODE_ON' });
        }
      });
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

    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
  return true; // keep channel open for async responses
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
