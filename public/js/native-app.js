/**
 * native-app.js — the one place the browser decides "am I inside the iOS app?".
 *
 * Load it in <head>, before any analytics or pricing script:
 *   <script src="/js/native-app.js"></script>
 *
 * Detection: Capacitor's injected bridge, or the user-agent token the shell
 * appends (capacitor.config.ts → ios.appendUserAgent; server twin: lib/native-app.js).
 *
 * Inside the app (App Store guideline 3.1.1 — no web purchases, no prices, no
 * pointers to where to buy):
 *   - <html> gets class "fl-native-app";
 *   - [data-web-purchase] elements and any link to /pricing or Stripe checkout
 *     are hidden, [data-native-only] elements are shown (hidden in a browser);
 *   - the Meta Pixel never loads (its snippet exits when window.fbq exists);
 *   - `/` and `/pricing` go to the login page (the server redirects too).
 *
 * API: FLNativeApp.isNative(), FLNativeApp.planMessage(kind).
 */
(function (global) {
  'use strict';

  var UA_TOKEN = 'FocusLedgerApp';

  function detect() {
    try {
      var cap = global.Capacitor;
      if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return true;
    } catch (e) {
      console.warn('[native-app] Capacitor check failed:', e && e.message);
    }
    var ua = (global.navigator && global.navigator.userAgent) || '';
    return ua.indexOf(UA_TOKEN) !== -1;
  }

  var native = detect();
  var doc = global.document;

  var MESSAGES = {
    free: 'You’re on the Free plan.',
    task_limit: 'You’ve reached the Free plan’s task limit.',
    feature: 'This isn’t included in your current plan.'
  };

  if (doc && doc.documentElement) {
    var style = doc.createElement('style');
    style.textContent = native
      ? '[data-web-purchase],a[href^="/pricing"],a[href*="buy.stripe.com"],a[href*="checkout.stripe.com"]{display:none !important}'
      : '[data-native-only]{display:none !important}';
    (doc.head || doc.documentElement).appendChild(style);
    if (native) doc.documentElement.classList.add('fl-native-app');
  }

  if (native) {
    // Meta Pixel: public web pages only. A pre-set fbq makes the base snippet
    // return before it injects fbevents.js, and later fbq('track') calls no-op.
    var noop = function () {};
    noop.loaded = true;
    noop.queue = [];
    global.fbq = noop;
    global._fbq = noop;

    // Marketing pages that exist to sell a plan are not part of the app.
    var path = (global.location && global.location.pathname) || '';
    if (path === '/' || path === '/pricing' || path === '/pricing.html' || path === '/index.html') {
      global.location.replace('/login');
    }
  }

  global.FLNativeApp = {
    isNative: function () { return native; },
    planMessage: function (kind) { return MESSAGES[kind] || MESSAGES.feature; }
  };
})(window);
