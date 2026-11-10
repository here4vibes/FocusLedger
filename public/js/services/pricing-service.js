// pricing-service.js — initiates Stripe checkout from any page.
//
// When the user is logged in, calls POST /api/subscription/checkout to get a
// personalized URL (email pre-filled, user metadata attached). Signed-out
// visitors go to /signup first; the raw buy.stripe.com links are only a
// fallback when the checkout API fails.
(function(global) {
  'use strict';

  // Fallback links for when the checkout API fails.
  // These match config/pricing.js — update both if the links change.
  var FALLBACK = {
    autopilot: {
      monthly: 'https://buy.stripe.com/8x200i6m784y4bS0KZcs800',
      annual:  'https://buy.stripe.com/4gM14m7qb0C60ZGbpDcs801'
    },
    tandem: {
      monthly: 'https://buy.stripe.com/5kQ3cudOzfx07o43Xbcs802',
      annual:  'https://buy.stripe.com/4gM8wOaCnesW37OctHcs803'
    }
  };

  // Inside the native iOS app, Apple requires in-app purchase — we must NOT
  // show Stripe/web checkout there (App Store guideline 3.1.1).
  function isNativeIOS() {
    try {
      return !!(global.Capacitor
        && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()
        && global.Capacitor.getPlatform && global.Capacitor.getPlatform() === 'ios');
    } catch (e) { return false; }
  }

  var PricingService = {
    // checkout(plan, billing, btn?)
    // plan:    'autopilot' | 'tandem'
    // billing: 'monthly'   | 'annual'
    // btn:     optional button element to disable during redirect
    checkout: async function(plan, billing, btn) {
      // On iOS, hand off to native IAP (RevenueCat) — never Stripe.
      if (isNativeIOS()) {
        return PricingService.nativePurchase(plan, billing, btn);
      }

      var originalText = btn ? btn.textContent : null;
      if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }

      // fl_token is the app's session key; 'token' is the legacy name. Reading
      // only 'token' sent signed-in buyers to the bare payment link, without
      // their user id on the Stripe session.
      var token = localStorage.getItem('fl_token') || localStorage.getItem('token');
      if (!token) {
        // Signed-out visitor (e.g. from an ad): create the account first. A
        // payment-link purchase with no matching account is paid but never
        // granted (lib/billing.js returns 'no_user').
        window.location.href = '/signup?plan=' + encodeURIComponent(plan) + '&billing=' + encodeURIComponent(billing);
        return;
      }
      if (token) {
        try {
          var res = await fetch('/api/subscription/checkout', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ plan: plan, billing: billing })
          });
          var data = await res.json();
          if (data.success && data.url) {
            window.location.href = data.url;
            return;
          }
        } catch (e) {
          console.warn('[pricing] checkout API failed, using payment link:', e && e.message);
        }
      }

      // API error — use raw payment link (the webhook matches by email)
      var url = (FALLBACK[plan] || {})[billing];
      if (url) {
        window.location.href = url;
      } else if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    },

    // nativePurchase — iOS in-app purchase via the native bridge. The native
    // layer (RevenueCat Capacitor plugin) injects window.FLNative.purchase;
    // RevenueCat's webhook then grants Autopilot server-side. Until that ships,
    // we never fall back to Stripe inside the app (compliance).
    nativePurchase: function(plan, billing, btn) {
      if (global.FLNative && typeof global.FLNative.purchase === 'function') {
        if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
        try { global.FLNative.purchase(plan, billing); } catch (e) { /* native handles UI */ }
        return;
      }
      // Bridge not present yet — do NOT show web checkout in-app.
      if (global.alert) {
        global.alert('In-app upgrade is coming to the FocusLedger app very soon. For now you can manage Autopilot at focusledger.net.');
      }
    },

    // bindButton(el) — wires a button with data-plan and data-billing attributes.
    // <button data-plan="autopilot" data-billing="monthly">...</button>
    bindButton: function(el) {
      if (!el) return;
      el.addEventListener('click', function(e) {
        e.preventDefault();
        var plan    = el.dataset.plan    || 'autopilot';
        var billing = el.dataset.billing || 'monthly';
        PricingService.checkout(plan, billing, el);
      });
    },

    // bindAll() — auto-wire every [data-plan] button on the page.
    bindAll: function() {
      document.querySelectorAll('[data-plan][data-billing]').forEach(function(el) {
        PricingService.bindButton(el);
      });
    }
  };

  global.PricingService = PricingService;
})(window);
