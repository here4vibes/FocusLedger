'use strict';
/**
 * lib/apns-sender.js — Apple Push Notification Service sender.
 * Talks to APNs directly over HTTP/2 with a token-based (ES256 JWT) provider
 * token. Only active when APNS_* env vars are set.
 * WHY no `apn` package: it was unmaintained since 2018 and pulled in a
 * vulnerable jsonwebtoken 8 + node-forge. This uses Node's http2 and the
 * jsonwebtoken 9 the app already depends on.
 * WHY isolated: lets server start cleanly in envs without APNs credentials.
 */

const http2 = require('http2');
const jwt = require('jsonwebtoken');

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const REQUEST_TIMEOUT_MS = 10000;
// Apple: refresh the provider token no more than once every 20 min and no
// less than once an hour (TooManyProviderTokenUpdates / ExpiredProviderToken).
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;

let cachedProviderToken = null; // { token, issuedAt }

function isApnsConfigured() {
  return !!(
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID &&
    process.env.APNS_KEY_P8 &&
    process.env.APNS_BUNDLE_ID
  );
}

function providerToken(now = Date.now()) {
  if (cachedProviderToken && now - cachedProviderToken.issuedAt < PROVIDER_TOKEN_TTL_MS) {
    return cachedProviderToken.token;
  }
  const key = Buffer.from(process.env.APNS_KEY_P8, 'base64').toString('utf8');
  const token = jwt.sign(
    { iss: process.env.APNS_TEAM_ID, iat: Math.floor(now / 1000) },
    key,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APNS_KEY_ID } }
  );
  cachedProviderToken = { token, issuedAt: now };
  return token;
}

/** One POST /3/device/<token>. Resolves { status, reason }; never rejects. */
function sendOne(session, deviceToken, headers, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = session.request({ ':method': 'POST', ':path': `/3/device/${deviceToken}`, ...headers });
    } catch (err) {
      return done({ status: 0, reason: err.message });
    }
    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      done({ status: 0, reason: 'Timeout' });
    });
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      let reason = null;
      if (data) {
        try { reason = JSON.parse(data).reason || null; }
        catch (e) { reason = data.slice(0, 200); }
      }
      done({ status, reason });
    });
    req.on('error', (err) => done({ status: 0, reason: err.message }));
    req.end(body);
  });
}

/**
 * Send a push notification to one or more APNs device tokens.
 * @param {string[]} tokens
 * @param {{ title: string, body: string, url?: string }} payload
 * @param {(invalidToken: string) => void} onInvalidToken — called for 410/BadDeviceToken errors
 * @param {{ host?: string }} [opts] — host override (tests)
 * @returns {Promise<{ sent: number, failed: number }>}
 */
async function sendApnsNotification(tokens, payload, onInvalidToken, opts = {}) {
  if (!isApnsConfigured() || !tokens || !tokens.length) return { sent: 0, failed: 0 };

  const host = opts.host || (process.env.NODE_ENV === 'production' ? PRODUCTION_HOST : SANDBOX_HOST);
  let authToken;
  try {
    authToken = providerToken();
  } catch (err) {
    console.error('[apns] provider token signing failed (check APNS_KEY_P8):', err.message);
    return { sent: 0, failed: tokens.length };
  }

  const headers = {
    authorization: `bearer ${authToken}`,
    'apns-topic': process.env.APNS_BUNDLE_ID,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
    'content-type': 'application/json',
  };
  // `url` sits beside `aps`, where the iOS app's push handler reads it.
  const body = JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body } },
    url: payload.url,
  });

  let session;
  try {
    session = http2.connect(host);
  } catch (err) {
    console.error('[apns] connect failed:', err.message, '| host:', host);
    return { sent: 0, failed: tokens.length };
  }
  session.on('error', (err) => console.error('[apns] session error:', err.message, '| host:', host));

  let sent = 0;
  let failed = 0;
  try {
    for (const token of tokens) {
      const { status, reason } = await sendOne(session, token, headers, body);
      if (status === 200) { sent++; continue; }
      failed++;
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
        if (onInvalidToken) onInvalidToken(token);
      } else {
        console.error('[apns] send failed | status:', status, '| reason:', reason, '| token:', String(token).slice(0, 8) + '…');
      }
    }
  } finally {
    session.close();
  }
  return { sent, failed };
}

module.exports = {
  isApnsConfigured,
  sendApnsNotification,
  _internal: { providerToken, resetProviderToken: () => { cachedProviderToken = null; } },
};
