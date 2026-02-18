/* global chrome */

// ── Constants ─────────────────────────────────────────────────
const DEFAULT_BACKEND_URL = 'http://localhost:8080';

// ── State ──────────────────────────────────────────────────────
let backendUrl = DEFAULT_BACKEND_URL;
let userId = 'local-user';
let currentScreen = 'dashboard';

// Teach state
let teachSessionId = null;
let stepCount = 0;
let recognition = null;
let currentTranscript = '';
let isRecording = false;

// Execute state
let activeExecution = null; // { executionId, workflow, stepIndex, totalSteps }

// ── Startup ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(['backendUrl', 'userId']);
  if (stored.backendUrl) backendUrl = stored.backendUrl;
  if (stored.userId) userId = stored.userId;

  bindEvents();
  const session = await chrome.storage.session.get(['teachState']);
  if (session?.teachState?.sessionId) {
    restoreTeachSession(session.teachState);
  } else {
    showScreen('dashboard');
    loadWorkflows();
  }
});

// ── Screen Routing ─────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  const el = document.getElementById(`screen-${name}`);
  if (el) {
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('active'));
  }
  currentScreen = name;
}

// ── Event Bindings ─────────────────────────────────────────────
function bindEvents() {
  // Dashboard
  document.getElementById('btn-teach-new').addEventListener('click', () => {
    resetTeachScreen();
    showScreen('teach');
  });

  // Teach
  document.getElementById('btn-teach-back').addEventListener('click', () => {
    if (isRecording) stopRecording(false);
    showScreen('dashboard');
    loadWorkflows();
  });

  document.getElementById('btn-start-recording').addEventListener('click', startRecording);
  document.getElementById('btn-stop-save').addEventListener('click', () => stopRecording(true));
  document.getElementById('btn-teach-cancel').addEventListener('click', () => {
    stopRecording(false);
    showScreen('dashboard');
  });

  // Execute
  document.getElementById('btn-execute-back').addEventListener('click', () => {
    stopExecution();
    showScreen('dashboard');
  });

  document.getElementById('btn-execute-stop').addEventListener('click', () => {
    stopExecution();
    showScreen('dashboard');
  });

  document.getElementById('btn-recovery-send').addEventListener('click', submitRecovery);
  document.getElementById('recovery-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitRecovery();
  });
}

// ── Dashboard ──────────────────────────────────────────────────
async function loadWorkflows() {
  const list = document.getElementById('workflow-list');
  const emptyState = document.getElementById('empty-state');
  list.innerHTML = '<div class="loading-row"><div class="mini-spinner"></div>Loading…</div>';

  try {
    const res = await fetch(`${backendUrl}/workflows/${userId}`);
    const data = await res.json();
    const workflows = data.workflows || [];

    list.innerHTML = '';
    if (workflows.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    workflows.forEach(wf => {
      const item = buildWorkflowItem(wf);
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">Could not reach backend</p><p class="empty-sub">${backendUrl}</p></div>`;
    document.getElementById('empty-state').classList.add('hidden');
  }
}

function buildWorkflowItem(wf) {
  const div = document.createElement('div');
  div.className = 'workflow-item';

  const lastRun = wf.last_run
    ? `Last run ${timeAgo(wf.last_run)}`
    : 'Never run';

  div.innerHTML = `
    <div class="workflow-info">
      <div class="workflow-name">${escapeHtml(wf.workflow_name)}</div>
      <div class="workflow-meta">
        <span>⬡ ${wf.step_count ?? wf.steps?.length ?? 0} steps</span>
        <span>◷ ${lastRun}</span>
      </div>
    </div>
    <button class="btn-run" data-id="${wf.workflow_id}">▶ Run</button>
  `;

  div.querySelector('.btn-run').addEventListener('click', () => startExecution(wf));
  return div;
}

// ── TEACH MODE ────────────────────────────────────────────────
function resetTeachScreen() {
  document.getElementById('workflow-name-input').value = '';
  document.getElementById('teach-setup').classList.remove('hidden');
  document.getElementById('teach-recording').classList.add('hidden');
  document.getElementById('rec-dot').classList.add('hidden');
  document.getElementById('step-count').textContent = '0';
  document.getElementById('transcript-content').innerHTML =
    '<span class="transcript-placeholder">Start speaking…</span>';
  document.getElementById('teach-status').textContent = 'Listening… waiting for your next action';
  document.getElementById('teach-progress').style.width = '0%';
  stepCount = 0;
  teachSessionId = null;
  currentTranscript = '';
}

function restoreTeachSession(teachState) {
  isRecording = true;
  teachSessionId = teachState.sessionId;
  stepCount = 0;
  recognition = null;
  currentTranscript = '';

  showScreen('teach');
  document.getElementById('teach-setup').classList.add('hidden');
  document.getElementById('teach-recording').classList.remove('hidden');
  document.getElementById('rec-dot').classList.remove('hidden');
  document.getElementById('step-count').textContent = '0';
  document.getElementById('teach-progress').style.width = '30%';
  document.getElementById('teach-status').textContent =
    'Recording is active. Click in the page. Reopen this popup to Stop & Save.';
}

async function startRecording() {
  const nameInput = document.getElementById('workflow-name-input');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    nameInput.style.borderColor = 'var(--danger)';
    setTimeout(() => { nameInput.style.borderColor = ''; }, 1200);
    return;
  }

  try {
    const res = await fetch(`${backendUrl}/teach/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_name: name, user_id: userId })
    });
    const data = await res.json();
    teachSessionId = data.session_id;
  } catch (err) {
    setTeachStatus('⚠ Could not start session. Is the backend running?');
    return;
  }

  isRecording = true;
  stepCount = 0;

  // Show recording UI
  document.getElementById('teach-setup').classList.add('hidden');
  document.getElementById('teach-recording').classList.remove('hidden');
  document.getElementById('rec-dot').classList.remove('hidden');
  document.getElementById('teach-progress').style.width = '30%';

  // Tell background to start capturing clicks
  chrome.runtime.sendMessage(
    {
      type: 'TEACH_START',
      sessionId: teachSessionId,
      workflowName: name
    },
    () => {
      // Close the popup so the user can immediately interact with the page.
      window.close();
    }
  );

  initSpeechRecognition();
}

async function stopRecording(save) {
  if (!isRecording) return;
  isRecording = false;

  if (recognition) {
    recognition.stop();
    recognition = null;
  }

  chrome.runtime.sendMessage({ type: 'TEACH_STOP' });

  if (!save || !teachSessionId) return;

  setTeachStatus('Saving workflow…');
  document.getElementById('teach-progress').style.width = '80%';

  try {
    const res = await fetch(`${backendUrl}/teach/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: teachSessionId })
    });
    const data = await res.json();
    document.getElementById('teach-progress').style.width = '100%';
    setTeachStatus(`✓ Saved "${data.summary ?? 'workflow'}" (${data.step_count} steps)`);
    setTimeout(() => {
      showScreen('dashboard');
      loadWorkflows();
    }, 1500);
  } catch (err) {
    setTeachStatus('⚠ Error saving workflow.');
  }
}

