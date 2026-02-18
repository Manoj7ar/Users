/* global chrome */
/* ── USERS Content Script ────────────────────────────────────────
   Injected at document_idle on all pages.
   - TEACH MODE: captures click events and sends metadata to background
   - EXECUTE MODE: receives action commands and dispatches them
   - RECOVERY MODE: injects highlight overlay on demand
─────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let teachModeActive = false;
  let stepIndex = 0;
  let overlayEl = null;
  let recordingFrameEl = null;
  let recordingFrameStyleEl = null;
  let geminiDockRoot = null;
  let geminiDockLogsEl = null;
  let geminiDockInputEl = null;
  let geminiDockRunBtnEl = null;
  let geminiDockStatusEl = null;
  let geminiDockPanelEl = null;
  let geminiDockToggleEl = null;
  let geminiDockObserver = null;
  let geminiDockPositionRaf = null;
  const geminiRunLogMap = new Map();

  // Recover teach mode state if this content script loads after recording already started.
  try {
    if (chrome.storage?.session?.get) {
      chrome.storage.session.get(['teachState'], (stored) => {
        if (stored?.teachState) {
          teachModeActive = true;
          showRecordingFrame();
        }
      });
    }
  } catch (_) {
    // Ignore if session storage is not accessible in this context.
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.teachState) return;
    if (changes.teachState.newValue) {
      teachModeActive = true;
      stepIndex = 0;
      showRecordingFrame();
    } else {
      teachModeActive = false;
      hideRecordingFrame();
    }
  });

  if (isGeminiChatPage()) {
    initGeminiAutomationDock();
  }

  // ── TEACH: click listener ─────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (!teachModeActive) return;

    // Build human-readable click context from nearby text
    const clickContext = getClickContext(e.target);

    chrome.runtime.sendMessage({
      type: 'CONTENT_CLICK',
      clickContext,
      stepIndex,
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
      pageX: e.pageX,
      pageY: e.pageY
    });

    stepIndex++;
  }, true); // capture phase to catch all clicks

  // ── Incoming messages from background ────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'TEACH_MODE_ON':
        teachModeActive = true;
        stepIndex = 0;
        showRecordingFrame();
        sendResponse({ ok: true });
        break;

      case 'TEACH_MODE_OFF':
        teachModeActive = false;
        hideRecordingFrame();
        sendResponse({ ok: true });
        break;

      case 'EXECUTE_ACTION':
        executeAction(msg.action)
          .then(() => sendResponse({ ok: true }))
          .catch(err => sendResponse({ ok: false, error: err.message }));
        return true; // async

      case 'SHOW_RECOVERY_OVERLAY':
        showRecoveryOverlay(msg.region, msg.question);
        sendResponse({ ok: true });
        break;

      case 'HIDE_RECOVERY_OVERLAY':
        hideRecoveryOverlay();
        sendResponse({ ok: true });
        break;

      case 'GEMINI_AUTOMATION_LOG':
        handleGeminiAutomationLog(msg);
        sendResponse({ ok: true });
        break;

      case 'GEMINI_AUTOMATION_DONE':
        handleGeminiAutomationDone(msg);
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false });
    }
    return false;
  });

  // ── executeAction ─────────────────────────────────────────────
  async function executeAction(action) {
    switch (action.type) {
      case 'click':
        simulateClick(action.x, action.y);
        break;

      case 'type':
        await simulateType(action.x, action.y, action.value ?? '');
        break;

      case 'navigate':
        window.location.href = action.value;
        break;

      case 'scroll':
        performScroll(action.scroll_direction, action.value);
        break;

      default:
        console.warn('[USERS] unknown action type:', action.type);
    }

    // Wait 800ms then signal background for verification
    await sleep(800);
    chrome.runtime.sendMessage({ type: 'SCREENSHOT_VERIFY' });
  }

  function simulateClick(nx, ny) {
    // nx, ny are normalized 0-1 coordinates
    const x = Math.round(nx * window.innerWidth);
    const y = Math.round(ny * window.innerHeight);

    const el = document.elementFromPoint(x, y);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: cx,
        clientY: cy
      }));
    });
  }

  async function simulateType(nx, ny, text) {
    const x = Math.round(nx * window.innerWidth);
    const y = Math.round(ny * window.innerHeight);
    const el = document.elementFromPoint(x, y);
    if (!el) return;

    el.focus();

    // Clear existing value if it's an input/textarea
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = '';
    }

    for (const char of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value += char;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      }

      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(30);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function performScroll(direction, value) {
    const amount = parseInt(value, 10) || 300;
    switch (direction) {
      case 'down':  window.scrollBy({ top:  amount, behavior: 'smooth' }); break;
      case 'up':    window.scrollBy({ top: -amount, behavior: 'smooth' }); break;
      case 'right': window.scrollBy({ left:  amount, behavior: 'smooth' }); break;
      case 'left':  window.scrollBy({ left: -amount, behavior: 'smooth' }); break;
      default:      window.scrollBy({ top:  amount, behavior: 'smooth' }); break;
    }
  }

  // ── Recovery Overlay ──────────────────────────────────────────
  function showRecordingFrame() {
    if (recordingFrameEl) return;
    ensureRecordingFrameStyle();

    const frame = document.createElement('div');
    frame.id = '__users_recording_frame__';
    frame.innerHTML = `
      <div class="users-recording-glow"></div>
      <div class="users-recording-edge users-recording-top"></div>
      <div class="users-recording-edge users-recording-right"></div>
      <div class="users-recording-edge users-recording-bottom"></div>
      <div class="users-recording-edge users-recording-left"></div>
    `;
    document.documentElement.appendChild(frame);
    recordingFrameEl = frame;
  }

  function hideRecordingFrame() {
    if (recordingFrameEl) {
      recordingFrameEl.remove();
      recordingFrameEl = null;
    }
    if (recordingFrameStyleEl) {
      recordingFrameStyleEl.remove();
      recordingFrameStyleEl = null;
    }
  }

  function ensureRecordingFrameStyle() {
    if (recordingFrameStyleEl) return;

    const style = document.createElement('style');
    style.id = '__users_recording_frame_style__';
    style.textContent = `
      @keyframes users-recording-wave {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }

      @keyframes users-recording-pulse {
        0%, 100% {
          opacity: 0.55;
          filter: saturate(1) brightness(0.95);
        }
        50% {
          opacity: 0.92;
          filter: saturate(1.15) brightness(1.08);
        }
      }

      @keyframes users-recording-glow-breathe {
        0%, 100% {
          opacity: 0.55;
          box-shadow:
            inset 0 0 0 1px rgba(104, 170, 255, 0.24),
            inset 0 0 20px rgba(73, 146, 255, 0.08),
            0 0 18px rgba(66, 133, 244, 0.1);
        }
        50% {
          opacity: 0.85;
          box-shadow:
            inset 0 0 0 1px rgba(121, 182, 255, 0.34),
            inset 0 0 28px rgba(85, 158, 255, 0.14),
            0 0 28px rgba(76, 154, 255, 0.16);
        }
      }

      #__users_recording_frame__ {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483646;
      }

      #__users_recording_frame__ .users-recording-glow {
        position: absolute;
        inset: 0;
        border-radius: 0;
        animation: users-recording-glow-breathe 3.8s ease-in-out infinite;
      }

      #__users_recording_frame__ .users-recording-edge {
        position: absolute;
        background: linear-gradient(
          110deg,
          rgba(66, 133, 244, 0.18) 0%,
          rgba(76, 154, 255, 0.82) 20%,
          rgba(142, 193, 255, 0.62) 45%,
          rgba(66, 133, 244, 0.22) 65%,
          rgba(76, 154, 255, 0.74) 80%,
          rgba(66, 133, 244, 0.18) 100%
        );
        background-size: 260% 260%;
        animation:
          users-recording-wave 8s linear infinite,
          users-recording-pulse 3.3s ease-in-out infinite;
      }

      #__users_recording_frame__ .users-recording-top,
      #__users_recording_frame__ .users-recording-bottom {
        left: 0;
        right: 0;
        height: 6px;
      }

      #__users_recording_frame__ .users-recording-top {
        top: 0;
      }

      #__users_recording_frame__ .users-recording-bottom {
        bottom: 0;
      }

      #__users_recording_frame__ .users-recording-left,
      #__users_recording_frame__ .users-recording-right {
        top: 0;
        bottom: 0;
        width: 6px;
      }

      #__users_recording_frame__ .users-recording-left {
        left: 0;
      }

      #__users_recording_frame__ .users-recording-right {
        right: 0;
      }
    `;

    document.documentElement.appendChild(style);
    recordingFrameStyleEl = style;
  }

  function showRecoveryOverlay(region, question) {
    hideRecoveryOverlay();

    const overlay = document.createElement('div');
    overlay.id = '__users_recovery_overlay__';
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: rgba(0,0,0,0.45);
      z-index: 2147483647;
      pointer-events: none;
    `;

    // Highlight box
    if (region) {
      const { x = 0, y = 0, width = 100, height = 40 } = region;
      const px = x * window.innerWidth;
      const py = y * window.innerHeight;
      const pw = width * window.innerWidth;
      const ph = height * window.innerHeight;

      const highlight = document.createElement('div');
      highlight.style.cssText = `
        position: fixed;
        left: ${px}px;
        top: ${py}px;
        width: ${pw}px;
        height: ${ph}px;
        border: 2px solid #f87171;
        border-radius: 4px;
        box-shadow: 0 0 0 9999px rgba(0,0,0,0.45);
        background: transparent;
        pointer-events: none;
      `;
      overlay.appendChild(highlight);
    }

    // Floating question card
    if (question) {
      const card = document.createElement('div');
      card.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: #131820;
        border: 1px solid rgba(248,113,113,0.4);
        border-radius: 10px;
        padding: 14px 18px;
        color: #c8d4e8;
        font-family: 'DM Sans', system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        max-width: 360px;
        text-align: center;
        pointer-events: none;
        box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      `;
      card.innerHTML = `<span style="color:#f87171;font-weight:600">⚠ USERS needs help</span><br/>${escapeHtml(question)}`;
      overlay.appendChild(card);
    }

    document.body.appendChild(overlay);
    overlayEl = overlay;
  }

  function hideRecoveryOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    const existing = document.getElementById('__users_recovery_overlay__');
    if (existing) existing.remove();
  }

  function isGeminiChatPage() {
    return /(^|\.)gemini\.google\.com$/i.test(window.location.hostname);
  }

  function initGeminiAutomationDock() {
    if (geminiDockRoot || !document.body) return;
    ensureGeminiDockStyle();

    const root = document.createElement('div');
    root.id = '__users_gemini_dock__';
    root.innerHTML = `
      <button id="__users_gemini_toggle__" class="users-gemini-toggle">USERS Automate</button>
      <div id="__users_gemini_panel__" class="users-gemini-panel users-hidden">
        <div class="users-gemini-pill-row">
          <input id="__users_gemini_input__" class="users-gemini-input" type="text" placeholder="Describe the task to automate..." />
          <button id="__users_gemini_run__" class="users-gemini-run">Run</button>
        </div>
        <div id="__users_gemini_status__" class="users-gemini-status">
          Opens a new tab, runs actions, then logs every step here.
        </div>
      </div>
      <div id="__users_gemini_logs__" class="users-gemini-logs users-hidden"></div>
    `;

    document.body.appendChild(root);
    geminiDockRoot = root;
    geminiDockRoot.classList.add('users-gemini-dock-hidden');
    geminiDockLogsEl = root.querySelector('#__users_gemini_logs__');
    geminiDockInputEl = root.querySelector('#__users_gemini_input__');
    geminiDockRunBtnEl = root.querySelector('#__users_gemini_run__');
    geminiDockStatusEl = root.querySelector('#__users_gemini_status__');
    geminiDockPanelEl = root.querySelector('#__users_gemini_panel__');
    geminiDockToggleEl = root.querySelector('#__users_gemini_toggle__');

    geminiDockToggleEl.addEventListener('click', () => {
      const isHidden = geminiDockPanelEl.classList.contains('users-hidden');
      geminiDockPanelEl.classList.toggle('users-hidden', !isHidden);
      if (!geminiDockLogsEl.classList.contains('users-hidden')) {
        geminiDockLogsEl.classList.remove('users-hidden');
      }
      if (isHidden) geminiDockInputEl.focus();
      requestGeminiDockPositionUpdate();
    });

    geminiDockInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runGeminiDockTask();
      }
    });

    geminiDockRunBtnEl.addEventListener('click', runGeminiDockTask);
    startGeminiDockPositionTracking();
    updateGeminiDockPosition();
  }

  function runGeminiDockTask() {
    if (!geminiDockInputEl || !geminiDockRunBtnEl) return;
    const query = (geminiDockInputEl.value || '').trim();
    if (!query) {
      setGeminiDockStatus('Enter a task first.', true);
      geminiDockInputEl.focus();
      return;
    }

    setGeminiDockBusy(true);
    setGeminiDockStatus('Starting automation run…');

    chrome.runtime.sendMessage({ type: 'GEMINI_AGENT_RUN', query }, (response) => {
      setGeminiDockBusy(false);
      if (chrome.runtime.lastError) {
        setGeminiDockStatus(`Failed to start: ${chrome.runtime.lastError.message}`, true);
        return;
      }
      if (!response || !response.ok) {
        setGeminiDockStatus(`Failed to start: ${(response && response.error) || 'unknown error'}`, true);
        return;
      }
      setGeminiDockStatus('Automation started. Watch live logs below.');
      geminiDockInputEl.value = '';
      if (geminiDockLogsEl) geminiDockLogsEl.classList.remove('users-hidden');
    });
  }

  function handleGeminiAutomationLog(msg) {
    if (!isGeminiChatPage()) return;
    if (!geminiDockRoot) initGeminiAutomationDock();
    if (!geminiDockLogsEl) return;

    const runId = msg.runId || 'run';
    const entry = msg.entry || { text: '(no log text)' };
    const runList = ensureGeminiRunList(runId, msg.query || '');

    const row = document.createElement('div');
    row.className = 'users-gemini-log-row';
    row.textContent = entry.text || '';
    runList.appendChild(row);
    geminiDockLogsEl.classList.remove('users-hidden');
    geminiDockLogsEl.scrollTop = geminiDockLogsEl.scrollHeight;
    requestGeminiDockPositionUpdate();
  }

  function handleGeminiAutomationDone(msg) {
    if (!isGeminiChatPage()) return;
    if (!geminiDockRoot) initGeminiAutomationDock();
    if (!geminiDockLogsEl) return;

    const runId = msg.runId || 'run';
    const runList = ensureGeminiRunList(runId, msg.query || '');
    const row = document.createElement('div');
    row.className = 'users-gemini-log-row users-gemini-log-final';
    row.textContent = msg.summary || 'Run finished.';
    runList.appendChild(row);
    geminiDockLogsEl.classList.remove('users-hidden');
    geminiDockLogsEl.scrollTop = geminiDockLogsEl.scrollHeight;
    setGeminiDockStatus(msg.summary || 'Automation run completed.');
    requestGeminiDockPositionUpdate();
  }

  function ensureGeminiRunList(runId, query) {
    if (geminiRunLogMap.has(runId)) {
      return geminiRunLogMap.get(runId);
    }
    const card = document.createElement('div');
    card.className = 'users-gemini-run-card';
    const title = document.createElement('div');
    title.className = 'users-gemini-run-title';
    title.textContent = query ? `Task: ${query}` : `Run ${runId.slice(0, 8)}`;
    const list = document.createElement('div');
    list.className = 'users-gemini-run-list';
    card.appendChild(title);
    card.appendChild(list);
    geminiDockLogsEl.appendChild(card);
    geminiRunLogMap.set(runId, list);
    return list;
  }

  function setGeminiDockBusy(isBusy) {
    if (!geminiDockRunBtnEl || !geminiDockInputEl) return;
    geminiDockRunBtnEl.disabled = !!isBusy;
    geminiDockInputEl.disabled = !!isBusy;
    geminiDockRunBtnEl.textContent = isBusy ? 'Running…' : 'Run';
  }

  function setGeminiDockStatus(text, isError = false) {
    if (!geminiDockStatusEl) return;
    geminiDockStatusEl.textContent = text;
    geminiDockStatusEl.classList.toggle('users-gemini-status-error', !!isError);
    requestGeminiDockPositionUpdate();
  }

  function startGeminiDockPositionTracking() {
    if (!geminiDockRoot || geminiDockObserver) return;

    geminiDockObserver = new MutationObserver(() => {
      requestGeminiDockPositionUpdate();
    });
    geminiDockObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden']
    });

    window.addEventListener('resize', requestGeminiDockPositionUpdate, { passive: true });
    window.addEventListener('scroll', requestGeminiDockPositionUpdate, { passive: true, capture: true });
  }

  function requestGeminiDockPositionUpdate() {
    if (geminiDockPositionRaf) return;
    geminiDockPositionRaf = window.requestAnimationFrame(() => {
      geminiDockPositionRaf = null;
      updateGeminiDockPosition();
    });
  }

  function updateGeminiDockPosition() {
    if (!geminiDockRoot || !geminiDockToggleEl || !geminiDockPanelEl || !geminiDockLogsEl) return;
    const anchor = findGeminiComposerAnchor();
    if (!anchor) {
      geminiDockRoot.classList.add('users-gemini-dock-hidden');
      return;
    }

    geminiDockRoot.classList.remove('users-gemini-dock-hidden');
    const rect = anchor.getBoundingClientRect();
    const desiredWidth = Math.min(760, Math.max(360, rect.width));
    const margin = 10;
    const horizontalInset = 10;
    const maxLeft = Math.max(horizontalInset, window.innerWidth - desiredWidth - horizontalInset);
    const panelLeft = clamp(rect.left + (rect.width / 2) - (desiredWidth / 2), horizontalInset, maxLeft);
    const panelHeight = geminiDockPanelEl.classList.contains('users-hidden')
      ? 0
      : (geminiDockPanelEl.offsetHeight || 62);

    let panelTop = rect.top - panelHeight - margin;
    if (panelTop < 8) {
      panelTop = Math.min(window.innerHeight - panelHeight - 8, rect.bottom + margin);
    }

    geminiDockPanelEl.style.width = `${Math.round(desiredWidth)}px`;
    geminiDockPanelEl.style.left = `${Math.round(panelLeft)}px`;
    geminiDockPanelEl.style.top = `${Math.round(Math.max(8, panelTop))}px`;

    const toolsButton = findGeminiToolsButton();
    const toggleRect = geminiDockToggleEl.getBoundingClientRect();
    const toggleWidth = Math.max(124, Math.ceil(toggleRect.width || 124));
    const toggleHeight = Math.max(34, Math.ceil(toggleRect.height || 34));
    let toggleLeft;
    let toggleTop;

    if (toolsButton) {
      const toolsRect = toolsButton.getBoundingClientRect();
      toggleLeft = clamp(toolsRect.right + 8, 8, window.innerWidth - toggleWidth - 8);
      toggleTop = clamp(
        toolsRect.top + (toolsRect.height / 2) - (toggleHeight / 2),
        8,
        window.innerHeight - toggleHeight - 8
      );
    } else {
      toggleLeft = clamp(panelLeft + desiredWidth - toggleWidth, 8, window.innerWidth - toggleWidth - 8);
      toggleTop = clamp(panelTop - toggleHeight - 8, 8, window.innerHeight - toggleHeight - 8);
    }

    geminiDockToggleEl.style.left = `${Math.round(toggleLeft)}px`;
    geminiDockToggleEl.style.top = `${Math.round(toggleTop)}px`;

    if (!geminiDockLogsEl.classList.contains('users-hidden')) {
      const logsTop = Math.min(
        window.innerHeight - Math.min(geminiDockLogsEl.offsetHeight || 220, 220) - 8,
        Math.max(8, panelTop + panelHeight + 8)
      );
      geminiDockLogsEl.style.width = `${Math.round(desiredWidth)}px`;
      geminiDockLogsEl.style.left = `${Math.round(panelLeft)}px`;
      geminiDockLogsEl.style.top = `${Math.round(logsTop)}px`;
    }
  }

  function findGeminiComposerAnchor() {
    const selectors = [
      'textarea',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-label]',
      '[contenteditable="true"][data-placeholder]'
    ];
    const candidates = [];
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (!isGeminiCandidateVisible(el)) return;
        candidates.push(el);
      });
    });
    if (!candidates.length) return null;

    const active = document.activeElement;
    if (active && candidates.includes(active)) {
      return active;
    }

    let best = null;
    let bestScore = -Infinity;
    candidates.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const areaScore = rect.width * Math.max(rect.height, 42);
      const verticalScore = rect.bottom * 80;
      const score = areaScore + verticalScore;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  function findGeminiToolsButton() {
    const candidates = [];
    document.querySelectorAll('button, [role="button"]').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 28 || rect.height < 20) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      const label = ((el.innerText || el.textContent || '').trim()).toLowerCase();
      if (label !== 'tools') return;
      candidates.push(el);
    });
    if (!candidates.length) return null;

    let best = candidates[0];
    let bestScore = -Infinity;
    candidates.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const score = rect.bottom * 30 + rect.left;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  function isGeminiCandidateVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 16) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function ensureGeminiDockStyle() {
    if (document.getElementById('__users_gemini_dock_style__')) return;
    const style = document.createElement('style');
    style.id = '__users_gemini_dock_style__';
    style.textContent = `
      #__users_gemini_dock__ {
        position: fixed;
        inset: 0;
        z-index: 2147483645;
        pointer-events: none;
        font-family: "DM Sans", system-ui, sans-serif;
        transition: opacity 0.16s ease;
      }

      #__users_gemini_dock__.users-gemini-dock-hidden {
        opacity: 0;
        pointer-events: none;
      }

      #__users_gemini_dock__ .users-hidden {
        display: none;
      }

      #__users_gemini_dock__ .users-gemini-toggle {
        position: fixed;
        pointer-events: auto;
        border: 1px solid rgba(154, 160, 166, 0.26);
        border-radius: 999px;
        padding: 9px 14px;
        background: rgba(60, 64, 67, 0.95);
        color: #e8eaed;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
        cursor: pointer;
        transition: top 0.16s ease, left 0.16s ease;
      }

      #__users_gemini_dock__ .users-gemini-panel {
        position: fixed;
        pointer-events: auto;
        border-radius: 999px;
        padding: 8px;
        background: rgba(32, 33, 36, 0.96);
        border: 1px solid rgba(95, 99, 104, 0.6);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        transition: top 0.16s ease, left 0.16s ease, width 0.16s ease;
      }

      #__users_gemini_dock__ .users-gemini-pill-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #__users_gemini_dock__ .users-gemini-input {
        flex: 1;
        border: 1px solid rgba(95, 99, 104, 0.58);
        border-radius: 999px;
        padding: 11px 14px;
        outline: none;
        background: rgba(48, 49, 52, 0.94);
        color: #e8eaed;
        font-size: 13px;
      }

      #__users_gemini_dock__ .users-gemini-input::placeholder {
        color: rgba(189, 193, 198, 0.76);
      }

      #__users_gemini_dock__ .users-gemini-run {
        border: 1px solid rgba(95, 99, 104, 0.68);
        border-radius: 999px;
        padding: 10px 14px;
        min-width: 78px;
        background: rgba(95, 99, 104, 0.95);
        color: #e8eaed;
        font-weight: 600;
        cursor: pointer;
      }

      #__users_gemini_dock__ .users-gemini-run:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }

      #__users_gemini_dock__ .users-gemini-status {
        margin-top: 7px;
        padding: 0 10px 2px;
        color: rgba(189, 193, 198, 0.95);
        font-size: 11px;
      }

      #__users_gemini_dock__ .users-gemini-status-error {
        color: #f28b82;
      }

      #__users_gemini_dock__ .users-gemini-logs {
        position: fixed;
        pointer-events: auto;
        max-height: 220px;
        overflow-y: auto;
        border-radius: 14px;
        background: rgba(32, 33, 36, 0.97);
        border: 1px solid rgba(95, 99, 104, 0.62);
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
        padding: 10px;
        transition: top 0.16s ease, left 0.16s ease, width 0.16s ease;
      }

      #__users_gemini_dock__ .users-gemini-run-card + .users-gemini-run-card {
        margin-top: 8px;
      }

      #__users_gemini_dock__ .users-gemini-run-title {
        color: #bdc1c6;
        font-size: 11px;
        font-weight: 600;
        margin-bottom: 4px;
      }

      #__users_gemini_dock__ .users-gemini-log-row {
        color: #e8eaed;
        font-size: 12px;
        line-height: 1.45;
        margin-bottom: 2px;
      }

      #__users_gemini_dock__ .users-gemini-log-final {
        color: #9aa0a6;
        font-weight: 600;
      }
    `;
    document.documentElement.appendChild(style);
  }

  // ── getClickContext ───────────────────────────────────────────
  function getClickContext(el) {
    const parts = [];

    // Text of the element itself
    const selfText = (el.textContent || el.innerText || '').trim().slice(0, 80);
    if (selfText) parts.push(selfText);

    // aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) parts.push(`aria-label: ${ariaLabel}`);

    // placeholder
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) parts.push(`placeholder: ${placeholder}`);

    // title
    const title = el.getAttribute('title');
    if (title) parts.push(`title: ${title}`);

    // Tag and type
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    parts.push(type ? `${tag}[type=${type}]` : tag);

    // Parent text for context
    const parent = el.parentElement;
    if (parent) {
      const parentText = (parent.textContent || '').trim().slice(0, 60);
      if (parentText && parentText !== selfText) {
        parts.push(`parent: ${parentText}`);
      }
    }

    return parts.filter(Boolean).join(' | ');
  }

  // ── Utilities ─────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

})();
