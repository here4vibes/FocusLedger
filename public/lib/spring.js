/**
 * spring.js — lightweight spring animation utility
 * Owns: spring physics for UI animations
 * Does NOT own: CSS, haptics, or specific component logic
 */

(function(root) {
  'use strict';

  /**
   * Animate a value using spring physics.
   * @param {Object} opts
   * @param {number} opts.from - Start value
   * @param {number} opts.to - End value
   * @param {number} [opts.stiffness=170] - Spring stiffness (higher = snappier)
   * @param {number} [opts.damping=26] - Damping (higher = less bounce)
   * @param {number} [opts.duration=600] - Hard cap in ms (prevents runaway on low-pref)
   * @param {Function} opts.onUpdate - Called with current value
   * @param {Function} [opts.onComplete] - Called when done
   */
  function spring(opts) {
    var from = opts.from || 0;
    var to   = opts.to   || 1;
    var stiffness  = opts.stiffness  || 170;
    var damping    = opts.damping    || 26;
    var duration   = opts.duration   || 600;
    var onUpdate   = opts.onUpdate;
    var onComplete = opts.onComplete;

    var velocity = 0;
    var value   = from;
    var startTime = performance.now();

    function tick(now) {
      var elapsed = now - startTime;
      if (elapsed >= duration) {
        onUpdate && onUpdate(to);
        onComplete && onComplete();
        return;
      }

      var dt = 0.016; // ~60fps
      var springForce = (to - value) * stiffness * dt;
      var dampingForce = -velocity * damping * dt;
      velocity += springForce + dampingForce;
      value   += velocity;

      onUpdate && onUpdate(value);
      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  // ── Preset configs for common use cases ────────────────────────────────────

  spring.checkbox = function(opts) {
    // Scale: 1 → 0.9 → 1.05 → 1.0 with light bounce
    return spring({
      stiffness: 200, damping: 18,
      duration: 450,
      onUpdate: opts.onUpdate,
      onComplete: opts.onComplete
    });
  };

  spring.snappy = function(opts) {
    // Snappy snap-back (card swipe)
    return spring({ stiffness: 240, damping: 22, duration: 350, onUpdate: opts.onUpdate });
  };

  spring.easeOut = function(opts) {
    // Soft spring for toasts/modals
    return spring({ stiffness: 120, damping: 20, duration: 400, onUpdate: opts.onUpdate, onComplete: opts.onComplete });
  };

  root.FLSpring = spring;

}(window));