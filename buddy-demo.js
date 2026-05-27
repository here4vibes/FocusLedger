// Owns: named query functions for buddy_demo_sessions + buddy_demo_turns.
// Does NOT own: authentication, rate limiting, or AI calls.

const MAX_MESSAGES_PER_SESSION = 10;

// Create or retrieve an anonymous demo session by token.
async function getOrCreateSession(pool, sessionToken) {
  const existing = await pool.query(
    `SELECT * FROM buddy_demo_sessions WHERE session_token = $1`,
    [sessionToken]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO buddy_demo_sessions (session_token)
     VALUES ($1)
     RETURNING *`,
    [sessionToken]
  );
  return created.rows[0];
}

// Get a session by token (returns null if not found).
async function getSession(pool, sessionToken) {
  const result = await pool.query(
    `SELECT * FROM buddy_demo_sessions WHERE session_token = $1`,
    [sessionToken]
  );
  return result.rows[0] || null;
}

// Get all conversation turns for a session, ordered by turn number.
async function getTurns(pool, sessionId) {
  const result = await pool.query(
    `SELECT role, message FROM buddy_demo_turns
     WHERE session_id = $1
     ORDER BY turn ASC`,
    [sessionId]
  );
  return result.rows;
}

// Insert one turn (user or buddy) and increment message_count on user turns.
async function insertTurn(pool, sessionId, role, message, turnNumber) {
  await pool.query(
    `INSERT INTO buddy_demo_turns (session_id, turn, role, message)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, turnNumber, role, message]
  );

  // Only count user messages against the rate limit
  if (role === 'user') {
    await pool.query(
      `UPDATE buddy_demo_sessions
       SET message_count = message_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [sessionId]
    );
  }
}

// Persist extracted tasks + surfaced values back into the session.
async function updateSessionInsights(pool, sessionId, { extractedTasks, surfacedValues, detectedMood, conversationSummary, isComplete }) {
  await pool.query(
    `UPDATE buddy_demo_sessions
     SET extracted_tasks     = $2,
         surfaced_values     = $3,
         detected_mood       = COALESCE($4, detected_mood),
         conversation_summary= COALESCE($5, conversation_summary),
         is_complete         = $6,
         updated_at          = NOW()
     WHERE id = $1`,
    [
      sessionId,
      JSON.stringify(extractedTasks || []),
      JSON.stringify(surfacedValues || []),
      detectedMood || null,
      conversationSummary || null,
      isComplete || false
    ]
  );
}

// Return full session data for Part 2 (account hydration).
async function getSessionData(pool, sessionToken) {
  const session = await getSession(pool, sessionToken);
  if (!session) return null;

  const turns = await getTurns(pool, session.id);
  return { session, turns };
}

// Check if a session has hit the rate limit.
function isRateLimited(session) {
  return session.message_count >= MAX_MESSAGES_PER_SESSION;
}

// Mark a session as migrated to a real user account. Idempotent.
// claimed_user_id is set only on first call (COALESCE skips subsequent calls).
async function markSessionMigrated(pool, sessionToken, userId) {
  const result = await pool.query(
    `UPDATE buddy_demo_sessions
     SET claimed_user_id = COALESCE(claimed_user_id, $2),
         claimed_at      = COALESCE(claimed_at, NOW()),
         updated_at      = NOW()
     WHERE session_token = $1
     RETURNING id, claimed_user_id`,
    [sessionToken, userId]
  );
  return result.rows[0] || null;
}

// Check whether a session was already migrated (prevent double-import).
async function isSessionMigrated(pool, sessionToken) {
  const result = await pool.query(
    `SELECT claimed_user_id FROM buddy_demo_sessions WHERE session_token = $1`,
    [sessionToken]
  );
  if (!result.rows[0]) return false;
  return result.rows[0].claimed_user_id !== null;
}

// Purge anonymous demo sessions older than 7 days (GDPR-friendly cleanup).
// Called by the daily stash cleanup cron — safe to call on every startup.
async function purgeExpiredDemoSessions(pool) {
  const result = await pool.query(
    `DELETE FROM buddy_demo_sessions
     WHERE created_at < NOW() - INTERVAL '7 days'
       AND claimed_user_id IS NULL`
  );
  return result.rowCount || 0;
}

module.exports = {
  MAX_MESSAGES_PER_SESSION,
  getOrCreateSession,
  getSession,
  getTurns,
  insertTurn,
  updateSessionInsights,
  getSessionData,
  isRateLimited,
  markSessionMigrated,
  isSessionMigrated,
  purgeExpiredDemoSessions
};
