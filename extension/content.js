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
