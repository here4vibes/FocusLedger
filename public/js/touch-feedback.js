/**
 * touch-feedback.js — Mobile touch feedback layer
 * Owns: haptics on touch + spring micro-animations on interactive elements
 * Does NOT own: business logic, navigation, or element-specific behavior
 *
 * Fires haptic feedback on every interactive touch.
 * Spring animations respect prefers-reduced-motion (haptics still fire).
 * No-op on desktop (no touch events) or when haptics unavailable.
 */
(function(window) {
  'use strict';

  // ── Skip on non-touch devices ────────────────────────────────────────────
  if (!('ontouchstart' in window)) return;

  // ── Reduced motion check ─────────────────────────────────────────────────
  function prefersReducedMotion() {
    return document.documentElement.classList.contains('reduced-motion')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ── Interactive element selectors ────────────────────────────────────────
  // All tappable/clickable elements that should fire feedback
  var INTERACTIVE_SELECTORS = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[role="checkbox"]', '[role="radio"]',
    '[data-action]', '[data-dismiss]', '[data-toggle]',
    '.task-checkbox', '.task-card', '.step-checkbox',
    '.shared-nav-item', '.btn', '.action-btn',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  // Significant actions that get success feedback
  var SIGNIFICANT_ACTIONS = [
    'toggle-task', 'complete-task', 'delete-task',
    'toggle-step', 'save', 'submit', 'confirm'
  ];

  var IN_PROGRESS_ACTIONS = [
    'edit-task', 'expand-task', 'open-modal', 'toggle-notes'
  ];

  // ── Element classification ────────────────────────────────────────────────
  function isSignificant(el) {
    return SIGNIFICANT_ACTIONS.some(function(a) {
      return el.hasAttribute('data-action') && el.getAttribute('data-action') === a;
    });
  }

  function isInProgress(el) {
    return IN_PROGRESS_ACTIONS.some(function(a) {
      return el.hasAttribute('data-action') && el.getAttribute('data-action') === a;
    });
  }

  // ── Spring helper ────────────────────────────────────────────────────────
  function springAnimate(el, fromScale, toScale, duration, callback) {
    if (prefersReducedMotion()) { callback && callback(); return; }
    var raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame;
    var start = null;
    function tick(now) {
      if (!start) start = now;
      var t = Math.min((now - start) / (duration || 300), 1);
      var eased = t < 1 ? t * (2 - t) : 1; // ease-out quad
      var scale = fromScale + (toScale - fromScale) * eased;
      if (el.parentNode) el.style.transform = 'scale(' + scale + ')';
      if (t < 1) {
        raf(tick);
      } else {
        if (el.parentNode) el.style.transform = '';
        callback && callback();
      }
    }
    raf(tick);
  }

  // ── Delegated touch handler ───────────────────────────────────────────────
  var tracked = null; // currently tracked element

  document.addEventListener('touchstart', function(e) {
    var el = e.target.closest(INTERACTIVE_SELECTORS);
    if (!el) return;
    tracked = el;
    // Light haptic on touch start
    if (window.HapticsService) HapticsService.light();
    if (window.FLHaptics) FLHaptics.light();
    // Spring press on interactive elements
    if (!prefersReducedMotion() && window.FLSpring && el.classList) {
      el.style.transition = 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1)';
      el.style.transform = 'scale(0.95)';
    }
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    if (!tracked) return;
    var el = tracked;
    tracked = null;

    // Reset press scale
    if (!prefersReducedMotion() && el.classList) {
      el.style.transform = '';
    }

    // Determine if the action completed vs was just a touch
    var completed = !e.defaultPrevented;

    if (completed) {
      if (isSignificant(el)) {
        // Success haptic: significant action completed
        if (window.HapticsService) HapticsService.success();
        if (window.FLHaptics) FLHaptics.success();
      } else if (isInProgress(el)) {
        // Medium haptic: in-progress action started
        if (window.HapticsService) HapticsService.medium();
        if (window.FLHaptics) FLHaptics.medium();
      } else {
        // Light haptic: simple tap
        if (window.HapticsService) HapticsService.light();
        if (window.FLHaptics) FLHaptics.light();
      }
    }
  }, { passive: true });

  document.addEventListener('touchcancel', function() {
    if (tracked && !prefersReducedMotion()) {
      tracked.style.transform = '';
    }
    tracked = null;
  }, { passive: true });

}(window));