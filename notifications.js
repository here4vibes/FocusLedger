/**
 * db/notifications.js — Named query functions for push notification tracking.
 * Owns: notification_send_log reads/writes, push_subscriptions reads/writes.
 * Does NOT own: notification preferences (those live on users table), nudge generation.
 */
'use strict';

const DAILY_PUSH_CAP = 3;

/**
 * Check if a notification was already sent for this key today.
 * Returns true if already sent (should skip).
 * WHY localDate param: CURRENT_DATE is UTC on Neon — dedup must use the user's local date
 * so notifications don't re-fire after UTC midnight while it's still "today" for the user.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} notificationKey
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone (falls back to CURRENT_DATE)
 */
async function wasNotificationSentToday(pool, userId, notificationKey, localDate) {
  const dateExpr = localDate ? '$3::date' : 'CURRENT_DATE';
  const params = localDate
    ? [userId, notificationKey, localDate]
    : [userId, notificationKey];
  const result = await pool.query(
    `SELECT 1 FROM notification_send_log
     WHERE user_id = $1 AND notification_key = $2 AND send_date = ${dateExpr}
     LIMIT 1`,
    params
  );
  return result.rows.length > 0;
}

/**
 * Count how many push notifications a user has received today.
 * Used to enforce the daily cap.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone
 */
async function getTodayNotificationCount(pool, userId, localDate) {
  const dateExpr = localDate ? '$2::date' : 'CURRENT_DATE';
  const params = localDate ? [userId, localDate] : [userId];
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notification_send_log
     WHERE user_id = $1 AND send_date = ${dateExpr}`,
    params
  );
  return result.rows[0]?.count || 0;
}

/**
 * Record that a notification was sent. Uses ON CONFLICT to be idempotent —
 * if a race condition causes two workers to try, only one row is inserted.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} notificationKey
 * @param {string} [notificationType]
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone
 */
async function recordNotificationSent(pool, userId, notificationKey, notificationType, localDate) {
  const dateVal = localDate ? '$4::date' : 'CURRENT_DATE';
  const params = localDate
    ? [userId, notificationKey, notificationType || 'task_deadline', localDate]
    : [userId, notificationKey, notificationType || 'task_deadline'];
  await pool.query(
    `INSERT INTO notification_send_log (user_id, notification_key, notification_type, send_date, sent_at)
     VALUES ($1, $2, $3, ${dateVal}, NOW())
     ON CONFLICT (user_id, notification_key, send_date) DO NOTHING`,
    params
  );
}

/**
 * Get all active push subscriptions for a user.
 */
async function getActiveSubscriptions(pool, userId) {
  const result = await pool.query(
    'SELECT id, subscription, endpoint FROM push_subscriptions WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  return result.rows;
}

/**
 * Delete a push subscription by endpoint (expired/gone).
 */
async function deleteSubscriptionByEndpoint(pool, endpoint) {
  await pool.query(
    'DELETE FROM push_subscriptions WHERE endpoint = $1',
    [endpoint]
  );
}

module.exports = {
  DAILY_PUSH_CAP,
  wasNotificationSentToday,
  getTodayNotificationCount,
  recordNotificationSent,
  getActiveSubscriptions,
  deleteSubscriptionByEndpoint,
};
