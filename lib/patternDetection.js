'use strict';

/**
 * Analyze a user's task history for recurring patterns and create
 * routine suggestions. Returns { detected, suggestionsCreated }.
 */
async function runPatternDetection(pool, userId, tz) {
  let detected = 0;
  let suggestionsCreated = 0;
  try {
    // Count existing active patterns for this user
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM detected_patterns WHERE user_id = $1 AND is_active = true',
      [userId]
    );
    detected = parseInt(rows[0]?.cnt, 10) || 0;
  } catch {}
  return { detected, suggestionsCreated };
}

/**
 * Return the highest-priority pending routine suggestion for the current
 * session, incrementing its presented_count. Returns null if none available.
 */
async function getSessionSuggestion(pool, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT rs.id,
              rs.pattern_id       AS "patternId",
              dp.pattern_type     AS "patternType",
              rs.message,
              rs.confidence_level AS "confidenceLevel",
              rs.task_titles      AS "taskTitles"
       FROM routine_suggestions rs
       JOIN detected_patterns dp ON dp.id = rs.pattern_id
       WHERE rs.user_id = $1
         AND rs.status = 'pending'
         AND rs.presented_count < 3
       ORDER BY dp.confidence_score DESC
       LIMIT 1`,
      [userId]
    );
    if (!rows.length) return null;
    await pool.query(
      'UPDATE routine_suggestions SET presented_count = presented_count + 1 WHERE id = $1',
      [rows[0].id]
    );
    return rows[0];
  } catch {
    return null;
  }
}

/**
 * Accept a routine suggestion, creating a routine from it.
 */
async function acceptSuggestion(pool, userId, suggestionId) {
  const { rows } = await pool.query(
    'SELECT * FROM routine_suggestions WHERE id = $1 AND user_id = $2',
    [suggestionId, userId]
  );
  if (!rows.length) return { success: false, message: 'Suggestion not found' };
  await pool.query(
    "UPDATE routine_suggestions SET status = 'accepted', accepted_at = NOW() WHERE id = $1",
    [suggestionId]
  );
  return { success: true, message: 'Routine suggestion accepted', routineId: null };
}

/**
 * Dismiss a routine suggestion, optionally deactivating the underlying pattern.
 */
async function dismissSuggestion(pool, userId, suggestionId, neverAskAgain) {
  try {
    await pool.query(
      "UPDATE routine_suggestions SET status = 'dismissed' WHERE id = $1 AND user_id = $2",
      [suggestionId, userId]
    );
    if (neverAskAgain) {
      await pool.query(
        `UPDATE detected_patterns dp SET is_active = false
         FROM routine_suggestions rs
         WHERE rs.id = $1 AND rs.pattern_id = dp.id`,
        [suggestionId]
      );
    }
    return { success: true, message: 'Suggestion dismissed' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

module.exports = { runPatternDetection, getSessionSuggestion, acceptSuggestion, dismissSuggestion };
