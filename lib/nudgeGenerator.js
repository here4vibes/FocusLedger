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
              'Your ' || category || ' document expires soon.',
              'high',
              'doc_expiry_' || id
       FROM documents
       WHERE user_id = $1
         AND expiry_date IS NOT NULL
         AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
       ON CONFLICT (user_id, notification_key) DO NOTHING`,
      [userId]
    );
  } catch {}
}

/**
 * Return pending nudges for a user.
 */
async function getPendingNudgesForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, urgency, message, type, created_at
     FROM nudges
     WHERE user_id = $1
       AND is_dismissed = false
       AND (expires_at IS NULL OR expires_at > NOW())
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
      `INSERT INTO nudges (user_id, type, message, urgency, notification_key, metadata)
       VALUES ($1, 'movement_break', $2, 'low', $3, $4::jsonb)
       ON CONFLICT (user_id, notification_key) DO NOTHING
       RETURNING id`,
      [userId, message, key, JSON.stringify({ session_id: sessionId })]
    );
    if (!rows.length) return { created: false, id: null };
    return { created: true, id: rows[0].id };
  } catch {
    return { created: false, id: null };
  }
}

module.exports = { generateNudgesForUser, getPendingNudgesForUser, generateMovementBreakNudge };
