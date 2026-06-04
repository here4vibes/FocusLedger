'use strict';
/**
 * services/SessionService.js — Spending session management.
 *
 * Owns: marking spending sessions as complete.
 * Does NOT own: transaction classification (routes/expenses.js),
 *               transaction sync (plaidDailySync.js, routes/plaid.js).
 *
 * Emits:
 *   - spending_session.complete — when a user marks their daily session complete
 */

const { insertEvent } = require('../db/events');

/**
 * Mark a user's spending session as complete for today (in their local timezone).
 * Creates a new spending_sessions row if none exists, or updates an existing one.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} timezone — IANA timezone string (e.g. 'America/New_York')
 * @returns {Promise<{ id: string, complete: boolean, transaction_count: number }>}
 */
async function completeSession(pool, userId, timezone) {
  const { getUserLocalDate } = require('../lib/timezone');
  const localDate = getUserLocalDate(timezone || 'America/New_York', new Date());

  // Upsert spending_sessions row — create if not exists, update complete=true if not already
  const result = await pool.query(
    `INSERT INTO spending_sessions (user_id, session_date, transaction_count, complete)
     VALUES ($1, $2::date, 0, true)
     ON CONFLICT (user_id, session_date)
     DO UPDATE SET complete = true, created_at = spending_sessions.created_at
     RETURNING id, complete, transaction_count`,
    [userId, localDate]
  );

  const session = result.rows[0];

  // Emit event
  insertEvent(pool, {
    userId,
    eventType: 'spending_session.complete',
    payload: { session_id: session.id, session_date: localDate, transaction_count: session.transaction_count || 0 }
  }).catch(e => console.warn('[SessionService] Event log error:', e.message));

  return session;
}

module.exports = { completeSession };