// pending-checkout.js — continue to Stripe checkout right after signup.
//
// A signed-out visitor who clicks a paid plan is sent to
// /signup?plan=<autopilot|tandem>&billing=<monthly|annual> (pricing-service.js).
// The signup page remembers that choice here (sessionStorage, so it survives
// the Google OAuth round trip in the same tab) and, once the account exists,
// starts checkout through the signed-in POST /api/subscription/checkout. That
// path puts the user's id in the Stripe session metadata (or pre-fills their
// email on the payment link), so the webhook can match the purchase to them.
// If checkout can't start, the user lands in the app as usual.
(function(global) {
  'use strict';

  var KEY = 'fl_pending_checkout';
  var MAX_AGE_MS = 60 * 60 * 1000;
  var PLANS = { autopilot: true, tandem: true };
  var BILLING = { monthly: true, annual: true };

  function valid(plan, billing) {
    return PLANS.hasOwnProperty(plan) && BILLING.hasOwnProperty(billing);
  }

  // remember(search) — store plan/billing from a query string if both are on the allowlist.
  function remember(search) {
    var params = new URLSearchParams(search || '');
    var plan = params.get('plan');
    var billing = params.get('billing') || 'monthly';
    if (!plan || !valid(plan, billing)) return false;
    try {
      global.sessionStorage.setItem(KEY, JSON.stringify({ plan: plan, billing: billing, ts: Date.now() }));
      return true;
    } catch (e) {
      console.warn('[checkout] could not remember plan:', e && e.message);
      return false;
    }
  }

  // take() — read and clear the stored choice; null if absent, stale or invalid.
  function take() {
    var raw = null;
    try {
      raw = global.sessionStorage.getItem(KEY);
      global.sessionStorage.removeItem(KEY);
    } catch (e) {
      console.warn('[checkout] could not read pending plan:', e && e.message);
      return null;
    }
    if (!raw) return null;
    var p = null;
    try { p = JSON.parse(raw); } catch (e) {
      console.warn('[checkout] pending plan is not JSON:', e && e.message);
      return null;
    }
    if (!p || !valid(p.plan, p.billing) || typeof p.ts !== 'number') return null;
    if (Date.now() - p.ts > MAX_AGE_MS) return null;
    return { plan: p.plan, billing: p.billing };
  }

  // continueOr(token, fallbackDest) — go to checkout for the remembered plan,
  // or to fallbackDest when there is none or checkout can't start.
  function continueOr(token, fallbackDest) {
    var pending = take();
    if (!pending || !token) { global.location.href = fallbackDest; return; }
    function fallback(reason) {
      console.warn('[checkout] could not start checkout after signup:', reason, '| plan:', pending.plan, pending.billing);
      global.location.href = fallbackDest;
    }
    fetch('/api/subscription/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ plan: pending.plan, billing: pending.billing })
    })
      .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
      .then(function(res) {
        var url = res.data && res.data.success && res.data.url;
        if (typeof url === 'string' && /^https:\/\//.test(url)) {
          global.location.href = url;
        } else {
          fallback('status ' + res.status);
        }
      })
      .catch(function(e) { fallback(e && e.message); });
  }

  global.PendingCheckout = { remember: remember, take: take, continueOr: continueOr };
})(window);
