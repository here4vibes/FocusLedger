'use strict';
/**
 * logFailure: a .catch() handler that logs instead of swallowing.
 *
 * Replaces `.catch(() => {})` on best-effort work (fire-and-forget pushes,
 * attribution writes, cleanup). The work stays non-blocking, but a failure is
 * now a `[Module] op failed:` line in Render logs and, via lib/sentry.js, a
 * Sentry issue.
 *
 *   seedStarterRoutine(pool, user.id).catch(logFailure('[Auth]', 'seedStarterRoutine', { userId: user.id }));
 *   const isPro = await checkProStatus(pool, userId).catch(logFailure('[Tasks]', 'checkProStatus', { userId }, false));
 *
 * @param {string} prefix   module log prefix, e.g. '[Auth]'
 * @param {string} op       what failed, e.g. 'seedStarterRoutine'
 * @param {object} [context] identifying values (ids, keys); never secrets or emails
 * @param {*} [fallback]    value the caller gets instead of the rejection
 */
function logFailure(prefix, op, context = {}, fallback) {
  return (err) => {
    const parts = [];
    for (const [k, v] of Object.entries(context || {})) parts.push(`| ${k}:`, v);
    console.error(`${prefix} ${op} failed:`, err && err.message ? err.message : err, ...parts);
    return fallback;
  };
}

module.exports = { logFailure };
