'use strict';
/**
 * Signed OAuth `state` that ties a provider callback to the user who started
 * the flow. The callback has no session or JWT, so the state is the only proof
 * of who asked; an unsigned state lets anyone attach their own provider account
 * to another user by forging the id.
 *
 * The purpose is part of the signature, so a state minted for one flow can't be
 * replayed against another. States expire after 10 minutes.
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

/** @returns {number|null} the user id, or null if forged, expired or malformed */
function verifyUserState(purpose, state, now = Date.now()) {
  if (typeof state !== 'string' || !state) return null;
  const parts = Buffer.from(state, 'base64url').toString().split(':');
  if (parts.length !== 3) return null;
  const [userId, ts, sig] = parts;
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(ts)) return null;
  const age = now - Number(ts);
  if (age < 0 || age > MAX_AGE_MS) return null;
  const expected = Buffer.from(mac(purpose, userId, ts));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return Number(userId);
}

module.exports = { signUserState, verifyUserState, MAX_AGE_MS };
