'use strict';
/**
 * Signed, single-purpose tokens for push-notification action buttons.
 *
 * A "Done ✓" button runs in the service worker, which can't read the app's
 * localStorage token and may not have a session cookie. So the push payload
 * carries a token that can only do one thing (complete one task for one user)
 * and expires. It's HMAC-signed with JWT_SECRET, which the web service and the
 * cron jobs share through the focusledger env group. A process without
 * JWT_SECRET can't sign, so it just sends the notification without the button.
 */
const crypto = require('crypto');

const TTL_SECONDS = 72 * 60 * 60;

function secret() {
  return process.env.JWT_SECRET || null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(body, key) {
  return crypto.createHmac('sha256', key).update(body).digest('base64url');
}

/**
 * @returns {string|null} token, or null when this process can't sign
 */
function createTaskDoneToken(userId, taskId, nowMs = Date.now()) {
  const key = secret();
  if (!key) return null;
  const body = b64url(JSON.stringify({ a: 'task_done', u: Number(userId), t: Number(taskId), exp: Math.floor(nowMs / 1000) + TTL_SECONDS }));
  return body + '.' + sign(body, key);
}

/**
 * @returns {{ userId: number, taskId: number }|null}
 */
function verifyTaskDoneToken(token, nowMs = Date.now()) {
  const key = secret();
  if (!key || typeof token !== 'string' || token.length > 512) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    console.error('[push-action] token body unreadable:', e.message);
    return null;
  }
  if (claims.a !== 'task_done' || !Number.isInteger(claims.u) || !Number.isInteger(claims.t)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < nowMs) return null;
  return { userId: claims.u, taskId: claims.t };
}

/**
 * The action buttons for a notification about exactly one task: "Done ✓"
 * (completed from the notification) plus one opener. Without a signing key it
 * falls back to the opener alone.
 */
function singleTaskActions(userId, taskId, opener) {
  const token = createTaskDoneToken(userId, taskId);
  const actions = [];
  const actionUrls = {};
  const actionTokens = {};
  if (token) {
    actions.push({ action: 'done', title: 'Done ✓' });
    actionTokens.done = token;
  }
  actions.push({ action: opener.action, title: opener.title });
  actionUrls[opener.action] = opener.url;
  return { actions, actionUrls, actionTokens };
}

module.exports = { createTaskDoneToken, verifyTaskDoneToken, singleTaskActions, TTL_SECONDS };
