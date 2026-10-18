'use strict';
/**
 * db/spendingSessions.js — Named query functions for the spending check-in.
 *
 * Tables owned: spending_sessions, events
 * Reads: plaid_transactions + expenses (the check-in queue and stats). Writes
 * to those go through db/money-prisma.js (confirmTransaction, triageExpense),
 * the same functions the money tab uses.
 *
 * Does NOT own: the legacy `transactions` / `transaction_classifications`
 * tables (db/transactions.js). The check-in no longer reads or writes them:
 * Plaid sync never fills `transactions`, and expenses.is_impulse is the record.
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
 * A session by id, only if it belongs to the user.
 * @param {object} pool
 * @param {number} sessionId
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getSessionById(pool, sessionId, userId) {
  const result = await pool.query(
    'SELECT * FROM spending_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Mark the user's session as complete.
 * @param {object} pool
 * @param {number} sessionId
 * @param {number} userId
 * @returns {Promise<boolean>} false when no such session for this user
 */
async function completeSession(pool, sessionId, userId) {
  const result = await pool.query(
    'UPDATE spending_sessions SET complete = true, updated_at = now() WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  return result.rowCount > 0;
}

// ── check-in queue (real bank transactions) ──────────────────────────────────
//
// The check-in reviews the same rows the money tab does. A bank charge waits in
// one of two places until the user says planned or impulse:
//   • plaid_transactions with is_confirmed = false (not yet written to expenses)
//   • expenses from Plaid with is_impulse IS NULL (confirmed, e.g. via the money
//     tab's "confirm all", but not yet classified)
// Queue = the user's own rows of either kind, posted (is_pending = false, same
// filter as the money tab), money out (amount > 0), dated on or after
// `sinceDate` (the caller passes the user's local today minus 13 days).
// Item ids are 'pt:<plaid_transactions.id>' or 'exp:<expenses.id>'.
// Amounts come back in integer cents, computed in SQL from NUMERIC.

const QUEUE_LIMIT = 50;

/**
 * Untriaged bank charges for the spending check-in.
 * @param {object} pool
 * @param {number} userId
 * @param {string} sinceDate  - YYYY-MM-DD (inclusive)
 * @returns {Promise<object[]>} { id, merchant_name, amount (cents), category, category_icon, date }
 */
async function getCheckinQueue(pool, userId, sinceDate) {
  const result = await pool.query(
    `SELECT * FROM (
       SELECT 'pt:' || pt.id AS id,
              COALESCE(NULLIF(pt.merchant_name, ''), pt.description, 'Unknown merchant') AS merchant_name,
              ROUND(pt.amount * 100)::int AS amount,
              c.name AS category,
              c.icon AS category_icon,
              to_char(pt.transaction_date, 'YYYY-MM-DD') AS date
         FROM plaid_transactions pt
         LEFT JOIN categories c ON c.id = pt.category_id
        WHERE pt.user_id = $1
          AND pt.is_confirmed = false
          AND pt.is_pending = false
          AND pt.amount > 0
          AND pt.transaction_date >= $2::date
       UNION ALL
       SELECT 'exp:' || e.id,
              COALESCE(NULLIF(e.description, ''), 'Unknown merchant'),
              ROUND(e.amount * 100)::int,
              c.name,
              c.icon,
              to_char(e.expense_date, 'YYYY-MM-DD')
         FROM expenses e
         LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.user_id = $1
          AND e.source = 'plaid'
          AND e.is_impulse IS NULL
          AND e.amount > 0
          AND e.expense_date >= $2::date
     ) q
     ORDER BY q.date DESC, q.amount DESC
     LIMIT ${QUEUE_LIMIT}`,
    [userId, sinceDate]
  );
  return result.rows;
}

/**
 * Whether a check-in item may be classified: the user's own posted bank charge
 * (money out). Mirrors getCheckinQueue's filters minus the date window, so an
 * older answer can still be changed.
 * @param {object} db  - pool or client
 * @param {'pt'|'exp'} kind
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function isCheckinEligible(db, kind, id, userId) {
  const sql = kind === 'pt'
    ? `SELECT 1 FROM plaid_transactions
        WHERE id = $1 AND user_id = $2 AND is_pending = false AND amount > 0`
    : `SELECT 1 FROM expenses
        WHERE id = $1 AND user_id = $2 AND source = 'plaid' AND amount > 0`;
  const result = await db.query(sql, [id, userId]);
  return result.rows.length > 0;
}

/**
 * The expense a confirmed plaid_transaction was written to (for a re-swipe).
 * @param {object} db  - pool or client
 * @param {number} plaidTxId
 * @param {number} userId
 * @returns {Promise<number|null>} expense id, or null when not found / dismissed
 */
async function getConfirmedExpenseId(db, plaidTxId, userId) {
  const result = await db.query(
    `SELECT pt.expense_id
       FROM plaid_transactions pt
       JOIN expenses e ON e.id = pt.expense_id AND e.user_id = pt.user_id
      WHERE pt.id = $1 AND pt.user_id = $2 AND pt.is_confirmed = true`,
    [plaidTxId, userId]
  );
  return result.rows[0] ? result.rows[0].expense_id : null;
}

/**
 * Planned / impulse counts recorded in one check-in session (from the
 * 'transaction.classified' events the check-in writes; a re-swipe counts once,
 * with its latest answer).
 * @param {object} pool
 * @param {number} userId
 * @param {string|number} sessionId
 * @returns {Promise<{impulse_count:number, planned_count:number, total_spend_cents:number}>}
 */
async function getSessionCounts(pool, userId, sessionId) {
  const result = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (payload->>'expense_id')
              (payload->>'expense_id')::int AS expense_id,
              payload->>'classification'    AS classification
         FROM events
        WHERE user_id = $1
          AND event_type = 'transaction.classified'
          AND payload->>'source' = 'spending_checkin'
          AND payload->>'session_id' = $2::text
        ORDER BY payload->>'expense_id', created_at DESC
     )
     SELECT COUNT(*) FILTER (WHERE l.classification = 'impulse')::int AS impulse_count,
            COUNT(*) FILTER (WHERE l.classification = 'planned')::int AS planned_count,
            COALESCE(ROUND(SUM(e.amount) * 100), 0)::bigint::text     AS total_spend_cents
       FROM latest l
       LEFT JOIN expenses e ON e.id = l.expense_id AND e.user_id = $1`,
    [userId, String(sessionId)]
  );
  const r = result.rows[0];
  return {
    impulse_count: r.impulse_count,
    planned_count: r.planned_count,
    total_spend_cents: Number(r.total_spend_cents),
  };
}

// ── stats (expenses.is_impulse is the record) ────────────────────────────────

/**
 * Planned / impulse stats over classified expenses dated within a range.
 * @param {object} pool
 * @param {number} userId
 * @param {string} from  - YYYY-MM-DD
 * @param {string} to    - YYYY-MM-DD
 * @returns {Promise<object>}
 */
async function getClassificationStats(pool, userId, from, to) {
  const [summary, byCategory] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int                                            AS total_classified,
              COUNT(*) FILTER (WHERE e.is_impulse = true)::int         AS impulse_count,
              COUNT(*) FILTER (WHERE e.is_impulse = false)::int        AS planned_count,
              COALESCE(ROUND(SUM(e.amount) FILTER (WHERE e.is_impulse = true)  * 100), 0)::bigint::text AS impulse_spend_cents,
              COALESCE(ROUND(SUM(e.amount) FILTER (WHERE e.is_impulse = false) * 100), 0)::bigint::text AS planned_spend_cents
         FROM expenses e
        WHERE e.user_id = $1 AND e.is_impulse IS NOT NULL
          AND e.expense_date BETWEEN $2::date AND $3::date`,
      [userId, from, to]
    ),
    pool.query(
      `SELECT c.name                                                AS category,
              COUNT(*)::int                                         AS count,
              COALESCE(ROUND(SUM(e.amount) * 100), 0)::bigint::text AS total_cents,
              COUNT(*) FILTER (WHERE e.is_impulse = true)::int      AS impulse_count
         FROM expenses e
         LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.user_id = $1 AND e.is_impulse IS NOT NULL
          AND e.expense_date BETWEEN $2::date AND $3::date
        GROUP BY c.name
        ORDER BY SUM(e.amount) DESC`,
      [userId, from, to]
    ),
  ]);

  const s = summary.rows[0];
  return {
    total_classified: s.total_classified,
    impulse_count: s.impulse_count,
    planned_count: s.planned_count,
    impulse_pct: s.total_classified > 0 ? Math.round((s.impulse_count / s.total_classified) * 100) : 0,
    impulse_spend_cents: Number(s.impulse_spend_cents),
    planned_spend_cents: Number(s.planned_spend_cents),
    by_category: byCategory.rows.map(r => ({
      category: r.category || 'Other',
      count: r.count,
      total_cents: Number(r.total_cents),
      impulse_count: r.impulse_count,
    })),
  };
}

