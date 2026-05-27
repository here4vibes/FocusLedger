'use strict';
/**
 * db/events.js — Named query functions for the events table.
 * Owns: events table reads/writes.
 * Does NOT own: event schema definition (migrations/1752860000000_shared_services_p1.js).
 */

const { queryWithRetry } = require('../lib/queryWithRetry');

/**
 * Insert a single event row.
 * @param {import('pg').Pool} pool
 * @param {object} params
 * @param {number} params.userId
 * @param {string} params.eventType  — e.g. 'transaction.classified', 'spending_session.complete', 'transactions.synced'
 * @param {object} params.payload   — JSON-serialisable object
 */
async function insertEvent(pool, { userId, eventType, payload }) {
  await queryWithRetry(pool,
    `INSERT INTO events (user_id, event_type, payload)
     VALUES ($1, $2, $3)`,
    [userId, eventType, JSON.stringify(payload)]
  );
}

/**
 * Fetch recent events for a user, optionally filtered by type.
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} [eventType]
 * @param {number} [limit=50]
 * @returns {Promise<Array>}
 */
async function getEventsForUser(pool, userId, eventType, limit = 50) {
  const query = eventType
    ? `SELECT * FROM events WHERE user_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT $3`
    : `SELECT * FROM events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`;
  const params = eventType ? [userId, eventType, limit] : [userId, limit];
  const result = await pool.query(query, params);
  return result.rows;
}

module.exports = { insertEvent, getEventsForUser };