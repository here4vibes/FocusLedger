'use strict';
/**
 * Sign in with Apple — web flow helpers (no HTTP routes, no SQL).
 *
 * Owns: configuration check, the client secret (ES256 JWT), the authorize URL,
 * the token exchange, id_token verification against Apple's JWKS, token
 * revocation, and at-rest encryption of the refresh token.
 * Does NOT own: routes (routes/auth-apple.js) or user rows (db/apple-auth.js).
 *
 * Everything is gated on four env vars. When any is missing, isConfigured()
 * is false, the button is not rendered and the routes answer 503:
 *   APPLE_CLIENT_ID    Services ID, e.g. net.focusledger.signin
 *   APPLE_TEAM_ID      10-character team id
 *   APPLE_KEY_ID       id of the Sign in with Apple key
 *   APPLE_PRIVATE_KEY  contents of the .p8 (PEM; "\n" escapes are accepted)
 * Optional: APPLE_REDIRECT_URI (default https://focusledger.net/api/auth/apple/callback).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const APPLE_ISSUER = 'https://appleid.apple.com';
const AUTHORIZE_URL = `${APPLE_ISSUER}/auth/authorize`;
const TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const REVOKE_URL = `${APPLE_ISSUER}/auth/revoke`;
const JWKS_URL = `${APPLE_ISSUER}/auth/keys`;
const JWKS_TTL_MS = 60 * 60 * 1000;
const PRIVATE_RELAY_DOMAIN = '@privaterelay.appleid.com';

function env(name) {
  return (process.env[name] || '').trim();
}

function config() {
  return {
    clientId: env('APPLE_CLIENT_ID'),
    teamId: env('APPLE_TEAM_ID'),
    keyId: env('APPLE_KEY_ID'),
    // Render and .env files often hold the PEM on one line with literal "\n".
    privateKey: env('APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    redirectUri: env('APPLE_REDIRECT_URI') || 'https://focusledger.net/api/auth/apple/callback'
  };
}

function isConfigured() {
  const c = config();
  return !!(c.clientId && c.teamId && c.keyId && c.privateKey);
}

/** Short-lived ES256 JWT that authenticates us to Apple's token and revoke endpoints. */
function clientSecret(now = Date.now()) {
  const c = config();
  const iat = Math.floor(now / 1000);
  return jwt.sign(
    { iss: c.teamId, iat, exp: iat + 300, aud: APPLE_ISSUER, sub: c.clientId },
    c.privateKey,
    { algorithm: 'ES256', keyid: c.keyId }
  );
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** @returns {{ raw: string, hashed: string }} raw goes in the browser cookie, hashed to Apple and into the state */
function newNonce() {
  const raw = crypto.randomBytes(24).toString('base64url');
  return { raw, hashed: sha256Hex(raw) };
}

function authorizeUrl({ state, nonce }) {
  const c = config();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', c.redirectUri);
  url.searchParams.set('response_type', 'code');
  // Apple only returns name/email scopes with form_post.
  url.searchParams.set('response_mode', 'form_post');
  url.searchParams.set('scope', 'name email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

// ── JWKS ────────────────────────────────────────────────────────────────────
let jwksCache = { keys: null, fetchedAt: 0 };

async function fetchJwks(fetchImpl) {
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error(`Apple JWKS fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys) || !body.keys.length) throw new Error('Apple JWKS response has no keys');
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/** Find the signing key by kid; refetch once when the kid is unknown (Apple rotates keys). */
async function signingKey(kid, fetchImpl) {
  const fresh = jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  let keys = fresh ? jwksCache.keys : await fetchJwks(fetchImpl);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk && fresh) {
    keys = await fetchJwks(fetchImpl);
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error(`Apple signing key not found | kid: ${kid}`);
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function resetJwksCache() {
  jwksCache = { keys: null, fetchedAt: 0 };
}

/**
 * Verify an Apple id_token: RS256 signature against Apple's JWKS, issuer,
 * audience (our Services ID), expiry and the nonce we sent.
 *
 * @param {string} idToken
 * @param {{ nonce: string, fetchImpl?: Function, audience?: string }} opts
 * @returns {Promise<{ sub: string, email: string|null, emailVerified: boolean, isPrivateEmail: boolean }>}
 * @throws when anything does not check out
 */
async function verifyIdToken(idToken, opts) {
  const { nonce, fetchImpl = fetch } = opts || {};
  const audience = (opts && opts.audience) || config().clientId;
  if (!audience) throw new Error('APPLE_CLIENT_ID is not set');
  if (!nonce) throw new Error('nonce is required to verify an Apple id_token');
  if (typeof idToken !== 'string' || !idToken) throw new Error('id_token is missing');

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) throw new Error('id_token is malformed');
  if (decoded.header.alg !== 'RS256') throw new Error(`id_token alg is ${decoded.header.alg}, expected RS256`);

  const key = await signingKey(decoded.header.kid, fetchImpl);
  const claims = jwt.verify(idToken, key, { algorithms: ['RS256'], issuer: APPLE_ISSUER, audience });

  if (!claims.sub) throw new Error('id_token has no sub');
  const sent = Buffer.from(String(nonce));
  const got = Buffer.from(String(claims.nonce || ''));
  if (sent.length !== got.length || !crypto.timingSafeEqual(sent, got)) throw new Error('id_token nonce mismatch');

  const email = typeof claims.email === 'string' && claims.email ? claims.email.toLowerCase() : null;
  return {
    sub: String(claims.sub),
    email,
    // Apple sends these as booleans or as the strings "true"/"false".
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    isPrivateEmail: claims.is_private_email === true || claims.is_private_email === 'true'
      || (!!email && email.endsWith(PRIVATE_RELAY_DOMAIN))
  };
}

/** Exchange the authorization code. @returns {Promise<{ id_token, refresh_token?, access_token? }>} */
async function exchangeCode(code, fetchImpl = fetch) {
  const c = config();
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: c.redirectUri
    })
  });
  const body = await res.json();
  if (!res.ok || body.error || !body.id_token) {
    throw new Error(`Apple token exchange failed: ${body.error || 'HTTP ' + res.status}`);
  }
  return body;
}

/**
 * Revoke a refresh token (required by Apple when an account is deleted).
 * @returns {Promise<boolean>} true when Apple accepted the revocation
 * @throws on a network error or a non-200 answer
 */
async function revokeRefreshToken(refreshToken, fetchImpl = fetch) {
  const c = config();
  const res = await fetchImpl(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: clientSecret(),
      token: refreshToken,
      token_type_hint: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error(`Apple token revocation failed: HTTP ${res.status}`);
  return true;
}

// ── Refresh token at rest (AES-256-GCM) ─────────────────────────────────────
// Stored only so account deletion can revoke it. No key → not stored.
function encKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(`apple-refresh-token:${secret}`).digest();
}

/** @returns {string|null} base64(iv | tag | ciphertext), or null when there is no key or no token */
function encryptRefreshToken(plaintext) {
  const key = encKey();
  if (!plaintext || !key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** @throws when the key is missing or the ciphertext does not authenticate */
function decryptRefreshToken(ciphertext) {
  const key = encKey();
  if (!key) throw new Error('no ENCRYPTION_KEY or JWT_SECRET to decrypt the Apple refresh token');
  const data = Buffer.from(String(ciphertext), 'base64');
  if (data.length < 29) throw new Error('Apple refresh token ciphertext is too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Name from the `user` form field Apple posts on the FIRST authorization only.
 * It is not signed, so it is only ever used as a display name.
 * @returns {string|null}
 */
function nameFromUserField(userField) {
  if (typeof userField !== 'string' || !userField) return null;
  let parsed;
  try {
    parsed = JSON.parse(userField);
  } catch (e) {
    console.warn('[apple-signin] `user` form field is not JSON:', e.message);
    return null;
  }
  const n = parsed && parsed.name;
  if (!n || typeof n !== 'object') return null;
  const full = [n.firstName, n.lastName]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim())
    .join(' ')
    .replace(/[<>]/g, '')
    .slice(0, 100);
  return full || null;
}

module.exports = {
  APPLE_ISSUER,
  PRIVATE_RELAY_DOMAIN,
  isConfigured,
  config,
  clientSecret,
  newNonce,
  sha256Hex,
  authorizeUrl,
  verifyIdToken,
  exchangeCode,
  revokeRefreshToken,
  encryptRefreshToken,
  decryptRefreshToken,
  nameFromUserField,
  resetJwksCache
};
