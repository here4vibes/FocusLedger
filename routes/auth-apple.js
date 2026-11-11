'use strict';
/**
 * routes/auth-apple.js — Sign in with Apple (web flow), mounted at /api/auth/apple.
 *
 * Owns: GET /config, GET /start, POST /callback.
 * Does NOT own: token crypto (lib/apple-signin.js), user rows (db/apple-auth.js),
 *               Google or password sign-in (routes/auth.js).
 *
 * Flow: /start redirects the browser to Apple with a signed `state`
 * (lib/oauth-state.js, purpose "apple-signin") and a hashed nonce; the raw
 * nonce stays in a short-lived cookie. Apple answers with a cross-site
 * form POST to /callback. The callback is accepted only when
 *   1. the state signature and age check out,
 *   2. the cookie's nonce hashes to the one inside the state (so the callback
 *      belongs to the browser that started the flow — login-CSRF guard), and
 *   3. the id_token from Apple's token endpoint verifies (signature, issuer,
 *      audience, expiry) and carries that same nonce.
 *
 * Not configured (any of APPLE_CLIENT_ID / APPLE_TEAM_ID / APPLE_KEY_ID /
 * APPLE_PRIVATE_KEY missing): /config says enabled:false and the rest is 503.
 */
const express = require('express');
const apple = require('../lib/apple-signin');
const appleDb = require('../db/apple-auth');
const { signPayload, verifyPayload } = require('../lib/oauth-state');
const { generateToken, establishSession } = require('../middleware/auth');
const { sendEmail } = require('../lib/emailService');
const { welcomeTemplate } = require('../lib/emailTemplates');
const { seedDefaultValues } = require('../lib/seedDefaultValues');
const seedStarterRoutine = require('../lib/seedStarterRoutine');
const { logFailure } = require('../lib/log-failure');

const STATE_PURPOSE = 'apple-signin';
const RETURN_PAGES = new Set(['login', 'signup']);
const NONCE_COOKIE = 'fl_apple_nonce';
const NONCE_COOKIE_PATH = '/api/auth/apple';
const NONCE_MAX_AGE_MS = 10 * 60 * 1000;

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

module.exports = function (pool, deps = {}) {
  const router = express.Router();
  const fetchImpl = deps.fetchImpl || fetch;

  function notConfigured(res) {
    return res.status(503).json({
      success: false,
      code: 'APPLE_SIGNIN_NOT_CONFIGURED',
      message: 'Sign in with Apple is not configured. Please use another sign-in method.'
    });
  }

  // GET /api/auth/apple/config — tells the login and signup pages whether to render the button.
  router.get('/config', (req, res) => {
    res.json({ success: true, enabled: apple.isConfigured() });
  });

  // GET /api/auth/apple/start?return_to=login|signup — top-level navigation to Apple.
  router.get('/start', (req, res) => {
    if (!apple.isConfigured()) return notConfigured(res);
    const returnTo = req.query.return_to === 'signup' ? 'signup' : 'login';
    const nonce = apple.newNonce();
    let state;
    try {
      state = signPayload(STATE_PURPOSE, { returnTo, nonce: nonce.hashed });
    } catch (e) {
      console.error('[auth/apple] cannot sign OAuth state:', e.message);
      return notConfigured(res);
    }
    // SameSite=None: Apple's callback is a cross-site POST, and Lax cookies are
    // not sent on those. HttpOnly + Secure, scoped to these routes, 10 minutes.
    res.cookie(NONCE_COOKIE, nonce.raw, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: NONCE_COOKIE_PATH,
      maxAge: NONCE_MAX_AGE_MS
    });
    res.redirect(302, apple.authorizeUrl({ state, nonce: nonce.hashed }));
  });

  // POST /api/auth/apple/callback — Apple's form_post (application/x-www-form-urlencoded).
  router.post('/callback', async (req, res) => {
    if (!apple.isConfigured()) return notConfigured(res);
    const body = req.body || {};
    const fail = (page, code) => res.redirect(303, `/${page}?apple_error=${encodeURIComponent(code)}`);

    const rawNonce = readCookie(req, NONCE_COOKIE);
    res.clearCookie(NONCE_COOKIE, { httpOnly: true, secure: true, sameSite: 'none', path: NONCE_COOKIE_PATH });

    const stateData = verifyPayload(STATE_PURPOSE, body.state);
    if (!stateData || !RETURN_PAGES.has(stateData.returnTo) || typeof stateData.nonce !== 'string') {
      console.warn('[auth/apple/callback] rejected: bad or expired state');
      return fail('login', 'invalid_state');
    }
    const returnTo = stateData.returnTo;

    if (body.error) {
      // user_cancelled_authorize is the normal "Cancel" tap.
      console.warn('[auth/apple/callback] Apple returned an error:', String(body.error).slice(0, 80));
      return fail(returnTo, 'access_denied');
    }
    if (!rawNonce || apple.sha256Hex(rawNonce) !== stateData.nonce) {
      console.warn('[auth/apple/callback] rejected: nonce cookie missing or not the one that started this flow');
      return fail(returnTo, 'invalid_state');
    }
    if (typeof body.code !== 'string' || !body.code) {
      return fail(returnTo, 'invalid_callback');
    }

    let identity;
    let tokens;
    try {
      tokens = await apple.exchangeCode(body.code, fetchImpl);
      identity = await apple.verifyIdToken(tokens.id_token, { nonce: stateData.nonce, fetchImpl });
    } catch (e) {
      console.error('[auth/apple/callback] token exchange or verification failed:', e.message);
      return fail(returnTo, 'verification_failed');
    }

    try {
      const name = apple.nameFromUserField(body.user);
      const result = await appleDb.resolveAppleUser(pool, identity, name);
      if (result.error) {
        console.warn('[auth/apple/callback] could not resolve account:', result.error, '| private relay:', identity.isPrivateEmail);
        return fail(returnTo, result.error);
      }
      const user = { id: result.user.id, email: result.user.email, name: result.user.name };

      // Kept (encrypted) only so account deletion can revoke it.
      if (tokens.refresh_token) {
        const encrypted = apple.encryptRefreshToken(tokens.refresh_token);
        if (encrypted) {
          await appleDb.saveAppleRefreshToken(pool, user.id, encrypted)
            .catch(logFailure('[auth/apple/callback]', 'saveAppleRefreshToken', { userId: user.id }));
        } else {
          console.warn('[auth/apple/callback] no ENCRYPTION_KEY or JWT_SECRET; Apple refresh token not stored | user:', user.id);
        }
      }

      if (result.isNewUser) {
        const { subject, html } = welcomeTemplate({ name: user.name });
        sendEmail(pool, { to: user.email, subject, html, templateType: 'welcome', userId: user.id })
          .catch(logFailure('[auth/apple/callback]', 'welcomeEmail', { userId: user.id }));
        seedStarterRoutine(pool, user.id).catch(logFailure('[auth/apple/callback]', 'seedStarterRoutine', { userId: user.id }));
      }
      // Fire-and-forget (logs its own failures); fills values for accounts that have none.
      seedDefaultValues(pool, user.id);

      const token = generateToken(user);
      establishSession(req, user);

      const qs = new URLSearchParams({ apple_token: token, apple_email: user.email || '' });
      if (result.linked) qs.set('apple_linked', '1');
      if (result.isNewUser) qs.set('apple_new', '1');
      res.redirect(303, `/${returnTo}?${qs.toString()}`);
    } catch (e) {
      console.error('[auth/apple/callback] failed:', e.message, '| sub present:', !!(identity && identity.sub));
      fail(returnTo, 'server_error');
    }
  });

  return router;
};
