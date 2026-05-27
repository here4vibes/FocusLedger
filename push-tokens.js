'use strict';
/**
 * db/push-tokens.js — Named query functions for APNs device token storage.
 * Owns: push_tokens table reads/writes.
 * Does NOT own: push_subscriptions (Web Push/VAPID), notification preferences,
 *               or the actual APNs send logic (that lives in lib/apns-sender.js).
 */

/**
 * Upsert an APNs device token for a user.
 * ON CONFLICT updates updated_at to keep the row fresh and help detect stale tokens.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} token — APNs device token (hex string from Capacitor)
 * @param {string} [platform] — 'ios' (default)
 */
async function upsertPushToken(pool, userId, token, platform = 'ios') {
  await pool.query(
    `INSERT INTO push_tokens (user_id, token, platform, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, token)
     DO UPDATE SET updated_at = NOW(), platform = $3`,
    [userId, token, platform]
  );
}

/**
 * Get all APNs tokens for a user.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @returns {Promise<Array<{id: number, token: string, platform: string}>>}
 */
async function getPushTokens(pool, userId) {
  const result = await pool.query(
    'SELECT id, token, platform FROM push_tokens WHERE user_id = $1',
    [userId]
  );
  return result.rows;
}

/**
 * Get all users with at least one APNs token, along with their preferences.
 * Used by notification cron jobs to find iOS users to notify.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array<{user_id: number, tokens: string[], timezone: string, ...prefs}>>}
 */
async function getUsersWithPushTokens(pool) {
  const result = await pool.query(`
    SELECT
      u.id AS user_id,
      COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone,
      u.last_active_at,
      COALESCE(u.notif_morning_enabled, true)  AS notif_morning_enabled,
      COALESCE(u.notif_morning_hour, 8)         AS notif_morning_hour,
      COALESCE(u.notif_evening_enabled, true)   AS notif_evening_enabled,
      COALESCE(u.notif_evening_hour, 20)        AS notif_evening_hour,
      array_agg(pt.token)                        AS tokens
    FROM users u
    JOIN push_tokens pt ON pt.user_id = u.id
    GROUP BY u.id
  `);
  return result.rows;
}

/**
 * Delete a specific APNs token (called when APNs returns 410 for an expired token).
 *
 * @param {import('pg').Pool} pool
 * @param {string} token
 */
async function deletePushToken(pool, token) {
  await pool.query('DELETE FROM push_tokens WHERE token = $1', [token]);
}

/**
 * Delete all APNs tokens for a user (logout / unsubscribe).
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 */
async function deleteAllPushTokens(pool, userId) {
  await pool.query('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
}

module.exports = {
  upsertPushToken,
  getPushTokens,
  getUsersWithPushTokens,
  deletePushToken,
  deleteAllPushTokens,
};
