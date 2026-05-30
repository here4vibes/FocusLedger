/**
 * db/impulseNudges.js — Named query functions for impulse spending pattern detection.
 *
 * Tables owned: expenses, impulse_spending_alerts
 *
 * Does NOT own: general expense CRUD (db/expenses.js), nudge delivery (lib/impulseNudgeEngine.js)
 */
'use strict';

/**
 * Get weekly spending stats including impulse breakdown.
 * @param {object} pool
 * @param {number} userId
 * @param {string} localDate — YYYY-MM-DD in user's timezone
 * @returns {Promise<object>}
 */
async function getWeeklySpendingStats(pool, userId, localDate) {
  const ref = localDate || new Date().toISOString().split('T')[0];
  const [y, m, d] = ref.split('-');
  const dateObj = new Date(ref + 'T12:00:00Z');
  const dayOfWeek = dateObj.getUTCDay(); // 0=Sun
  const diff = dateObj.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const monday = new Date(dateObj);
  monday.setUTCDate(diff);
  const weekStart = monday.toISOString().split('T')[0];
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const weekEnd = sunday.toISOString().split('T')[0];

  const [row] = await pool.query(`
    SELECT
      COALESCE(SUM(amount), 0)                                                  AS total_spent,
      COALESCE(SUM(amount) FILTER (WHERE is_impulse = true), 0)                 AS impulse_total,
      COALESCE(SUM(amount) FILTER (WHERE is_impulse = false), 0)                AS planned_total,
      COALESCE(SUM(amount) FILTER (WHERE is_impulse IS NULL), 0)                 AS untriaged_total,
      COUNT(*)                                                                   AS total_count,
      COUNT(*) FILTER (WHERE is_impulse = true)                                  AS impulse_count,
      COUNT(*) FILTER (WHERE is_impulse IS NULL AND source = 'plaid')           AS untriaged_count
    FROM expenses
    WHERE user_id = $1 AND expense_date >= $2 AND expense_date <= $3
  `, [userId, weekStart, weekEnd]);

  return {
    total_spent:     parseFloat(row.total_spent),
    impulse_total:   parseFloat(row.impulse_total),
    planned_total:   parseFloat(row.planned_total),
    untriaged_total: parseFloat(row.untriaged_total),
    total_count:     parseInt(row.total_count),
    impulse_count:   parseInt(row.impulse_count),
    untriaged_count: parseInt(row.untriaged_count),
    week_start:      weekStart,
    week_end:        weekEnd,
  };
}

/**
 * Get recent impulse expenses (last 7 days).
 * @param {object} pool
 * @param {number} userId
 * @param {string} localDate — YYYY-MM-DD in user's timezone
 * @returns {Promise<object[]>}
 */
async function getRecentImpulseExpenses(pool, userId, localDate) {
  const ref = localDate || new Date().toISOString().split('T')[0];
  const result = await pool.query(`
    SELECT id, amount, description, category_id, expense_date, note
    FROM expenses
    WHERE user_id = $1
      AND is_impulse = true
      AND expense_date >= $2::date - INTERVAL '7 days'
    ORDER BY expense_date DESC
    LIMIT 20
  `, [userId, ref]);
  return result.rows;
}

/**
 * Get or create an impulse spending alert for a user+date.
 * @param {object} pool
 * @param {number} userId
 * @param {string} alertType — 'high_weekly_spend' | 'rising_impulse_rate' | 'large_single_purchase'
 * @param {string} localDate — YYYY-MM-DD in user's timezone
 * @param {string} message — pre-built nudge message
 * @returns {Promise<object>}
 */
async function upsertImpulseAlert(pool, userId, alertType, localDate, message) {
  const result = await pool.query(`
    INSERT INTO impulse_spending_alerts (user_id, alert_type, local_date, message, is_dismissed)
    VALUES ($1, $2, $3, $4, false)
    ON CONFLICT (user_id, alert_type, local_date)
      WHERE is_dismissed = false
    DO UPDATE SET message = $4, updated_at = NOW()
    RETURNING *
  `, [userId, alertType, localDate, message]);
  return result.rows[0];
}

/**
 * Get active (undismissed) impulse alerts for a user.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
async function getActiveAlerts(pool, userId) {
  const result = await pool.query(`
    SELECT id, alert_type, message, created_at
    FROM impulse_spending_alerts
    WHERE user_id = $1
      AND is_dismissed = false
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT 5
  `, [userId]);
  return result.rows;
}

/**
 * Dismiss an impulse alert.
 * @param {object} pool
 * @param {number} alertId
 * @param {number} userId
 * @returns {Promise<void>}
 */
async function dismissAlert(pool, alertId, userId) {
  await pool.query(
    'UPDATE impulse_spending_alerts SET is_dismissed = true, updated_at = NOW() WHERE id = $1 AND user_id = $2',
    [alertId, userId]
  );
}

/**
 * Get spending velocity: average daily spend over last 4 weeks for trend comparison.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<number>} — average daily spend
 */
async function getSpendingVelocity(pool, userId) {
  const result = await pool.query(`
    SELECT
      COUNT(DISTINCT expense_date) AS active_days,
      COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE user_id = $1
      AND expense_date >= CURRENT_DATE - INTERVAL '28 days'
  `, [userId]);
  const row = result.rows[0];
  const activeDays = parseInt(row.active_days) || 1;
  return parseFloat(row.total) / activeDays;
}

module.exports = {
  getWeeklySpendingStats,
  getRecentImpulseExpenses,
  upsertImpulseAlert,
  getActiveAlerts,
  dismissAlert,
  getSpendingVelocity,
};