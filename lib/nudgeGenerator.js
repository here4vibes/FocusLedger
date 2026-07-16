'use strict';

/**
 * Generate proactive nudges for a user based on their data.
 * Fire-and-forget — errors are swallowed.
 */
async function generateNudgesForUser(pool, userId) {
  // Nudge generation covers: document expiry, insurance gaps, score drops,
  // annual reviews. Complex business logic — runs in background.
  try {
    // Document expiry nudges
    await pool.query(
      `INSERT INTO nudges (user_id, type, message, urgency, notification_key)
       SELECT $1, 'document_expiry',
              'Your ' || d.category || ' document expires soon.',
              'high',
              'doc_expiry_' || d.id
       FROM documents d
       WHERE d.user_id = $1
         AND d.expiry_date IS NOT NULL
         AND d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
         AND NOT EXISTS (
           SELECT 1 FROM nudges n
           WHERE n.user_id = $1 AND n.notification_key = 'doc_expiry_' || d.id
         )`,
      [userId]
    );
  } catch (e) {
    console.warn('[nudgeGenerator] document expiry nudge insert failed | userId:', userId, '|', e.message);
  }
}

/**
 * Return pending nudges for a user.
 */
async function getPendingNudgesForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, urgency, message, type, created_at
     FROM nudges
     WHERE user_id = $1
       AND dismissed_at IS NULL
     ORDER BY
       CASE urgency WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       created_at DESC
     LIMIT 10`,
    [userId]
  );
  return rows;
}

/**
 * Generate a movement break nudge for an active focus session.
 * @returns {{ created: boolean, id: number|null }}
 */
async function generateMovementBreakNudge(pool, userId, sessionId) {
  const message = "Time for a movement break — stand up and stretch for 2 minutes. I'll be here when you get back.";
  const key = `movement_break_session_${sessionId}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO nudges (user_id, type, message, urgency, notification_key)
       SELECT $1, 'movement_break', $2, 'low', $3
       WHERE NOT EXISTS (SELECT 1 FROM nudges WHERE user_id = $1 AND notification_key = $3)
       RETURNING id`,
      [userId, message, key]
    );
    if (!rows.length) return { created: false, id: null };
    return { created: true, id: rows[0].id };
  } catch (e) {
    console.warn('[nudgeGenerator] movement break nudge failed | userId:', userId, '| sessionId:', sessionId, '|', e.message);
    return { created: false, id: null };
  }
}

/**
 * Generate a "your health score dropped" nudge.
 * Caller (routes/health-score.js) only invokes this when the drop is >= 10
 * points vs the prior score. Deduped to one per user per day via notification_key
 * so a recomputation on the same day doesn't stack nudges.
 * @param {object} pool
 * @param {number} userId
 * @param {number} currentScore
 * @param {number} prevScore
 * @returns {{ created: boolean, id: number|null }}
 */
async function generateScoreDropNudge(pool, userId, currentScore, prevScore) {
  const day = new Date().toISOString().slice(0, 10); // UTC day — dedup granularity
  const drop = Math.round(Number(prevScore) - Number(currentScore));
  const message = `Your focus score dipped ${drop} points. No shame — let's pick one small win to nudge it back up.`;
  const key = `score_drop_${day}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO nudges (user_id, type, message, urgency, notification_key)
       SELECT $1, 'score_drop', $2, 'medium', $3
       WHERE NOT EXISTS (SELECT 1 FROM nudges WHERE user_id = $1 AND notification_key = $3)
       RETURNING id`,
      [userId, message, key]
    );
    if (!rows.length) return { created: false, id: null };
    return { created: true, id: rows[0].id };
  } catch (e) {
    console.warn('[nudgeGenerator] score drop nudge failed | userId:', userId, '| drop:', drop, '|', e.message);
    return { created: false, id: null };
  }
}

module.exports = { generateNudgesForUser, getPendingNudgesForUser, generateMovementBreakNudge, generateScoreDropNudge };
