'use strict';
/**
 * db/spendingSessions.js — Named query functions for spending_sessions,
 *                          transaction_classifications, and events tables.
 *
 * Tables owned: spending_sessions, transaction_classifications, events
 *
 * Does NOT own: transactions (see db/transactions.js)
 */

// ── spending_sessions ────────────────────────────────────────────────────────

/**
 * Get or create a spending session for a user on a given date.
 * @param {object} pool
 * @param {number} userId
 * @param {string} date  - YYYY-MM-DD
 * @param {number} transactionCount
 * @returns {Promise<object>} session row
 */
async function upsertSession(pool, userId, date, transactionCount) {
  const result = await pool.query(
    `INSERT INTO spending_sessions (user_id, session_date, transaction_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, session_date) DO UPDATE
       SET transaction_count = EXCLUDED.transaction_count,
           updated_at = now()
     RETURNING *`,
    [userId, date, transactionCount]
  );
  return result.rows[0];
}

/**
 * Get the current session for a user on a given date.
 * @param {object} pool
 * @param {number} userId
 * @param {string} date  - YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
async function getSession(pool, userId, date) {
  const result = await pool.query(
    'SELECT * FROM spending_sessions WHERE user_id = $1 AND session_date = $2',
    [userId, date]
  );
  return result.rows[0] || null;
}

/**
 * Mark a session as complete.
 * @param {object} pool
 * @param {string} sessionId  - UUID
 * @returns {Promise<void>}
 */
async function completeSession(pool, sessionId) {
  await pool.query(
    'UPDATE spending_sessions SET complete = true, updated_at = now() WHERE id = $1',
    [sessionId]
  );
}

// ── transaction_classifications ───────────────────────────────────────────────

/**
 * Upsert a transaction classification (update if exists, insert if new).
 * @param {object} pool
 * @param {object} params
 * @returns {Promise<object>} upserted row
 */
async function upsertClassification(pool, params) {
  const { sessionId, userId, transactionId, classification } = params;
  const result = await pool.query(
    `INSERT INTO transaction_classifications
       (session_id, user_id, transaction_id, classification)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (transaction_id, user_id) DO UPDATE
       SET classification = EXCLUDED.classification,
            session_id   = EXCLUDED.session_id,
            swiped_at    = now()
     RETURNING *`,
    [sessionId, userId, transactionId, classification]
  );
  return result.rows[0];
}

/**
 * Get all classifications for a session.
 * @param {object} pool
 * @param {string} sessionId  - UUID
 * @returns {Promise<object[]>}
 */
async function getClassificationsForSession(pool, sessionId) {
  const result = await pool.query(
    `SELECT tc.*, t.merchant_name, t.amount, t.category, t.category_icon
     FROM transaction_classifications tc
     JOIN transactions t ON t.id = tc.transaction_id
     WHERE tc.session_id = $1
     ORDER BY tc.swiped_at DESC`,
    [sessionId]
  );
  return result.rows;
}

// ── stats ────────────────────────────────────────────────────────────────────

/**
 * Get classification stats for a user within a date range.
 * @param {object} pool
 * @param {number} userId
 * @param {string} from  - YYYY-MM-DD
 * @param {string} to    - YYYY-MM-DD
 * @returns {Promise<object>}
 */
