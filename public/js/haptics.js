/**
 * haptics.js — Capacitor + Web Vibration API haptics wrapper
 * Owns: haptic feedback on key user interactions
 * Does NOT own: any business logic, UI state, or navigation
 *
 * No-op when running in browser (PWA, desktop). Fires native haptics
 * in the Capacitor iOS shell. Falls back to navigator.vibrate() for
 * browser-based mobile (PWA w/o Capacitor). Silently no-ops on desktop
 * or unsupported browsers.
 */

(function(window) {
  'use strict';

  // ── Environment detection ─────────────────────────────────────────────

  function isNative() {
    return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
  }

  function supportsVibrate() {
    return typeof navigator !== 'undefined' && 'vibrate' in navigator;
  }

  // ── Reduced motion ─────────────────────────────────────────────────────

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Auto-add .reduced-motion class to <html> on load
  // CSS can then use this class to skip/flatten animations
  (function applyReducedMotionClass() {
    if (prefersReducedMotion()) {
      document.documentElement.classList.add('reduced-motion');
    }
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function(e) {
      if (e.matches) {
        document.documentElement.classList.add('reduced-motion');
      } else {
        document.documentElement.classList.remove('reduced-motion');
      }
    });
  }());

  // ── Capacitor Haptics (native iOS) ─────────────────────────────────────

  var _Haptics = null;

  function getCapacitorHaptics() {
    if (_Haptics !== null) return _Haptics;
    try {
      if (isNative() && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
        _Haptics = window.Capacitor.Plugins.Haptics;
      }
    } catch(e) {}
    if (_Haptics === null) _Haptics = false;
    return _Haptics;
  }

  // ── Web Vibration API ──────────────────────────────────────────────────

  function vibrateWeb(patterns) {
    // patterns: [duration] or [short, pause, long] etc.
    try {
      if (supportsVibrate()) navigator.vibrate(patterns);
    } catch(e) {}
  }

  // ── Core fire functions ────────────────────────────────────────────────

  function fireLight() {
    var h = getCapacitorHaptics();
    if (h) {
      try { h.impact({ style: 'LIGHT' }); } catch(e) {}
    } else {
      vibrateWeb(10);
    }
  }

  function fireMedium() {
    var h = getCapacitorHaptics();
    if (h) {
      try { h.impact({ style: 'MEDIUM' }); } catch(e) {}
    } else {
      vibrateWeb(30);
    }
  }

  function fireHeavy() {
    var h = getCapacitorHaptics();
    if (h) {
      try { h.impact({ style: 'HEAVY' }); } catch(e) {}
    } else {
      vibrateWeb(50);
    }
  }

  function fireSuccess() {
    var h = getCapacitorHaptics();
    if (h) {
      try { h.notification({ type: 'SUCCESS' }); } catch(e) {}
    } else {
      vibrateWeb([10, 60, 10, 60, 40]);
    }
  }

  function fireError() {
    var h = getCapacitorHaptics();
    if (h) {
      try { h.notification({ type: 'ERROR' }); } catch(e) {}
    } else {
      vibrateWeb(80);
    }
  }

  // ── Public API — task spec names (primary) ─────────────────────────────

  function light()           { fireLight(); }
  function medium()          { fireMedium(); }
  function heavy()           { fireHeavy(); }
  function success()         { fireSuccess(); }
  function error()           { fireError(); }

  // Convenience aliases from existing Capacitor-only impl
  function taskComplete()    { fireHeavy(); }
  function checkinSubmit()   { fireSuccess(); }
  function taskCreate()       { fireLight(); }
  function buddyMessage()     { fireMedium(); }
  function toggle()           { fireLight(); }

  // Raw impact / notification (Capacitor-style with ImpactStyle enum)
  var ImpactStyle = { Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' };
  var NotificationType = { Success: 'SUCCESS', Error: 'ERROR', Warning: 'WARNING' };

  function impact(style) {
    var h = getCapacitorHaptics();
    if (!h) return;
    try { h.impact({ style: style || ImpactStyle.Medium }); } catch(e) {}
  }

  function notification(type) {
    var h = getCapacitorHaptics();
    if (!h) return;
    try { h.notification({ type: type || NotificationType.Success }); } catch(e) {}
  }

  window.FLHaptics = {
    // Task spec API
    light: light, medium: medium, heavy: heavy, success: success, error: error,
    // Legacy convenience names
    taskComplete: taskComplete, checkinSubmit: checkinSubmit,
    taskCreate: taskCreate, buddyMessage: buddyMessage, toggle: toggle,
    // Raw access
    impact: impact, notification: notification,
    ImpactStyle: ImpactStyle, NotificationType: NotificationType,
    // Reduced motion check
    prefersReducedMotion: prefersReducedMotion
  };

  // Task spec alias: window.HapticsService = FLHaptics
  window.HapticsService = window.FLHaptics;

}(window));