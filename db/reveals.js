'use strict';
/**
 * db/reveals.js — Named query functions for the daily_reveals table.
 *
 * Owns: daily_reveals
 * Does NOT own: cross_domain_insights, detected_patterns (see db/insights.js
 * and the pattern-detection job's own queries).
 */

/**
 * Stage (or replace) the reveal for a user + local date.
 * Safe to re-run — the nightly job may regenerate a better reveal.
 */
async function upsertReveal(pool, { userId, revealDate, headline, body, scienceTag, revealType }) {
  const { rows } = await pool.query(
    `INSERT INTO daily_reveals (user_id, reveal_date, headline, body, science_tag, reveal_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, reveal_date) DO UPDATE SET
       headline    = EXCLUDED.headline,
       body        = EXCLUDED.body,
       science_tag = EXCLUDED.science_tag,
       reveal_type = EXCLUDED.reveal_type
     RETURNING *`,
    [userId, revealDate, headline, body, scienceTag || null, revealType || 'insight']
  );
  return rows[0];
}

/**
 * Fetch the reveal for a user's local date (or null if none staged).
 */
async function getRevealForDate(pool, userId, localDate) {
  const { rows } = await pool.query(
    `SELECT id, reveal_date, headline, body, science_tag, reveal_type, viewed_at
     FROM daily_reveals
     WHERE user_id = $1 AND reveal_date = $2
     LIMIT 1`,
    [userId, localDate]
  );
  return rows[0] || null;
}

/**
 * Mark a reveal as viewed (first open only — keeps the original reveal moment).
 * Scoped to the owning user; returns null if not found.
 */
async function markRevealViewed(pool, userId, revealId) {
  const { rows } = await pool.query(
    `UPDATE daily_reveals
     SET viewed_at = COALESCE(viewed_at, NOW())
     WHERE id = $1 AND user_id = $2
     RETURNING id, viewed_at`,
    [revealId, userId]
  );
  return rows[0] || null;
}

/**
 * Fetch the still-sealed reveal for user + date (null if none or already viewed).
 * Used by the morning nudge to tease the headline — a viewed reveal has no
 * curiosity gap left to tease.
 */
async function getUnviewedRevealForDate(pool, userId, localDate) {
  const { rows } = await pool.query(
    `SELECT id, headline FROM daily_reveals
     WHERE user_id = $1 AND reveal_date = $2 AND viewed_at IS NULL
     LIMIT 1`,
    [userId, localDate]
  );
  return rows[0] || null;
}

/**
 * Whether a reveal already exists for user + date (job idempotency check).
 */
async function revealExists(pool, userId, revealDate) {
  const { rows } = await pool.query(
    'SELECT 1 FROM daily_reveals WHERE user_id = $1 AND reveal_date = $2 LIMIT 1',
    [userId, revealDate]
  );
  return rows.length > 0;
}

module.exports = {
  upsertReveal,
  getRevealForDate,
  getUnviewedRevealForDate,
  markRevealViewed,
  revealExists,
};
