/**
 * push-autoheal.js — keep web-push alive across auth hiccups and iOS eviction.
 *
 * The failure it fixes: a PWA's push subscription is saved to the server via an
 * AUTHENTICATED call. If that call 401'd (expired token) — or iOS evicted the
 * subscription after the app sat idle — the user silently stops receiving nudges,
 * with no repair path except manually re-toggling notifications in Settings. For
 * an app whose whole retention depends on nudges arriving, silent delivery death
 * is silent churn.
 *
 * Fix: on each authenticated app open, if notification permission is ALREADY
 * granted but the server has no subscription for this user, (re)create and save it.
 * - Never prompts — only heals an already-granted state.
 * - Status-gated: if the server already has a subscription, does nothing (so the
 *   /subscribe welcome push doesn't fire on every open).
 * - Runs once per app session.
 */
(function () {
  'use strict';
  try {
    var token = localStorage.getItem('fl_token');
    if (!token) return;                                             // not logged in
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (sessionStorage.getItem('fl_push_healed') === '1') return;   // once per session

    var auth = { 'Authorization': 'Bearer ' + token };

    function b64ToUint8(base64) {
      var pad = '='.repeat((4 - (base64.length % 4)) % 4);
      var b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
      var raw = atob(b);
      var out = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }
    function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } }
    function done() { try { sessionStorage.setItem('fl_push_healed', '1'); } catch (e) {} }

    // 1. Ask the server whether it already has a live subscription for this user.
    fetch('/api/notifications/status', { headers: auth })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (status) {
        // 401/failure → token's dead; the re-login flow owns that, not us.
        if (!status || !status.success) return;
        if (status.subscribed) { done(); return; }   // already saved → nothing to heal, no welcome spam

        // 2. Server has no subscription. Re-establish it.
        return navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.getSubscription().then(function (existing) {
            if (existing) return existing;              // browser has one; the save just never landed
            return fetch('/api/notifications/vapid-public-key')
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (!d || !d.key) throw new Error('no VAPID key');
                return reg.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: b64ToUint8(d.key)
                });
              });
          }).then(function (sub) {
            return fetch('/api/notifications/subscribe', {
              method: 'POST',
              headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
              body: JSON.stringify({ subscription: sub.toJSON(), timezone: tz() })
            });
          }).then(function () {
            done();
            if (window.console) console.log('[push-autoheal] re-registered push subscription');
          });
        });
      })
      .catch(function (e) {
        // Never throw into the page — heals on the next open instead.
        if (window.console) console.warn('[push-autoheal] skipped:', e && e.message);
      });
  } catch (e) { /* never break the page */ }
})();