async function getClassificationStats(pool, userId, from, to) {
  const [summary, byCategory] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)                                             AS total_classified,
         COUNT(*) FILTER (WHERE tc.classification = 'impulse') AS impulse_count,
         COUNT(*) FILTER (WHERE tc.classification = 'planned') AS planned_count,
         COALESCE(SUM(t.amount) FILTER (WHERE tc.classification = 'impulse'), 0)   AS impulse_spend_cents,
         COALESCE(SUM(t.amount) FILTER (WHERE tc.classification = 'planned'), 0)   AS planned_spend_cents
       FROM transaction_classifications tc
       JOIN transactions t ON t.id = tc.transaction_id
       WHERE tc.user_id = $1
         AND tc.swiped_at >= $2::date
         AND tc.swiped_at < ($3::date + INTERVAL '1 day')`,
      [userId, from, to]
    ),
    pool.query(
      `SELECT
         t.category,
         COUNT(*) AS count,
         COALESCE(SUM(t.amount), 0) AS total_cents,
         COUNT(*) FILTER (WHERE tc.classification = 'impulse') AS impulse_count
       FROM transaction_classifications tc
       JOIN transactions t ON t.id = tc.transaction_id
       WHERE tc.user_id = $1
         AND tc.swiped_at >= $2::date
         AND tc.swiped_at < ($3::date + INTERVAL '1 day')
       GROUP BY t.category
       ORDER BY total_cents DESC`,
      [userId, from, to]
    ),
  ]);

  const s = summary.rows[0];
  const total = parseInt(s.total_classified, 10);
  const impulseCount = parseInt(s.impulse_count, 10);

  return {
    total_classified: total,
    impulse_count: impulseCount,
    planned_count: parseInt(s.planned_count, 10),
    impulse_pct: total > 0 ? Math.round((impulseCount / total) * 100) : 0,
    impulse_spend_cents: parseInt(s.impulse_spend_cents, 10),
    planned_spend_cents: parseInt(s.planned_spend_cents, 10),
    by_category: byCategory.rows.map(r => ({
      category: r.category || 'Other',
      count: parseInt(r.count, 10),
      total_cents: parseInt(r.total_cents, 10),
      impulse_count: parseInt(r.impulse_count, 10),
    })),
  };
}

// ── recent insights ──────────────────────────────────────────────────────────

/**
 * Return top N insights based on recent classification patterns.
 * @param {object} pool
 * @param {number} userId
 * @param {number} [limit=3]
 * @returns {Promise<object[]>}
 */
async function getRecentInsights(pool, userId, limit = 3) {
  // Insight: highest impulse categories this week
  const insightResult = await pool.query(
    `SELECT
       t.category,
       COUNT(*) FILTER (WHERE tc.classification = 'impulse') AS impulse_count,
       COUNT(*) AS total,
       ROUND(
         COUNT(*) FILTER (WHERE tc.classification = 'impulse')::numeric /
         NULLIF(COUNT(*), 0) * 100
       ) AS impulse_pct
     FROM transaction_classifications tc
     JOIN transactions t ON t.id = tc.transaction_id
     WHERE tc.user_id = $1
       AND tc.swiped_at >= now() - INTERVAL '7 days'
     GROUP BY t.category
     HAVING COUNT(*) FILTER (WHERE tc.classification = 'impulse') >= 2
     ORDER BY impulse_pct DESC, impulse_count DESC
     LIMIT $2`,
    [userId, limit]
  );

  return insightResult.rows.map(r => ({
    type: 'impulse_category',
    category: r.category || 'Other',
    impulse_count: parseInt(r.impulse_count, 10),
    total: parseInt(r.total, 10),
    impulse_pct: parseInt(r.impulse_pct, 10) || 0,
    message: `You classify ${r.category || 'Other'} as impulse ${r.impulse_pct}% of the time — that's ${r.impulse_count} times in the past week.`,
  }));
}

// ── events ───────────────────────────────────────────────────────────────────

/**
 * Insert an event into the events table.
 * @param {object} pool
 * @param {string} eventType  - e.g. 'transaction.classified'
 * @param {object} payload    - arbitrary JSON payload
 * @param {number} userId
 * @returns {Promise<object>} inserted row
 */
async function insertEvent(pool, eventType, payload, userId) {
  const result = await pool.query(
    `INSERT INTO events (user_id, event_type, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, eventType, JSON.stringify(payload)]
  );
  return result.rows[0];
}

module.exports = {
  // spending_sessions
  upsertSession,
  getSession,
  completeSession,
  // transaction_classifications
  upsertClassification,
  getClassificationsForSession,
  // stats
  getClassificationStats,
  getRecentInsights,
  // events
  insertEvent,
};