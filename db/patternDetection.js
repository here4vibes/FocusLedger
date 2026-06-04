// Owns: detected_patterns, routine_suggestions tables.
// Does NOT own: tasks table, routines table, buddy conversations, or push delivery.
//
// Pattern detection is the passive "behind the scenes" layer — it observes task
// completion history and surfaces suggestions in Buddy. It does NOT auto-create
// routines; users opt in.

'use strict';

// ── Detected Patterns ─────────────────────────────────────────────────────────

/**
 * Insert or update a detected pattern for a user.
 * Upserts on (user_id, pattern_type, task_hash) to avoid duplicates.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {{
 *   patternType: string,
 *   patternData: object,
 *   occurrenceCount: number,
 *   totalOpportunities: number,
 *   timeConsistencyScore: number,
 *   confidenceScore: number
 * }} pattern
 */
async function upsertDetectedPattern(pool, userId, pattern) {
  const { patternType, patternData, occurrenceCount, totalOpportunities, timeConsistencyScore, confidenceScore } = pattern;

  // Derive a stable hash from the pattern's task IDs to detect duplicates
  const taskIds = patternData.task_ids || [];
  const taskHash = taskIds.slice().sort((a, b) => a - b).join(',');

  const result = await pool.query(
    `INSERT INTO detected_patterns
       (user_id, pattern_type, pattern_data, occurrence_count, total_opportunities,
        time_consistency_score, confidence_score, last_detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [userId, patternType, JSON.stringify(patternData), occurrenceCount, totalOpportunities, timeConsistencyScore, confidenceScore]
  );
  return result.rows[0] || null;
}

/**
 * Get all active patterns for a user, ordered by confidence desc.
 */
async function getActivePatterns(pool, userId) {
  const result = await pool.query(
    `SELECT * FROM detected_patterns
     WHERE user_id = $1 AND is_active = true
     ORDER BY confidence_score DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get patterns above a confidence threshold.
 * Used to surface suggestions when confidence >= 0.50.
 */
async function getPatternsAboveConfidence(pool, userId, minConfidence) {
  const result = await pool.query(
    `SELECT * FROM detected_patterns
     WHERE user_id = $1 AND is_active = true AND confidence_score >= $2
     ORDER BY confidence_score DESC`,
    [userId, minConfidence]
  );
  return result.rows;
}

/**
 * Increment occurrence count and update confidence for an existing pattern.
 * @param {import('pg').Pool} pool
 * @param {number} patternId
 * @param {number} newOccurrenceCount
 * @param {number} newTotalOpportunities
 * @param {number} newTimeConsistencyScore
 */
async function updatePatternStats(pool, patternId, newOccurrenceCount, newTotalOpportunities, newTimeConsistencyScore) {
  const confidence = newTotalOpportunities > 0
    ? (newOccurrenceCount / newTotalOpportunities) * newTimeConsistencyScore
    : 0;
  const result = await pool.query(
    `UPDATE detected_patterns
     SET occurrence_count = $1,
         total_opportunities = $2,
         time_consistency_score = $3,
         confidence_score = $4,
         last_detected_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [newOccurrenceCount, newTotalOpportunities, newTimeConsistencyScore, confidence, patternId]
  );
  return result.rows[0] || null;
}

/**
 * Deactivate a pattern (e.g., when user dismisses and asks not to be asked again).
 */
async function deactivatePattern(pool, userId, patternId) {
  await pool.query(
    `UPDATE detected_patterns SET is_active = false WHERE id = $1 AND user_id = $2`,
    [patternId, userId]
  );
}

/**
 * Get a specific pattern by ID (for a given user).
 */
async function getPatternById(pool, userId, patternId) {
  const result = await pool.query(
    `SELECT * FROM detected_patterns WHERE id = $1 AND user_id = $2`,
    [patternId, userId]
  );
  return result.rows[0] || null;
}

// ── Routine Suggestions ───────────────────────────────────────────────────────

/**
 * Create a new routine suggestion from a detected pattern.
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {number} patternId
 */
async function createRoutineSuggestion(pool, userId, patternId) {
  // Don't create duplicate pending suggestions for the same pattern
  const existing = await pool.query(
    `SELECT id FROM routine_suggestions WHERE user_id = $1 AND pattern_id = $2 AND status = 'pending'`,
    [userId, patternId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO routine_suggestions (user_id, pattern_id, presented_at)
     VALUES ($1, $2, NOW())
     RETURNING *`,
    [userId, patternId]
  );
  return result.rows[0];
}

/**
 * Get the pending suggestion for a user (max 1 per session).
 * Returns the suggestion enriched with pattern details.
 */
async function getPendingSuggestion(pool, userId) {
  const result = await pool.query(
    `SELECT rs.*, dp.pattern_type, dp.pattern_data, dp.confidence_score,
            dp.occurrence_count, dp.total_opportunities
     FROM routine_suggestions rs
     JOIN detected_patterns dp ON dp.id = rs.pattern_id
     WHERE rs.user_id = $1 AND rs.status = 'pending'
     ORDER BY rs.created_at ASC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Increment the presented_count for a suggestion.
 * Called each time it's shown in a Buddy session.
 */
async function incrementPresentedCount(pool, userId, suggestionId) {
  const result = await pool.query(
    `UPDATE routine_suggestions
     SET presented_count = presented_count + 1
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [suggestionId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Accept a routine suggestion: mark accepted and record the created routine ID.
 */
async function acceptSuggestion(pool, userId, suggestionId, routineId) {
  const result = await pool.query(
    `UPDATE routine_suggestions
     SET status = 'accepted', responded_at = NOW(), created_routine_id = $3
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [suggestionId, userId, routineId]
  );
  return result.rows[0] || null;
}

/**
 * Dismiss a routine suggestion.
 * Optionally deactivate the underlying pattern so it's never asked again.
 */
async function dismissSuggestion(pool, userId, suggestionId, deactivatePattern_ = false) {
  await pool.query(
    `UPDATE routine_suggestions
     SET status = 'dismissed', responded_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [suggestionId, userId]
  );
  if (deactivatePattern_) {
    await pool.query(
      `UPDATE detected_patterns SET is_active = false
       WHERE id = (SELECT pattern_id FROM routine_suggestions WHERE id = $1)`,
      [suggestionId]
    );
  }
}

/**
 * Expire old suggestions that have been ignored for 3+ sessions.
 * Called at the start of pattern detection to clean up stale suggestions.
 */
async function expireIgnoredSuggestions(pool, userId) {
  const result = await pool.query(
    `UPDATE routine_suggestions
     SET status = 'dismissed', responded_at = NOW()
     WHERE user_id = $1
       AND status = 'pending'
       AND presented_count >= 3
     RETURNING id`,
    [userId]
  );
  return result.rows;
}

/**
 * Get all pending suggestions for a user.
 */
async function getAllPendingSuggestions(pool, userId) {
  const result = await pool.query(
    `SELECT rs.*, dp.pattern_type, dp.pattern_data, dp.confidence_score,
            dp.occurrence_count, dp.total_opportunities
     FROM routine_suggestions rs
     JOIN detected_patterns dp ON dp.id = rs.pattern_id
     WHERE rs.user_id = $1 AND rs.status = 'pending'
     ORDER BY rs.presented_count ASC, rs.created_at ASC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get suggestion by ID for a given user.
 */
async function getSuggestionById(pool, userId, suggestionId) {
  const result = await pool.query(
    `SELECT rs.*, dp.pattern_type, dp.pattern_data, dp.confidence_score
     FROM routine_suggestions rs
     JOIN detected_patterns dp ON dp.id = rs.pattern_id
     WHERE rs.id = $1 AND rs.user_id = $2`,
    [suggestionId, userId]
  );
  return result.rows[0] || null;
}

module.exports = {
  upsertDetectedPattern,
  getActivePatterns,
  getPatternsAboveConfidence,
  updatePatternStats,
  deactivatePattern,
  getPatternById,
  createRoutineSuggestion,
  getPendingSuggestion,
  incrementPresentedCount,
  acceptSuggestion,
  dismissSuggestion,
  expireIgnoredSuggestions,
  getAllPendingSuggestions,
  getSuggestionById,
};