/**
 * Categories the user marked impulse at least twice in the last 7 days.
 * @param {object} pool
 * @param {number} userId
 * @param {string} sinceDate  - YYYY-MM-DD (user's local today minus 6 days)
 * @param {number} [limit=3]
 * @returns {Promise<object[]>}
 */
async function getRecentInsights(pool, userId, sinceDate, limit = 3) {
  const result = await pool.query(
    `SELECT c.name AS category,
            COUNT(*) FILTER (WHERE e.is_impulse = true)::int AS impulse_count,
            COUNT(*)::int AS total,
            ROUND(COUNT(*) FILTER (WHERE e.is_impulse = true)::numeric / NULLIF(COUNT(*), 0) * 100)::int AS impulse_pct
       FROM expenses e
       LEFT JOIN categories c ON c.id = e.category_id
      WHERE e.user_id = $1 AND e.is_impulse IS NOT NULL
        AND e.expense_date >= $2::date
      GROUP BY c.name
     HAVING COUNT(*) FILTER (WHERE e.is_impulse = true) >= 2
      ORDER BY impulse_pct DESC, impulse_count DESC
      LIMIT $3`,
    [userId, sinceDate, limit]
  );

  return result.rows.map(r => ({
    type: 'impulse_category',
    category: r.category || 'Other',
    impulse_count: r.impulse_count,
    total: r.total,
    impulse_pct: r.impulse_pct || 0,
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
  getSessionById,
  completeSession,
  // check-in queue
  getCheckinQueue,
  isCheckinEligible,
  getConfirmedExpenseId,
  getSessionCounts,
  // stats
  getClassificationStats,
  getRecentInsights,
  // events
  insertEvent,
};