function setTeachStatus(msg) {
  document.getElementById('teach-status').textContent = msg;
}

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setTeachStatus('⚠ Speech recognition not supported in this browser.');
    return;
  }

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += t;
        currentTranscript += t + ' ';
      } else {
        interim += t;
      }
    }

    const box = document.getElementById('transcript-content');
    box.innerHTML = escapeHtml(currentTranscript)
      + (interim ? `<span style="color:var(--text-muted);font-style:italic">${escapeHtml(interim)}</span>` : '');
    box.scrollTop = box.scrollHeight;
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') {
      setTeachStatus(`Speech error: ${e.error}`);
    }
  };

  recognition.onend = () => {
    if (isRecording) {
      // Restart if still recording
      try { recognition.start(); } catch (_) {}
    }
  };

  recognition.start();
}

// ── Background step events ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STEP_CAPTURED') {
    stepCount = msg.stepsCapured ?? stepCount + 1;
    document.getElementById('step-count').textContent = stepCount;
    setTeachStatus(`Step ${stepCount} captured ✓`);
    setTimeout(() => setTeachStatus('Listening… waiting for your next action'), 1500);
  }

  if (msg.type === 'EXECUTE_UPDATE') {
    handleExecuteUpdate(msg);
  }
});

// ── EXECUTE MODE ──────────────────────────────────────────────
async function startExecution(workflow) {
  showScreen('execute');

  document.getElementById('execute-title').textContent =
    `${workflow.workflow_name} — Running`;
  document.getElementById('current-step-intent').textContent = 'Initializing…';
  document.getElementById('current-step-status').textContent = 'Starting…';
  document.getElementById('steps-log').innerHTML = '';
  document.getElementById('recovery-card').classList.add('hidden');

  const totalSteps = workflow.step_count ?? workflow.steps?.length ?? 0;
  buildSegments(totalSteps);
  document.getElementById('step-progress-label').textContent = `Step 0 of ${totalSteps}`;

  try {
    const res = await fetch(`${backendUrl}/execute/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: workflow.workflow_id, user_id: userId })
    });
    const data = await res.json();
    activeExecution = {
      executionId: data.execution_id,
      workflow,
      stepIndex: 0,
      totalSteps
    };

    // Tell background to start execute loop
    chrome.runtime.sendMessage({
      type: 'EXECUTE_START',
      executionId: data.execution_id,
      workflowId: workflow.workflow_id,
      totalSteps,
      firstStep: data.first_step
    });

    if (data.first_step) {
      updateExecuteStep(data.first_step);
    }
  } catch (err) {
    document.getElementById('current-step-status').textContent = '⚠ Failed to start execution.';
    document.getElementById('current-step-status').className = 'current-step-status recovering-status';
  }
}

function stopExecution() {
  if (activeExecution) {
    chrome.runtime.sendMessage({
      type: 'EXECUTE_STOP',
      executionId: activeExecution.executionId
    });
    if (activeExecution.executionId) {
      fetch(`${backendUrl}/execute/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ execution_id: activeExecution.executionId })
      }).catch(() => {});
    }
  }
  activeExecution = null;
  document.getElementById('execute-spinner').style.display = '';
}

