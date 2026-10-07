/*
 * FocusLedger — gentle "let it go" (soft release with undo)
 *
 * Replaces the punitive "This can't be undone / permanently deleted" delete
 * confirm. ADHD / rejection-sensitivity rationale: letting a task go should
 * feel like relief, not a scary irreversible verdict. So the task leaves
 * quietly with a grace window to pull it back — no modal, no shame.
 *
 * The delete still happens server-side (no schema change / soft-delete column
 * yet — see docs/adhd-ui-refactor.md Slice 3), but only AFTER the grace window
 * with no undo. During the window nothing is destroyed, so "Keep it" is a true
 * no-op on the backend.
 *
 * API (global, no deps):
 *   window.flSoftRelease({
 *     label,            // task title, shown in the toast
 *     graceMs = 6000,   // how long "Keep it" stays available
 *     onCommit,         // async () => {}  — actually delete (called once, after grace)
 *     onUndo,           // () => {}        — restore the UI (called if kept)
 *   })
 * Starting a new release commits any pending one immediately (one at a time).
 */
(function () {
  'use strict';
  if (window.flSoftRelease) return;

  var CSS =
    '.fl-release-toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));' +
    'transform:translateX(-50%);z-index:9998;display:flex;align-items:center;gap:.75rem;' +
    'background:#011e5c;color:#fff;border-radius:12px;padding:.7rem .9rem .7rem 1rem;' +
    "font-family:'DM Sans',system-ui,-apple-system,sans-serif;font-size:.85rem;font-weight:500;" +
    'box-shadow:0 8px 32px rgba(0,0,0,.28);max-width:calc(100vw - 32px);overflow:hidden;' +
    'opacity:0;transition:opacity .2s ease, transform .2s ease}' +
    '.fl-release-toast.in{opacity:1}' +
    '.fl-release-toast .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:62vw}' +
    '.fl-release-toast .keep{flex:none;background:rgba(255,255,255,.14);color:#fff;border:none;' +
    'border-radius:8px;padding:.4rem .75rem;font:inherit;font-weight:700;cursor:pointer;min-height:36px}' +
    '.fl-release-toast .keep:hover{background:rgba(255,255,255,.24)}' +
    '.fl-release-bar{position:absolute;left:0;bottom:0;height:3px;background:#c9a84c;width:100%;' +
    'transform-origin:left;animation:flReleaseDrain linear forwards}' +
    '@keyframes flReleaseDrain{from{transform:scaleX(1)}to{transform:scaleX(0)}}' +
    '@media (prefers-reduced-motion: reduce){.fl-release-toast{transition:none}.fl-release-bar{animation:none;opacity:.5}}';

  function injectCSS() {
    if (document.getElementById('fl-release-css')) return;
    var s = document.createElement('style');
    s.id = 'fl-release-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var pending = null; // { commit, timer }

  function flushPending(runCommit) {
    if (!pending) return;
    var p = pending;
    pending = null;
    clearTimeout(p.timer);
    if (p.toast && p.toast.parentNode) p.toast.remove();
    if (runCommit && !p.done) { p.done = true; try { p.commit(); } catch (e) { /* caller logs */ } }
  }

  function flSoftRelease(opts) {
    opts = opts || {};
    var graceMs = opts.graceMs || 6000;
    var onCommit = typeof opts.onCommit === 'function' ? opts.onCommit : function () {};
    var onUndo = typeof opts.onUndo === 'function' ? opts.onUndo : function () {};
    var label = opts.label || 'that';

    // Only one release in flight — commit the previous one now.
    flushPending(true);
    injectCSS();

    var toast = document.createElement('div');
    toast.className = 'fl-release-toast';
    toast.setAttribute('role', 'status');

    var txt = document.createElement('span');
    txt.className = 'lbl';
    txt.textContent = 'Let go of “' + label + '”';
    toast.appendChild(txt);

    var keep = document.createElement('button');
    keep.className = 'keep';
    keep.type = 'button';
    keep.textContent = 'Keep it';
    toast.appendChild(keep);

    var bar = document.createElement('span');
    bar.className = 'fl-release-bar';
    bar.style.animationDuration = graceMs + 'ms';
    toast.appendChild(bar);

    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add('in'); });

    var state = { commit: onCommit, toast: toast, done: false, timer: null };
    pending = state;

    state.timer = setTimeout(function () {
      if (pending !== state) return;
      pending = null;
      state.done = true;
      toast.classList.remove('in');
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 200);
      try { onCommit(); } catch (e) { /* caller logs */ }
    }, graceMs);

    keep.addEventListener('click', function () {
      if (pending !== state) return;
      pending = null;
      clearTimeout(state.timer);
      toast.classList.remove('in');
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 200);
      try { onUndo(); } catch (e) { /* caller logs */ }
    });
  }

  // Commit anything still pending if the user navigates away mid-grace, so a
  // "let go" is never silently lost on unload.
  window.addEventListener('pagehide', function () { flushPending(true); });

  window.flSoftRelease = flSoftRelease;
})();
