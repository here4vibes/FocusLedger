'use strict';
/**
 * db/userNotificationPrefs.js — Named query functions for user_notification_prefs table.
 * Owns: user_notification_prefs table reads/writes (evening_enabled, evening_time).
 * Does NOT own: push_subscriptions (push_subscriptions table), notification_send_log.
 * Note: evening_enabled/evening_time from user_notification_prefs.
 *       Generic nudge prefs (push, email, banner) live in nudge_preferences table.
 */

const DEFAULT_PREFS = { evening_enabled: true, evening_time: '20:00' };

/**
 * Get notification preferences for a user.
 * Returns { evening_enabled, evening_time } with safe defaults if no row exists.
 * @param {import('pg').Pool} pool
 * @param {number} userId
 */
async function getPreferences(pool, userId) {
  const result = await pool.query(
    `SELECT evening_enabled, evening_time FROM user_notification_prefs WHERE user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    return { ...DEFAULT_PREFS };
  }
  return result.rows[0];
}

/**
 * Upsert notification preferences. Creates row if missing, updates if present.
 * Only updates fields that are explicitly provided (partial update).
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {{ evening_enabled?: boolean, evening_time?: string }} prefs
 */
async function upsertPreferences(pool, userId, prefs) {
  const updates = [];
  if (prefs.evening_enabled !== undefined) updates.push('evening_enabled = EXCLUDED.evening_enabled');
  if (prefs.evening_time !== undefined)    updates.push('evening_time = EXCLUDED.evening_time');
  if (updates.length === 0) return; // nothing to update

  // The column list once held "col = $n" fragments, so every save was a
  // syntax error and the evening-reminder settings never stuck. A new row
  // takes the read defaults for the field not given (the columns have no
  // DEFAULT, and a NULL evening_enabled reads as "off").
  await pool.query(
    `INSERT INTO user_notification_prefs (user_id, evening_enabled, evening_time, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}, updated_at = NOW()`,
    [
      userId,
      prefs.evening_enabled !== undefined ? prefs.evening_enabled : DEFAULT_PREFS.evening_enabled,
      prefs.evening_time !== undefined ? prefs.evening_time : DEFAULT_PREFS.evening_time,
    ]
  );
}

module.exports = { getPreferences, upsertPreferences };