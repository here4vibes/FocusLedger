'use strict';
/**
 * db/userNotificationPrefs.js — Named query functions for user_notification_prefs table.
 * Owns: user_notification_prefs table reads/writes (evening_enabled, evening_time).
 * Does NOT own: push_subscriptions (push_subscriptions table), notification_send_log.
 * Note: evening_enabled/evening_time from user_notification_prefs.
 *       Generic nudge prefs (push, email, banner) live in nudge_preferences table.
 */

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
    return { evening_enabled: true, evening_time: '20:00' };
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
  const fields = [];
  const values = [];
  let idx = 1;

  if (prefs.evening_enabled !== undefined) {
    fields.push(`evening_enabled = $${idx++}`);
    values.push(prefs.evening_enabled);
  }
  if (prefs.evening_time !== undefined) {
    fields.push(`evening_time = $${idx++}`);
    values.push(prefs.evening_time);
  }

  if (fields.length === 0) return; // nothing to update

  values.push(userId);

  await pool.query(
    `INSERT INTO user_notification_prefs (user_id, ${fields.join(', ')}, updated_at)
     VALUES ($${idx}, ${fields.map((_, i) => `$${i + 1}`).join(', ')}, NOW())
     ON CONFLICT (user_id) DO UPDATE SET ${fields.join(', ')}, updated_at = NOW()`,
    values
  );
}

module.exports = { getPreferences, upsertPreferences };