'use strict';
/**
 * Signed OAuth `state` that ties a provider callback to the user who started
 * the flow. The callback has no session or JWT, so the state is the only proof
 * of who asked; an unsigned state lets anyone attach their own provider account
 * to another user by forging the id.
 *
 * The purpose is part of the signature, so a state minted for one flow can't be
 * replayed against another. States expire after 10 minutes.
 *
 * signUserState/verifyUserState carry a user id (connect flows: Google
 * Calendar, Gmail, Outlook, Yahoo). signPayload/verifyPayload carry a small
 * JSON object for flows that start before login (Google sign-in).
 */
const crypto = require('crypto');

const MAX_AGE_MS = 10 * 60 * 1000;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set; cannot sign OAuth state');
  return s;
}

function mac(purpose, userId, ts) {
  return crypto.createHmac('sha256', secret()).update(`${purpose}:${userId}:${ts}`).digest('hex');
}

/** @returns {string} base64url state for the provider's `state` parameter */
function signUserState(purpose, userId) {
  const ts = Date.now();
  return Buffer.from(`${userId}:${ts}:${mac(purpose, userId, ts)}`).toString('base64url');
}

function hasSecret(purpose) {
  if (process.env.JWT_SECRET) return true;
  console.error('[oauth-state] JWT_SECRET is not set; rejecting state | purpose:', purpose);
  return false;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** @returns {number|null} the user id, or null if forged, expired or malformed */
function verifyUserState(purpose, state, now = Date.now()) {
  if (typeof state !== 'string' || !state) return null;
  if (!hasSecret(purpose)) return null;
  const parts = Buffer.from(state, 'base64url').toString().split(':');
  if (parts.length !== 3) return null;
  const [userId, ts, sig] = parts;
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(ts)) return null;
  const age = now - Number(ts);
  if (age < 0 || age > MAX_AGE_MS) return null;
  if (!safeEqual(sig, mac(purpose, userId, ts))) return null;
  return Number(userId);
}

function payloadMac(purpose, body) {
  return crypto.createHmac('sha256', secret()).update(`${purpose}:${body}`).digest('hex');
}

/**
 * Sign a small JSON-serialisable object (no user id needed).
 * @returns {string} base64url state
 */
function signPayload(purpose, data) {
  const body = Buffer.from(JSON.stringify({ d: data, ts: Date.now() })).toString('base64url');
  return `${body}.${payloadMac(purpose, body)}`;
}

/** @returns {object|null} the signed object, or null if forged, expired or malformed */
function verifyPayload(purpose, state, now = Date.now()) {
  if (typeof state !== 'string' || !state) return null;
  if (!hasSecret(purpose)) return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!safeEqual(sig, payloadMac(purpose, body))) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch (e) {
    // Only reachable with a valid signature, i.e. a bug on our side
    console.error('[oauth-state] signed payload is not JSON:', e.message, '| purpose:', purpose);
    return null;
  }
  if (!parsed || typeof parsed.ts !== 'number') return null;
  const age = now - parsed.ts;
  if (age < 0 || age > MAX_AGE_MS) return null;
  return parsed.d;
}

module.exports = { signUserState, verifyUserState, signPayload, verifyPayload, MAX_AGE_MS };
