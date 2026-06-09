/**
 * buddy-widget.js — P2: Context-Aware Entry + State Persistence.
 *
 * Owns: bubble DOM, panel DOM, all interactions, preference loading/saving,
 *       session memory, context detection, proactive prompts.
 * Does NOT own: shared-nav, page routing, auth logic.
 * Self-initializes on DOMContentLoaded.
 * Excluded pages: /buddy, /checkin, /app/focus/*
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────

  const EXCLUDED_PATHS = [
    '/buddy',
    '/checkin',
  ];

  const BUDDY_ICON = '🤝';
  const SESSION_KEY = 'bw_session';
  const FIRST_MONEY_KEY = 'bw_first_money_done';
  const MAX_SESSION_MSGS = 5;
  const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

  // ── State ──────────────────────────────────────────────────────────────

  let panelOverlay = null;
  let panelEl = null;
  let panelOpen = false;
  let authToken = null;
  let userId = null;
  let isTouchDevice = false;

  // P2: session memory + context
  let widgetSession = []; // { role, content, timestamp }
  let currentPrompt = null; // { prompt, actionLabel, actionPath, dismissKey }
  let contextData = null; // latest /context API response
  let pageUrl = '/'; // set once on init

  // ── Helpers ────────────────────────────────────────────────────────────

  function isExcludedPage() {
    const path = pageUrl;
    if (EXCLUDED_PATHS.includes(path)) return true;
    if (path.startsWith('/app/focus')) return true;
    return false;
  }

  function isLoggedIn() {
    try {
      const token = localStorage.getItem('fl_token');
      if (!token) return false;
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!payload.id) return false;
      authToken = token;
      userId = payload.id;
      return true;
    } catch {
      return false;
    }
  }

  function authHeaders() {
    return { 'Authorization': 'Bearer ' + authToken };
  }

  function api(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...options.headers,
      },
    }).then(r => r.json());
  }

  // ── Session Memory ────────────────────────────────────────────────────

  /**
   * Save a message to session memory.
   * Caps at MAX_SESSION_MSGS (oldest trimmed first).
   */
  function saveMessage(role, content) {
    widgetSession.push({ role, content, timestamp: Date.now() });
    if (widgetSession.length > MAX_SESSION_MSGS) {
      widgetSession.shift();
    }
    persistSession();
  }

  /**
   * Load session from localStorage, checking expiry.
   * Returns true if session is valid and loaded.
   */
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed.messages || !parsed.lastActivity) return false;
      const age = Date.now() - parsed.lastActivity;
      if (age > SESSION_EXPIRY_MS) {
        clearSession();
        return false;
      }
      widgetSession = parsed.messages;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persist current session to localStorage.
   */
  function persistSession() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        messages: widgetSession,
        lastActivity: Date.now(),
      }));
    } catch {
      // Silently fail
    }
  }

  /**
   * Clear session (e.g. on logout or session expiry).
   */
  function clearSession() {
    widgetSession = [];
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  // ── Context Detection ────────────────────────────────────────────────

  /**
   * Fetch context data from API and determine active prompt.
   * @param {string} promptKey — dismiss key for current context
   */
  async function detectContext() {
    if (!authToken) return;

    const localHour = new Date().getHours();
    try {
      const res = await api('/api/buddy-widget/context?localHour=' + localHour);
      if (!res.success) return;

      contextData = res;

      // Build page state from response
      const pageState = {
        taskCount: res.incompleteTaskCount || 0,
        unclassifiedCount: res.unclassifiedCount || 0,
        isEveningTime: res.isEveningTime || false,
        eveningCheckinDone: res.eveningCheckinDone || false,
        routineMissed: res.routineMissed || false,
        hasNewBuddyMessage: res.hasNewBuddyMessage || false,
        firstMoneyVisit: isFirstMoneyVisit(),
        taskJustCompleted: false, // pushed by event
        sessionComplete: res.sessionComplete || false,
      };

      // Get context key + prompt
      const ctx = getBuddyContext(pageUrl, pageState);
      if (ctx.context && ctx.dismissKey && !isDismissed(ctx.dismissKey)) {
        currentPrompt = {
          context: ctx.context,
          prompt: ctx.prompt,
          actionLabel: ctx.actionLabel,
          actionPath: ctx.actionPath,
          dismissKey: ctx.dismissKey,
        };
      } else {
        currentPrompt = null;
      }
    } catch {
      currentPrompt = null;
    }
  }

  /**
   * Check if this is the user's first money page visit today.
   */
  function isFirstMoneyVisit() {
    if (pageUrl !== '/money') return false;
    try {
      const stored = localStorage.getItem(FIRST_MONEY_KEY);
      if (!stored) return true;
      const parsed = JSON.parse(stored);
      const today = new Date().toISOString().split('T')[0];
      return parsed.date !== today;
    } catch {
      return true;
    }
  }

  function markFirstMoneyVisit() {
    try {
      localStorage.setItem(FIRST_MONEY_KEY, JSON.stringify({
        date: new Date().toISOString().split('T')[0],
      }));
    } catch {}
  }

  // ── Context Helpers (inlined from lib/buddyContext.js) ───────────────

  function getBuddyContext(pUrl, state) {
    const hour = new Date().getHours();

    if (state.isEveningTime && !state.eveningCheckinDone) {
      return {
        context: 'evening_checkin_ready',
        prompt: "Evening check-in is ready when you are. 5 minutes?",
        actionLabel: "Start now",
        actionPath: '/checkin',
        dismissKey: 'bw_evening_checkin',
      };
    }
    if (state.routineMissed) {
      return {
        context: 'routine_missed',
        prompt: "You skipped your morning routine today — want to start fresh now?",
        actionLabel: "Restart routine",
        actionPath: '/routines',
        dismissKey: 'bw_routine_missed',
      };
    }
    if (state.unclassifiedCount > 0) {
      const label = state.unclassifiedCount > 1
        ? `You've got ${state.unclassifiedCount} unclassified purchases — want to swipe through them?`
        : `You've got 1 unclassified purchase — want to swipe through it?`;
      return {
        context: 'unclassified_purchases',
        prompt: label,
        actionLabel: "Swipe now",
        actionPath: '/transactions?filter=unclassified',
        dismissKey: 'bw_unclassified',
      };
    }
    if (state.taskCount > 5) {
      return {
        context: 'many_incomplete_tasks',
        prompt: "You've got a few things on your list. Want me to help you prioritize?",
        actionLabel: "Prioritize",
        actionPath: '/app',
        dismissKey: 'bw_tasks',
      };
    }
    if (state.taskJustCompleted) {
      return {
        context: 'task_completed',
        prompt: "Nice. What's next?",
        actionLabel: null,
        actionPath: null,
        dismissKey: 'bw_completed',
      };
    }
    if (state.firstMoneyVisit) {
      return {
        context: 'first_money_visit',
        prompt: "Here's where your spending shows up. Want me to walk you through it?",
        actionLabel: "Show me",
        actionPath: '/money',
        dismissKey: 'bw_money_intro',
      };
    }
    if (state.hasNewBuddyMessage) {
      return {
        context: 'buddy_new_message',
        prompt: "You've got a message from Buddy.",
        actionLabel: "Read it",
        actionPath: '/buddy',
        dismissKey: 'bw_buddy_msg',
      };
    }
    return { context: null, prompt: null, actionLabel: null, actionPath: null, dismissKey: null };
  }

  function isDismissed(dismissKey) {
    try {
      const raw = sessionStorage.getItem('bw_dismissed');
      if (!raw) return false;
      return !!JSON.parse(raw)[dismissKey];
    } catch { return false; }
  }

  function markDismissed(dismissKey) {
    try {
      const raw = sessionStorage.getItem('bw_dismissed');
      const dismissed = raw ? JSON.parse(raw) : {};
      dismissed[dismissKey] = true;
      sessionStorage.setItem('bw_dismissed', JSON.stringify(dismissed));
    } catch {}
  }

  // ── Stylesheet ───────────────────────────────────────────────────────

  function injectStylesheet() {
    if (document.getElementById('buddy-widget-styles')) return;
    var link = document.createElement('link');
    link.id = 'buddy-widget-styles';
    link.rel = 'stylesheet';
    link.href = '/buddy-widget.css';
    document.head.appendChild(link);
  }

  // ── Preferences ──────────────────────────────────────────────────────

  async function loadPreferences() {
    try {
      const res = await api('/api/buddy-widget');
      if (res.success) {
        if (res.visible === false) return null;
        if (res.position) {
          bubbleStartX = res.position.x ?? 20;
          bubbleStartY = res.position.y ?? -80;
        }
        return res;
      }
    } catch {}
    return { visible: true, position: { x: bubbleStartX, y: bubbleStartY } };
  }

  // ── Bubble ──────────────────────────────────────────────────────────

  function buildBubble() {
    var bubble = document.createElement('button');
    bubble.id = 'bw-bubble';
    bubble.setAttribute('aria-label', 'Open Buddy');
    bubble.setAttribute('aria-expanded', 'false');
    bubble.className = 'idle entering';
    bubble.title = 'Tap to chat with Buddy';

    var icon = document.createElement('span');
    icon.id = 'bw-bubble-icon';
    icon.textContent = BUDDY_ICON;
    bubble.appendChild(icon);

    var notifDot = document.createElement('span');
    notifDot.id = 'bw-notif-dot';
    bubble.appendChild(notifDot);

    var notifBadge = document.createElement('span');
    notifBadge.id = 'bw-notif-badge';
    notifBadge.textContent = '0';
    bubble.appendChild(notifBadge);

    applyBubblePosition(bubble, bubbleStartX, bubbleStartY);
    return bubble;
  }

  function applyBubblePosition(el, x, y) {
    el.style.right = x + 'px';
    if (window.innerWidth >= 768) {
      el.style.bottom = (Math.abs(y) + 20) + 'px';
    } else {
      // Mobile: always clamp to minimum 20px from bottom so bubble is never off-screen
      // The 70px assumes a bottom tab bar — if there isn't one, 20px is the safe default
      var rawBottom = 70 + y;
      el.style.bottom = Math.max(20, rawBottom) + 'px';
    }
  }

  // ── Drag Ghost ──────────────────────────────────────────────────────

  function buildDragGhost() {
    var ghost = document.createElement('div');
    ghost.id = 'bw-drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.innerHTML = '<span style="font-size:1.6rem">🤝</span>';
    document.body.appendChild(ghost);
    return ghost;
  }

  // ── Panel ────────────────────────────────────────────────────────────

  function buildPanel() {
    var overlay = document.createElement('div');
    overlay.id = 'bw-panel-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.pointerEvents = 'none'; // safe default even if CSS hasn't loaded yet
    document.body.appendChild(overlay);
    overlay.addEventListener('click', closePanel);

    var panel = document.createElement('div');
    panel.id = 'bw-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Buddy chat');

    panel.innerHTML = [
      '<div id="bw-panel-handle" aria-hidden="true"></div>',
      '<div id="bw-panel-header">',
        '<div id="bw-panel-avatar">🤝</div>',
        '<div id="bw-panel-info">',
          '<div id="bw-panel-name">Buddy</div>',
          '<div id="bw-panel-subtitle">Your accountability partner</div>',
        '</div>',
        '<button id="bw-panel-close" aria-label="Close Buddy panel">✕</button>',
      '</div>',
      '<div id="bw-context-prompt"></div>',
      '<div id="bw-quick-actions">',
        '<button class="bw-quick-btn" data-action="checkin">📋 Check-in</button>',
        '<button class="bw-quick-btn" data-action="plan">🎯 Today plan</button>',
        '<button class="bw-quick-btn" data-action="focus">🎯 Focus mode</button>',
        '<button class="bw-quick-btn" data-action="stuck">🔧 I am stuck</button>',
      '</div>',
      '<div id="bw-panel-content">',
        '<div id="bw-panel-empty">',
          '<div id="bw-panel-empty-icon">🤝</div>',
          '<div>Chat with Buddy anytime.<br>Ask for help, set intentions, or just check in.</div>',
        '</div>',
      '</div>',
      '<div id="bw-panel-input-area">',
        '<textarea id="bw-panel-input" placeholder="Message Buddy..." rows="1" aria-label="Message Buddy"></textarea>',
        '<button id="bw-panel-send" aria-label="Send message" disabled>➤</button>',
      '</div>',
    ].join('');

    document.body.appendChild(panel);

    panel.querySelector('#bw-panel-close').addEventListener('click', closePanel);

    panel.querySelectorAll('.bw-quick-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        handleQuickAction(btn.getAttribute('data-action'));
      });
    });

    var textarea = panel.querySelector('#bw-panel-input');
    textarea.addEventListener('input', function () {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      panel.querySelector('#bw-panel-send').disabled = !textarea.value.trim();
    });

    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim()) sendMessage(textarea.value.trim());
      }
    });

    panel.querySelector('#bw-panel-send').addEventListener('click', function () {
      var text = textarea.value.trim();
      if (text) sendMessage(text);
    });

    return { overlay, panel };
  }

  // ── Panel Open/Close ─────────────────────────────────────────────────

  function openPanel() {
    if (panelOpen) return;
    panelOpen = true;

    panelOverlay.classList.add('open');
    panelOverlay.style.pointerEvents = 'auto';
    panelEl.classList.add('open');
    panelOverlay.setAttribute('aria-hidden', 'false');

    // Show context prompt if available
    showContextPrompt();

    // Focus input
    setTimeout(function () {
      panelEl.querySelector('#bw-panel-input').focus();
    }, 300);

    // Load session messages or fetch from API
    if (loadSession()) {
      renderSessionMessages();
    } else {
      loadRecentMessages();
    }
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;

    panelOverlay.classList.remove('open');
    panelOverlay.style.pointerEvents = 'none';
    panelEl.classList.remove('open');
    panelOverlay.setAttribute('aria-hidden', 'true');
  }

  // ── Context Prompt ─────────────────────────────────────────────────

  /**
   * Show proactive prompt at top of panel, if one is active.
   */
  function showContextPrompt() {
    var container = panelEl.querySelector('#bw-context-prompt');
    container.innerHTML = '';

    if (!currentPrompt) return;

    var wrapper = document.createElement('div');
    wrapper.id = 'bw-context-prompt-wrap';

    var avatar = document.createElement('span');
    avatar.className = 'bw-ctx-avatar';
    avatar.textContent = '🤝';

    var text = document.createElement('div');
    text.className = 'bw-ctx-text';
    text.textContent = currentPrompt.prompt;

    var actions = document.createElement('div');
    actions.className = 'bw-ctx-actions';

    var gotIt = document.createElement('button');
    gotIt.className = 'bw-ctx-btn bw-ctx-got-it';
    gotIt.textContent = 'Got it';
    gotIt.addEventListener('click', function () {
      markDismissed(currentPrompt.dismissKey);
      currentPrompt = null;
      container.innerHTML = '';
    });

    actions.appendChild(gotIt);

    if (currentPrompt.actionLabel && currentPrompt.actionPath) {
      var doIt = document.createElement('button');
      doIt.className = 'bw-ctx-btn bw-ctx-do-it';
      doIt.textContent = currentPrompt.actionLabel;
      doIt.addEventListener('click', function () {
        markDismissed(currentPrompt.dismissKey);
        var path = currentPrompt.actionPath;
        currentPrompt = null;
        closePanel();
        window.location.href = path;
      });
      actions.appendChild(doIt);
    }

    wrapper.appendChild(avatar);
    wrapper.appendChild(text);
    wrapper.appendChild(actions);
    container.appendChild(wrapper);
  }

  // ── Session Messages ─────────────────────────────────────────────────

  function renderSessionMessages() {
    var content = panelEl.querySelector('#bw-panel-content');
    content.innerHTML = '';

    if (widgetSession.length === 0) {
      renderEmpty();
      return;
    }

    widgetSession.forEach(function (msg) {
      addMessageEl(content, msg.role, msg.content, formatTimeFromTs(msg.timestamp), true);
    });

    content.scrollTop = content.scrollHeight;
  }

  function addMessageEl(container, role, text, timeStr, noScroll) {
    var msgDiv = document.createElement('div');
    msgDiv.className = 'bw-message ' + role;
    msgDiv.textContent = text;
    container.appendChild(msgDiv);

    var timeDiv = document.createElement('div');
    timeDiv.className = 'bw-message-time';
    timeDiv.textContent = timeStr;
    if (role === 'buddy') timeDiv.style.textAlign = 'left';
    container.appendChild(timeDiv);

    if (!noScroll) container.scrollTop = container.scrollHeight;
  }

  function formatTimeFromTs(ts) {
    var diffMs = Date.now() - ts;
    var diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return diffMins + 'm ago';
    if (diffMins < 1440) return Math.floor(diffMins / 60) + 'h ago';
    return new Date(ts).toLocaleDateString();
  }

  // ── Load Recent Messages (from API fallback) ─────────────────────────

  async function loadRecentMessages() {
    var content = panelEl.querySelector('#bw-panel-content');
    content.innerHTML = '<div class="bw-message buddy"><div class="bw-loading-dots"><span></span><span></span><span></span></div></div>';

    try {
      var res = await api('/api/buddy-widget/recent?limit=6');
      if (res.success && res.messages && res.messages.length > 0) {
        content.innerHTML = '';
        res.messages.slice(-6).forEach(function (msg) {
          addMessageEl(content, msg.role, msg.content, formatTime(msg.created_at), true);
        });
      } else {
        renderEmpty();
      }
    } catch {
      renderEmpty();
    }

    content.scrollTop = content.scrollHeight;
  }

  function renderMessages(messages) {
    var content = panelEl.querySelector('#bw-panel-content');
    content.innerHTML = '';
    messages.forEach(function (msg) {
      addMessageEl(content, msg.role, msg.content, formatTime(msg.created_at), true);
    });
    content.scrollTop = content.scrollHeight;
  }

  function renderEmpty() {
    var content = panelEl.querySelector('#bw-panel-content');
    content.innerHTML = [
      '<div id="bw-panel-empty">',
        '<div id="bw-panel-empty-icon">🤝</div>',
        '<div>Chat with Buddy anytime.<br>Ask for help, set intentions, or just check in.</div>',
      '</div>',
    ].join('');
  }

  function formatTime(iso) {
    var d = new Date(iso);
    var diffMs = Date.now() - d.getTime();
    var diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return diffMins + 'm ago';
    if (diffMins < 1440) return Math.floor(diffMins / 60) + 'h ago';
    return d.toLocaleDateString();
  }

  // ── Send Message ──────────────────────────────────────────────────────

  async function sendMessage(text) {
    var textarea = panelEl.querySelector('#bw-panel-input');
    var sendBtn = panelEl.querySelector('#bw-panel-send');

    textarea.value = '';
    textarea.style.height = 'auto';
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');

    // Remove empty state if present
    var empty = panelEl.querySelector('#bw-panel-empty');
    if (empty) empty.remove();

    var content = panelEl.querySelector('#bw-panel-content');

    // Add user message
    addMessageEl(content, 'user', text, 'just now', false);
    saveMessage('user', text);

    // Typing indicator
    var typing = document.createElement('div');
    typing.className = 'bw-message buddy';
    typing.id = 'bw-typing-indicator';
    typing.innerHTML = '<div class="bw-loading-dots"><span></span><span></span><span></span></div>';
    content.appendChild(typing);
    content.scrollTop = content.scrollHeight;

    try {
      var res = await api('/api/buddy/conversation', {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });

      typing.remove();

      if (res.success && res.reply) {
        addMessageEl(content, 'buddy', res.reply, 'just now', false);
        saveMessage('buddy', res.reply);
      } else {
        addMessageEl(content, 'buddy', 'Hmm, something went wrong. Try again?', 'just now', false);
        saveMessage('buddy', 'Hmm, something went wrong. Try again?');
      }
    } catch {
      typing.remove();
      addMessageEl(content, 'buddy', 'Hmm, something went wrong. Try again?', 'just now', false);
      saveMessage('buddy', 'Hmm, something went wrong. Try again?');
    }

    sendBtn.classList.remove('sending');
  }

  // ── Quick Actions ─────────────────────────────────────────────────────

  function handleQuickAction(action) {
    if (!authToken) {
      window.location.href = '/login?redirect=' + encodeURIComponent(pageUrl);
      return;
    }

    switch (action) {
      case 'checkin':
        window.location.href = '/checkin';
        break;
      case 'plan':
        sendMessage("Can you give me my today's focus plan?");
        break;
      case 'focus':
        window.location.href = '/app/focus/next';
        break;
      case 'stuck':
        sendMessage("I'm stuck on a task. Can you help me break it down?");
        break;
    }
  }

  // ── Drag Reposition ─────────────────────────────────────────────────

  function setupDrag(bubble) {
    var DRAG_THRESHOLD = 8; // px — below this = tap, above = drag
    var touchDragging = false;
    var touchMoved = false;
    var touchStartX = 0, touchStartY = 0;
    var touchStartRight = 20, touchStartBottom = 80;
    var lastDoubleTap = 0;

    // ── Touch handlers (separate from mouse — no conflict) ───────────
    function onTouchStart(e) {
      // Only skip if a CHILD button was tapped (not the bubble itself)
      var btn = e.target.closest('button');
      if (btn && btn !== bubble) return;
      e.preventDefault(); // { passive: false } must be used
      touchDragging = true;
      touchMoved = false;
      var t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      var style = window.getComputedStyle(bubble);
      touchStartRight = parseInt(style.right) || 20;
      var btmStr = style.bottom || '80px';
      touchStartBottom = parseInt(btmStr) || 80;
      bubble.classList.add('dragging');
      bubble.classList.remove('idle');
    }

    function onTouchMove(e) {
      if (!touchDragging) return;
      e.preventDefault();
      var t = e.touches[0];
      var dx = touchStartX - t.clientX;
      var dy = t.clientY - touchStartY; // inverted: bottom increases upward
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        touchMoved = true;
      }
      if (touchMoved) {
        var newRight = Math.max(0, touchStartRight + dx);
        var newBottom = Math.max(20, touchStartBottom - dy);
        bubble.style.right = newRight + 'px';
        bubble.style.bottom = newBottom + 'px';
      }
    }

    function onTouchEnd(e) {
      if (!touchDragging) return;
      touchDragging = false;
      bubble.classList.remove('dragging');

      if (!touchMoved) {
        // Pure tap (no drag) — open panel or navigate on double-tap
        var now = Date.now();
        if (now - lastDoubleTap < 400) {
          lastDoubleTap = 0;
          window.location.href = '/buddy';
          return;
        }
        lastDoubleTap = now;
        openPanel();
        bubble.classList.add('idle');
        return;
      }

      // Was a drag — save final position
      var newRight = parseInt(bubble.style.right) || touchStartRight;
      var newBottom = parseInt(bubble.style.bottom) || touchStartBottom;
      var newY = -(newBottom - 70); // convert back to y offset
      persistPosition(newRight, newY);
      bubble.classList.add('idle');
      touchMoved = false;
    }

    // ── Mouse handlers (desktop) ──────────────────────────────────────
    function onMouseDown(e) {
      // Only skip if a CHILD button was tapped (not the bubble itself)
      var btn = e.target.closest('button');
      if (btn && btn !== bubble) return;
      e.preventDefault();
      isDragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      var style = window.getComputedStyle(bubble);
      bubbleStartX = parseInt(style.right) || 20;
      var bottomStr = style.bottom || '80px';
      bubbleStartY = -parseInt(bottomStr) || -80;
      bubble.classList.add('dragging');
      bubble.classList.remove('idle');
      dragGhost.style.right = bubbleStartX + 'px';
      var ghostRawBottom = 70 + bubbleStartY;
      dragGhost.style.bottom = Math.max(20, ghostRawBottom) + 'px';
      dragGhost.classList.add('visible');
    }

    function onMouseMove(e) {
      if (!isDragging) return;
      var dx = dragStartX - e.clientX;
      var dy = dragStartY - e.clientY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        dragMoved = true;
      }
      var newX = Math.max(0, bubbleStartX + dx);
      var newY = Math.min(0, bubbleStartY - dy);
      dragGhost.style.right = newX + 'px';
      var ghostRawBottom = 70 + newY;
      dragGhost.style.bottom = Math.max(20, ghostRawBottom) + 'px';
    }

    function onMouseUp(e) {
      if (!isDragging) return;
      isDragging = false;
      bubble.classList.remove('dragging');
      dragGhost.classList.remove('visible');
      var dx = dragStartX - e.clientX;
      var dy = dragStartY - e.clientY;
      var newX = Math.max(0, bubbleStartX + dx);
      var newY = Math.min(0, bubbleStartY - dy);
      applyBubblePosition(bubble, newX, newY);
      bubble.classList.add('idle');
      dragMoved = false;
      persistPosition(newX, newY);
    }

    function onTouchCancel() {
      // WHY: touchcancel fires instead of touchend when iOS interrupts a touch
      // (incoming call, alert, back gesture). Without this, touchDragging stays true
      // and the document touchmove handler calls e.preventDefault() on every
      // subsequent touch, silently blocking all click synthesis site-wide.
      touchDragging = false;
      touchMoved = false;
      bubble.classList.remove('dragging');
      bubble.classList.add('idle');
    }

    // Attach — { passive: false } on ALL touch listeners (required for preventDefault)
    bubble.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: false });
    document.addEventListener('touchcancel', onTouchCancel);

    // Mouse only on desktop (not touch)
    bubble.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function persistPosition(x, y) {
    api('/api/buddy-widget/position', {
      method: 'PATCH',
      body: JSON.stringify({ x, y }),
    }).catch(function () {});
  }

  // ── Tap / Double-tap ────────────────────────────────────────────────

  function setupTap(bubble) {
    bubble.addEventListener('click', function (e) {
      // Only skip if a CHILD button was tapped (not the bubble itself)
      var btn = e.target.closest('button');
      if (btn && btn !== bubble) return;

      var now = Date.now();
      if (now - lastTapTime < 400) {
        window.location.href = '/buddy';
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        setTimeout(function () {
          if (Date.now() - lastTapTime >= 400) {
            openPanel();
          }
        }, 400);
      }
    });
  }

  // ── Visibility Toggle ───────────────────────────────────────────────

  window.__bwSetVisible = function (visible) {
    if (!bubbleEl) return;
    if (visible) {
      bubbleEl.style.display = '';
      api('/api/buddy-widget', {
        method: 'PUT',
        body: JSON.stringify({ visible: true }),
      }).catch(function () {});
    } else {
      bubbleEl.style.display = 'none';
      api('/api/buddy-widget', {
        method: 'PUT',
        body: JSON.stringify({ visible: false }),
      }).catch(function () {});
      if (panelOpen) closePanel();
    }
  };

  // ── Notification Smarts ────────────────────────────────────────────

  async function checkNotifications() {
    if (!authToken) return;
    try {
      var res = await api('/api/buddy-widget/notification-count');
      if (!res.success) return;
      // Notification badge removed with floating bubble — no-op, kept for API health check
    } catch {}
  }

  // ── Task Completion Listener ──────────────────────────────────────

  function setupTaskCompletionListener() {
    document.addEventListener('click', function (e) {
      var cb = e.target.closest('.task-checkbox, [data-task-complete], input[type="checkbox"]');
      if (!cb) return;

      // Small delay to let the UI update
      setTimeout(function () {
        if (currentPrompt && currentPrompt.context === 'task_completed') return;

        // Push task completed into current prompt
        currentPrompt = {
          context: 'task_completed',
          prompt: "Nice. What's next?",
          actionLabel: null,
          actionPath: null,
          dismissKey: 'bw_completed',
        };

        // Show it if panel is open
        if (panelOpen) showContextPrompt();
      }, 500);
    });
  }

  // ── First Money Visit Tracking ────────────────────────────────────

  function checkFirstMoneyVisit() {
    if (pageUrl === '/money') {
      markFirstMoneyVisit();
    }
  }

  // ── Init ───────────────────────────────────────────────────────────

  async function init() {
    try {
      pageUrl = window.location.pathname;

      if (!isLoggedIn()) { window.__buddyReady = false; window.__buddySkip = 'not-logged-in'; return; }
      if (isExcludedPage()) { window.__buddyReady = false; window.__buddySkip = 'excluded-page'; return; }

      injectStylesheet();

      var parts = buildPanel();
      panelOverlay = parts.overlay;
      panelEl = parts.panel;

      // Expose for nav tap integration — Buddy tab calls window.openBuddyPanel()
      window.openBuddyPanel = openPanel;
      window.__buddyReady = true;

      setupTaskCompletionListener();

      // Detect context on init (async, non-blocking)
      detectContext();

      // Check notifications on init + every 60s
      checkNotifications();
      setInterval(checkNotifications, 60000);

      // Track first money visit
      checkFirstMoneyVisit();

      // Keyboard shortcut: Escape to close
      document.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.key === 'Esc') && panelOpen) {
          closePanel();
        }
      });

      window.addEventListener('popstate', function () {
        if (panelOpen) closePanel();
      });
    } catch(e) {
      window.__buddyReady = false;
      window.__buddyError = e.message;
      console.error('[buddy-widget] init failed:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();