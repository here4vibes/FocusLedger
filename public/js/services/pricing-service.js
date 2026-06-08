// pricing-service.js — initiates Stripe checkout from any page.
//
// When the user is logged in, calls POST /api/subscription/checkout to get a
// personalized URL (email pre-filled, user metadata attached). Falls back to
// the raw buy.stripe.com links for unauthenticated visitors.
(function(global) {
  'use strict';

  // Fallback links for unauthenticated visitors or API errors.
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

  var PricingService = {
    // checkout(plan, billing, btn?)
    // plan:    'autopilot' | 'tandem'
    // billing: 'monthly'   | 'annual'
    // btn:     optional button element to disable during redirect
    checkout: async function(plan, billing, btn) {
      var originalText = btn ? btn.textContent : null;
      if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }

      var token = localStorage.getItem('token');
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
          // fall through to fallback link
        }
      }

      // Unauthenticated or API error — use raw payment link
      var url = (FALLBACK[plan] || {})[billing];
      if (url) {
        window.location.href = url;
      } else if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
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
