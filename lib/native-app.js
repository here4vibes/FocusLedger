'use strict';
/**
 * Native iOS app detection and App Store guideline 3.1.1 guards (server side).
 *
 * The Capacitor shell appends NATIVE_UA_TOKEN to its user agent
 * (capacitor.config.ts → ios.appendUserAgent), so the server can tell a request
 * from the App Store build apart from a browser. Inside the app nothing may
 * sell, price or point to a web purchase:
 *   - POST /api/subscription/checkout refuses (routes/subscription.js),
 *   - `/` and `/pricing` redirect to the login page (routes/pages.js),
 *   - upsell sentences are removed from JSON error messages (nativeAppResponses).
 *
 * The browser-side twin is public/js/native-app.js. Keep the token in sync.
 */

const NATIVE_UA_TOKEN = 'FocusLedgerApp';
const NATIVE_CHECKOUT_CODE = 'NATIVE_APP_PURCHASE_UNAVAILABLE';
const NEUTRAL_PLAN_MESSAGE = 'This isn’t included in your current plan.';

// A sentence that asks for money or tells the user to change plan.
const UPSELL_RE = /upgrad|subscribe|switch to autopilot|open it up with|unlock|pricing|\$\s?\d/i;

function isNativeAppRequest(req) {
  const ua = (req && req.headers && req.headers['user-agent']) || '';
  return typeof ua === 'string' && ua.includes(NATIVE_UA_TOKEN);
}

/**
 * Drop the sentences of a message that sell a plan; keep the plain statement.
 * "You have 10 active tasks — the free plan cap. Upgrade for more." →
 * "You have 10 active tasks — the free plan cap."
 */
function stripUpsell(text) {
  if (typeof text !== 'string' || !UPSELL_RE.test(text)) return text;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !UPSELL_RE.test(sentence));
  return kept.length ? kept.join(' ') : NEUTRAL_PLAN_MESSAGE;
}

/** Express middleware: for native-app requests, scrub upsell copy from JSON `message`/`error`. */
function nativeAppResponses(req, res, next) {
  if (!isNativeAppRequest(req)) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const scrubbed = {};
      for (const key of ['message', 'error']) {
        if (typeof body[key] === 'string') {
          const clean = stripUpsell(body[key]);
          if (clean !== body[key]) scrubbed[key] = clean;
        }
      }
      if (Object.keys(scrubbed).length) return json({ ...body, ...scrubbed });
    }
    return json(body);
  };
  next();
}

/** Express middleware: 403 for native-app requests (web checkout is not offered in the app). */
function refuseNativePurchase(req, res, next) {
  if (!isNativeAppRequest(req)) return next();
  console.warn('[native-app] refused web checkout from the iOS app | path:', req.originalUrl, '| user:', req.user && req.user.id);
  return res.status(403).json({
    success: false,
    code: NATIVE_CHECKOUT_CODE,
    message: 'Purchases aren’t available in the iOS app.'
  });
}

// Marketing pages that exist to sell a plan; the app starts at the login page instead.
const SALES_PAGES = new Set(['/', '/index.html', '/pricing', '/pricing.html']);

/** Express middleware: native-app GETs of the landing or pricing page go to /login. */
function nativeAppRedirects(req, res, next) {
  if (req.method === 'GET' && SALES_PAGES.has(req.path) && isNativeAppRequest(req)) {
    return res.redirect(302, '/login');
  }
  next();
}

module.exports = {
  NATIVE_UA_TOKEN,
  NATIVE_CHECKOUT_CODE,
  NEUTRAL_PLAN_MESSAGE,
  isNativeAppRequest,
  stripUpsell,
  nativeAppResponses,
  nativeAppRedirects,
  refuseNativePurchase
};
