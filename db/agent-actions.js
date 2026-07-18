'use strict';
/**
 * db/agent-actions.js — all SQL for the agent action ledger (Cowork Stage 1).
 * Owns: reads/writes to agent_actions. No raw SQL for this table lives elsewhere.
 * See docs/cowork-stage1-spec.md.
 */

/**
 * Insert an action row.
 * @returns {Promise<object>} the created row
 */
async function logAction(pool, {
  userId, actionType, status, riskTier,
  params = {}, result = null, undoToken = null, error = null, source = 'weightless',
}) {
  const executedAt = status === 'executed' ? 'NOW()' : 'NULL';
  const { rows } = await pool.query(
    `INSERT INTO agent_actions
       (user_id, action_type, status, risk_tier, params, result, undo_token, error, source, executed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, ${executedAt})
     RETURNING *`,
    [
      userId, actionType, status, riskTier,
      JSON.stringify(params),
      result == null ? null : JSON.stringify(result),
      undoToken == null ? null : JSON.stringify(undoToken),
      error, source,
    ]
  );
  return rows[0];
}

/** Fetch one action owned by the user (null if not found / not theirs). */
async function getAction(pool, id, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_actions WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

/**
 * Mark an executed action undone. Guarded so a double-undo is a no-op:
 * only flips a row that is currently 'executed'.
 * @returns {Promise<object|null>} the updated row, or null if it wasn't undoable
 */
async function markUndone(pool, id, userId) {
  const { rows } = await pool.query(
    `UPDATE agent_actions
        SET status = 'undone', undone_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'executed'
      RETURNING *`,
    [id, userId]
  );
  return rows[0] || null;
}

/** Mark a proposed/confirmed action executed (used by the confirm flow, Stage 1.4). */
async function markExecuted(pool, id, userId, result = null) {
  const { rows } = await pool.query(
    `UPDATE agent_actions
        SET status = 'executed', executed_at = NOW(), result = $3::jsonb
      WHERE id = $1 AND user_id = $2 AND status IN ('proposed','confirmed')
      RETURNING *`,
    [id, userId, result == null ? null : JSON.stringify(result)]
  );
  return rows[0] || null;
}

/** Count actions of a type in the trailing window (for rate limits). */
async function recentActionCount(pool, userId, actionType, sinceInterval = '1 day') {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM agent_actions
      WHERE user_id = $1 AND action_type = $2
        AND status = 'executed'
        AND created_at >= NOW() - $3::interval`,
    [userId, actionType, sinceInterval]
  );
  return rows[0].n;
}

module.exports = { logAction, getAction, markUndone, markExecuted, recentActionCount };
