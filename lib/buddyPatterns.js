'use strict';

/**
 * Return active behavior patterns for a user from buddy_patterns table.
 */
async function runPatternDetection(pool, userId, _tz) {
  const { rows } = await pool.query(
    `SELECT id, pattern_type, confidence_score, occurrence_count, metadata, surfaced_at, dismissed_at
     FROM buddy_patterns
     WHERE user_id = $1 AND dismissed_at IS NULL
     ORDER BY confidence_score DESC
     LIMIT 10`,
    [userId]
  );
  return rows;
}

/**
 * Determine if a mid-day check-in prompt is appropriate right now.
 * Returns a checkin type string or null.
 */
function getMidDayCheckinType(localHour, planAcceptedAt, localAcceptedHour) {
  // post_plan: within 2 hours of accepting the daily plan, morning only
  if (planAcceptedAt && localAcceptedHour !== undefined && localHour >= 9 && localHour < 12) {
    const hoursSinceAccept = localHour - localAcceptedHour;
    if (hoursSinceAccept >= 1 && hoursSinceAccept <= 3) return 'post_plan';
  }
  // afternoon_energy: 1pm–4pm
  if (localHour >= 13 && localHour < 16) return 'afternoon_energy';
  // pre_evening: 5pm–8pm
  if (localHour >= 17 && localHour < 20) return 'pre_evening';
  return null;
}

/**
 * Build contextual greeting insights for the session-status response.
 * Returns an array of insight strings.
 */
async function buildGreetingContext(pool, userId, sessionCount, _tz) {
  const insights = [];
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM tasks
       WHERE user_id = $1 AND is_completed = true AND completed_at >= NOW() - INTERVAL '7 days'`,
      [userId]
    );
    const cnt = parseInt(rows[0]?.cnt, 10) || 0;
    if (cnt > 0) insights.push(`You completed ${cnt} task${cnt !== 1 ? 's' : ''} this week — nice work.`);
  } catch {}
  if (sessionCount === 1) insights.push('Welcome back to FocusLedger!');
  return insights;
}

module.exports = { runPatternDetection, getMidDayCheckinType, buildGreetingContext };
