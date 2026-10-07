/*
 * FocusLedger — shared completion reward (dopamine burst)
 *
 * One source of truth for the "you did a thing" celebration so the hit lands
 * the SAME on every surface (weightless, tasks, steps, money), not just the
 * tasks page. ADHD rationale: immediate, visible reward on completion is the
 * delay-aversion/dopamine lever — see /science. Keep it short (<700ms), never
 * block interaction, and honor prefers-reduced-motion.
 *
 * API (global, no deps):
 *   window.flReward.celebrate({ x, y, label, count })  — burst at a point
 *   window.flReward.celebrateEl(el, { label })         — burst at an element's center
 * Both are safe to call repeatedly; particles clean themselves up.
 */
(function () {
  'use strict';
  if (window.flReward) return; // idempotent — tolerate double-loads

  var CSS =
    '@keyframes flRewardFly{0%{transform:translate(0,0) scale(1);opacity:1}' +
    '100%{transform:translate(var(--tx),var(--ty)) scale(0);opacity:0}}' +
    '.fl-reward-particle{position:fixed;width:6px;height:6px;border-radius:50%;' +
    'pointer-events:none;z-index:9999;animation:flRewardFly .55s ease-out forwards}' +
    '@keyframes flRewardFloat{0%{transform:translateY(0) scale(1);opacity:1}' +
    '40%{transform:translateY(-10px) scale(1.05);opacity:1}' +
    '100%{transform:translateY(-38px) scale(.9);opacity:0}}' +
    '.fl-reward-label{position:fixed;pointer-events:none;z-index:9999;' +
    "font-family:'Space Grotesk',system-ui,-apple-system,sans-serif;" +
    'font-size:.72rem;font-weight:700;color:#5BA4A4;white-space:nowrap;' +
    'animation:flRewardFloat .65s ease-out forwards}';

  // Brand-family confetti colors (teal + gold), matching the tasks-page burst.
  var COLORS = ['#5BA4A4', '#c9a84c', '#a8d8d8', '#f0c96a', '#4A9292', '#d4b56a'];

  function injectCSS() {
    if (document.getElementById('fl-reward-css')) return;
    var s = document.createElement('style');
    s.id = 'fl-reward-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function reducedMotion() {
    try {
      return window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  function celebrate(opts) {
    opts = opts || {};
    var x = opts.x, y = opts.y;
    // Default to just above screen-center when no anchor is given (e.g. a
    // conversational completion with no specific element to burst from).
    if (x == null || y == null) {
      x = window.innerWidth / 2;
      y = window.innerHeight * 0.38;
    }
    var label = opts.label || '✓ done';
    injectCSS();

    // Motion-safe path: no flying particles, just a brief static label fade.
    if (reducedMotion()) {
      var l = document.createElement('span');
      l.className = 'fl-reward-label';
      l.textContent = label;
      l.style.cssText = 'left:' + (x + 10) + 'px;top:' + (y - 8) +
        'px;animation:none;opacity:1;transition:opacity .4s ease';
      document.body.appendChild(l);
      setTimeout(function () { l.style.opacity = '0'; }, 500);
      setTimeout(function () { if (l.parentNode) l.remove(); }, 950);
      return;
    }

    var n = opts.count || 8;
    for (var i = 0; i < n; i++) {
      var p = document.createElement('span');
      p.className = 'fl-reward-particle';
      var angle = (i / n) * 360;
      var dist = 20 + Math.random() * 16;
      var tx = Math.cos(angle * Math.PI / 180) * dist;
      var ty = Math.sin(angle * Math.PI / 180) * dist;
      p.style.cssText = 'left:' + (x - 3) + 'px;top:' + (y - 3) + 'px;background:' +
        COLORS[i % COLORS.length] + ';--tx:' + tx + 'px;--ty:' + ty +
        'px;animation-delay:' + (Math.random() * 0.05).toFixed(3) + 's';
      document.body.appendChild(p);
      p.addEventListener('animationend', function (e) {
        if (e.target.parentNode) e.target.remove();
      }, { once: true });
    }

    var lab = document.createElement('span');
    lab.className = 'fl-reward-label';
    lab.textContent = label;
    lab.style.cssText = 'left:' + (x + 10) + 'px;top:' + (y - 8) + 'px';
    document.body.appendChild(lab);
    lab.addEventListener('animationend', function () {
      if (lab.parentNode) lab.remove();
    }, { once: true });
  }

  function celebrateEl(el, opts) {
    if (!el || !el.getBoundingClientRect) return celebrate(opts);
    var r = el.getBoundingClientRect();
    opts = opts || {};
    opts.x = r.left + r.width / 2;
    opts.y = r.top + r.height / 2;
    celebrate(opts);
  }

  window.flReward = { celebrate: celebrate, celebrateEl: celebrateEl };
})();
