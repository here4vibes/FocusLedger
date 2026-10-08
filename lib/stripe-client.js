'use strict';
/**
 * Lazily-initialised Stripe client shared by every route that talks to Stripe.
 * Returns null when STRIPE_SECRET_KEY isn't set (CI, local dev) — callers must
 * treat null as "payments not configured" and fail loudly, never silently.
 */
let client = null;

function getStripe() {
  if (!client && process.env.STRIPE_SECRET_KEY) {
    client = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return client;
}

module.exports = { getStripe };
