// Owns: comeback flow detection and tracking.
// Does NOT own: login/auth, buddy conversation logic, nudge scheduling.
const { queryWithRetry } = require('../lib/queryWithRetry');

/**
 * Get comeback eligibility for a user.
 * Returns { isComeback, missedDays, pendingTaskCount, canShow, daysSinceLapse }
 * where:
 *   - isComeback: user had 3+ consecutive missed check-ins (active lapse)
 *   - missedDays: how many days they've been away
 *   - pendingTaskCount: count of overdue or due-today tasks
 *   - canShow: hasn't seen the modal in the last 7 days
 *   - daysSinceLapse: how long the current lapse has been active
 */
async function getComebackStatus(pool, userId) {
  const [engResult, taskResult] = await Promise.all([
    pool.query(`
      SELECT
        consecutive_missed_checkins,
        lapse_started_at,
        last_comeback_shown_at,
        last_checkin_at
      FROM buddy_engagement
      WHERE user_id = $1
    `, [userId]),

    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE user_id = $1
        AND is_done = false
        AND (
          (due_date IS NOT NULL AND due_date <= CURRENT_DATE + 1)
          OR due_date IS NULL
        )
    `, [userId]),
  ]);

  const eng = engResult.rows[0] || {};
  const pendingCount = (taskResult.rows[0] || {}).count || 0;

  const missedDays = eng.consecutive_missed_checkins || 0;
  const lapseStarted = eng.lapse_started_at ? new Date(eng.lapse_started_at) : null;

  // Active lapse = 3+ consecutive missed check-ins
  const isLapsed = missedDays >= 3;
  const daysSinceLapse = lapseStarted
    ? Math.floor((Date.now() - lapseStarted.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Only show once per 7 days
  const lastShown = eng.last_comeback_shown_at ? new Date(eng.last_comeback_shown_at) : null;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const canShow = !lastShown || (Date.now() - lastShown.getTime()) > SEVEN_DAYS_MS;

  return {
    isComeback: isLapsed && canShow,
    missedDays,
    pendingTaskCount: pendingCount,
    canShow,
    daysSinceLapse: Math.max(missedDays, daysSinceLapse),
  };
}

/**
 * Record that the comeback flow was shown to a user now.
 */
async function markComebackShown(pool, userId) {
  await pool.query(`
    INSERT INTO buddy_engagement (user_id, last_comeback_shown_at, updated_at)
    VALUES ($1, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      last_comeback_shown_at = NOW(),
      updated_at = NOW()
  `, [userId]);
}

module.exports = { getComebackStatus, markComebackShown };