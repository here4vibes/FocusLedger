'use strict';
/**
 * Per-request context via AsyncLocalStorage, so code far from the route
 * (e.g. lib/claude-client.js) can tell which user a call is for without
 * threading `req` through every function. Holds the request (req.user is set
 * later by authenticateToken; it's read lazily) and the app's pool.
 * Outside a request (cron jobs, scripts) getContext() returns null.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function requestContext(pool) {
  return (req, res, next) => als.run({ pool, req }, next);
}

function getContext() {
  return als.getStore() || null;
}

/** For tests and scripts: run fn inside a synthetic context. */
function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

module.exports = { requestContext, getContext, runWithContext };
