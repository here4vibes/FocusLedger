'use strict';
/**
 * lib/queryWithRetry.js
 * Wraps pool.query with simple exponential-backoff retries on transient connection errors.
 * WHY: Neon serverless Postgres can drop idle connections; a single retry avoids surfacing
 * those as 500s when the first query in a wake cycle fails.
 */

const RETRIABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']);

async function queryWithRetry(pool, sql, params, { maxRetries = 3, baseDelayMs = 200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      const isRetriable =
        RETRIABLE_CODES.has(err.code) ||
        (err.message || '').includes('Connection terminated') ||
        (err.message || '').includes('connect ECONNREFUSED');
      if (!isRetriable) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

module.exports = { queryWithRetry };