function buildSegments(count) {
  const bar = document.getElementById('segments-bar');
  bar.innerHTML = '';
  for (let i = 0; i < Math.max(count, 1); i++) {
    const seg = document.createElement('div');
    seg.className = 'segment';
    seg.dataset.index = i;
    bar.appendChild(seg);
  }
}

function updateExecuteStep(step) {
  if (!step) return;
  const idx = step.step_index ?? 0;
  if (activeExecution) activeExecution.stepIndex = idx;

  const total = activeExecution?.totalSteps ?? 0;
  document.getElementById('step-progress-label').textContent =
    `Step ${idx + 1} of ${total}`;

  document.getElementById('current-step-intent').textContent =
    step.intent ?? '—';

  const statusEl = document.getElementById('current-step-status');
  if (step.status === 'recovering') {
    statusEl.textContent = 'Recovering…';
    statusEl.className = 'current-step-status recovering-status';
  } else {
    statusEl.textContent = step.status === 'done' ? 'Done ✓' : 'Executing…';
    statusEl.className = 'current-step-status live-status';
  }

  // Update segment
  document.querySelectorAll('.segment').forEach((seg, i) => {
    seg.classList.remove('done', 'active', 'recovering');
    if (i < idx) seg.classList.add('done');
    else if (i === idx) {
      seg.classList.add(step.status === 'recovering' ? 'recovering' : 'active');
    }
  });
}

function handleExecuteUpdate(msg) {
  if (!activeExecution) return;

  if (msg.subtype === 'step_update') {
    updateExecuteStep(msg.step);
  }

  if (msg.subtype === 'step_done') {
    addLogItem(msg.intent);
    document.querySelectorAll('.segment')[msg.stepIndex]?.classList.replace('active', 'done');
  }

  if (msg.subtype === 'recovery') {
    showRecovery(msg.question, msg.stepIndex);
  }

  if (msg.subtype === 'complete') {
    onExecutionComplete();
  }

  if (msg.subtype === 'status') {
    document.getElementById('current-step-status').textContent = msg.text;
  }
}

function addLogItem(intent) {
  const log = document.getElementById('steps-log');
  const item = document.createElement('div');
  item.className = 'log-item';
  item.innerHTML = `<span class="log-check">✓</span><span>${escapeHtml(intent)}</span>`;
  log.appendChild(item);
  log.scrollTop = log.scrollHeight;
}

function showRecovery(question, stepIndex) {
  const card = document.getElementById('recovery-card');
  document.getElementById('recovery-question').textContent = question;
  document.getElementById('recovery-options').innerHTML = '';
  document.getElementById('recovery-input').value = '';
  card.classList.remove('hidden');
  card.dataset.stepIndex = stepIndex;

  document.getElementById('current-step-status').textContent = 'Waiting for your input…';
  document.getElementById('current-step-status').className = 'current-step-status recovering-status';
}

function hideRecovery() {
  document.getElementById('recovery-card').classList.add('hidden');
  document.getElementById('current-step-status').className = 'current-step-status live-status';
  document.getElementById('current-step-status').textContent = 'Resuming…';
}

async function submitRecovery() {
  const input = document.getElementById('recovery-input').value.trim();
  if (!input || !activeExecution) return;

  const card = document.getElementById('recovery-card');
  const stepIndex = parseInt(card.dataset.stepIndex ?? activeExecution.stepIndex, 10);

  hideRecovery();

  chrome.runtime.sendMessage({
    type: 'EXECUTE_RECOVER',
    executionId: activeExecution.executionId,
    stepIndex,
    resolution: input
  });
}

function onExecutionComplete() {
  document.getElementById('execute-spinner').style.display = 'none';
  document.getElementById('execute-title').textContent = 'Completed ✓';
  document.getElementById('current-step-intent').textContent = 'All steps finished successfully.';
  document.getElementById('current-step-status').textContent = '';
  document.getElementById('current-step-status').className = 'current-step-status';
  document.querySelectorAll('.segment').forEach(s => {
    s.classList.remove('active', 'recovering');
    s.classList.add('done');
  });
}

// ── Utilities ──────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(isoString) {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
