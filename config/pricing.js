// Single source of truth for all plan pricing, features, and Stripe links.
//
// Stripe price IDs (STRIPE_PRICE_*): set these in Render env to enable dynamic
// Checkout Sessions with pre-filled email and user metadata. Without them the
// endpoint falls back to buy.stripe.com payment links, which still work but
// don't pre-fill the user's email.
//
// Payment link env vars (STRIPE_LINK_*): override the hardcoded buy.stripe.com
// links when the links are regenerated (e.g. product rebrand, new checkout config).

const PLANS = {
  autopilot: {
    name: 'Autopilot',
    price_monthly: 9.99,
    price_annual: 100,
    stripe: {
      price_monthly: process.env.STRIPE_PRICE_AUTOPILOT_MONTHLY || null,
      price_annual:  process.env.STRIPE_PRICE_AUTOPILOT_ANNUAL  || null,
      link_monthly:  process.env.STRIPE_LINK_AUTOPILOT_MONTHLY  || 'https://buy.stripe.com/8x200i6m784y4bS0KZcs800',
      link_annual:   process.env.STRIPE_LINK_AUTOPILOT_ANNUAL   || 'https://buy.stripe.com/4gM14m7qb0C60ZGbpDcs801',
    },
  },
  tandem: {
    name: 'Tandem',
    price_monthly: 14.99,
    price_annual: 149,
    stripe: {
      price_monthly: process.env.STRIPE_PRICE_TANDEM_MONTHLY || null,
      price_annual:  process.env.STRIPE_PRICE_TANDEM_ANNUAL  || null,
      link_monthly:  process.env.STRIPE_LINK_TANDEM_MONTHLY  || 'https://buy.stripe.com/5kQ3cudOzfx07o43Xbcs802',
      link_annual:   process.env.STRIPE_LINK_TANDEM_ANNUAL   || 'https://buy.stripe.com/4gM8wOaCnesW37OctHcs803',
    },
  },
};

module.exports = { PLANS };
