'use strict';
/**
 * services/NotificationService.js — Evening check-in notification logic.
 *
 * Owns: push delivery for evening check-in, preference reads/writes.
 * Does NOT own: push token storage (db/push-tokens.js), notification dedup
 *               (db/notifications.js), generic nudge preferences (nudge_preferences table).
 *
 * Condition chain (all must pass before send):
 *   1. User has a Plaid token connected  → plaid_tokens table
 *   2. User has transactions today        → transactions table (user's local date)
 *   3. Evening check-in is enabled       → user_notification_prefs.evening_enabled
 *   4. Session not already complete today → spending_sessions.complete
 *
 * Push uses Web Push (VAPID) + APNs via existing lib/apns-sender.js.
 * Retry: on failure, schedules a retry via setTimeout(15 min) — persists across
 * cron invocations within the same process lifetime.
 *
 * Events emitted:
 *   - evening_checkin.sent           — on successful send
 *   - evening_checkin.skipped        — on condition failure (with reason)
 *   - evening_checkin.retry_scheduled — when initial send fails and retry is queued
 *   - evening_checkin.retry_failed    — when retry also fails
 */

const { getPreferences, upsertPreferences }       = require('../db/userNotificationPrefs');
const { insertEvent }                             = require('../db/events');
const { wasNotificationSentToday, recordNotificationSent } = require('../db/notifications');
const { sendApnsNotification, isApnsConfigured }  = require('../lib/apns-sender');
const { getActiveSubscriptions }                  = require('../db/notifications');
const { getPushTokens, deletePushToken }          = require('../db/push-tokens');
const { getUserLocalDate }                        = require('../lib/timezone');

// ── Condition checks ─────────────────────────────────────────────────────────

/**
 * Condition 1: user has a Plaid token connected.
 */
async function hasPlaidToken(pool, userId) {
  const result = await pool.query(
    `SELECT 1 FROM plaid_tokens WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

/**
 * Condition 2: user has at least one transaction today (in their local timezone).
 */
async function hasTransactionsToday(pool, userId, timezone) {
  const localDate = getUserLocalDate(timezone || 'America/New_York', new Date());
  const result = await pool.query(
    `SELECT 1 FROM transactions WHERE user_id = $1 AND date = $2::date LIMIT 1`,
    [userId, localDate]
  );
  return result.rows.length > 0;
}

/**
 * Condition 3: evening check-in is enabled in user_notification_prefs.
 */
async function isEveningEnabled(pool, userId) {
  const prefs = await getPreferences(pool, userId);
  return !!prefs.evening_enabled;
}

/**
 * Condition 4: today's spending session is NOT already complete.
 */
async function isSessionIncomplete(pool, userId, timezone) {
  const localDate = getUserLocalDate(timezone || 'America/New_York', new Date());
  const result = await pool.query(
    `SELECT complete FROM spending_sessions
     WHERE user_id = $1 AND session_date = $2::date
     LIMIT 1`,
    [userId, localDate]
  );
  if (result.rows.length === 0) return true; // no session = not complete
  return !result.rows[0].complete;
}

// ── Push sending ──────────────────────────────────────────────────────────────

async function sendPushToUser(pool, userId, title, body, url) {
  let sentCount = 0;

  // Web Push (VAPID)
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      const webpush = require('web-push');
      webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      const subs = await getActiveSubscriptions(pool, userId);
      const payload = JSON.stringify({ title, body, url, tag: 'fl-evening-checkin', renotify: false });
      for (const row of subs) {
        try {
          const sub = typeof row.subscription === 'string'
            ? JSON.parse(row.subscription) : row.subscription;
          await webpush.sendNotification(sub, payload);
          sentCount++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(() => {});
          }
        }
      }
    } catch (_) { /* web-push not available */ }
  }

  // APNs
  if (isApnsConfigured()) {
    const tokenRows = await getPushTokens(pool, userId);
    if (tokenRows.length > 0) {
      const tokens = tokenRows.map(r => r.token);
      const { sent } = await sendApnsNotification(
        tokens,
        { title, body, url },
        (bad) => deletePushToken(pool, bad)
      );
      sentCount += sent;
    }
  }

  return sentCount;
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Send evening check-in push to a user.
 * Returns { sent: boolean, reason?: string, retried?: boolean }
 *
 * Retry logic: if push fails, schedules a retry in 15 minutes via setTimeout.
 * The retry is best-effort — it won't block the caller.
 */
async function send_evening_checkin(pool, userId) {
  const notifKey = 'evening_checkin';

  // Fetch user timezone for local date calculations
  const userResult = await pool.query(
    `SELECT COALESCE(NULLIF(timezone, ''), 'America/New_York') AS tz FROM users WHERE id = $1`,
    [userId]
  );
  if (userResult.rows.length === 0) return { sent: false, reason: 'user_not_found' };
  const timezone = userResult.rows[0].tz;

  // Check dedup — don't re-send today
  const localToday = getUserLocalDate(timezone, new Date());
  const alreadySent = await wasNotificationSentToday(pool, userId, notifKey, localToday);
  if (alreadySent) return { sent: false, reason: 'already_sent_today' };

  // ── Condition chain ────────────────────────────────────────────────────────
  const [plaidConnected, hasTx, eveningEnabled, sessionIncomplete] = await Promise.all([
    hasPlaidToken(pool, userId),
    hasTransactionsToday(pool, userId, timezone),
    isEveningEnabled(pool, userId),
    isSessionIncomplete(pool, userId, timezone),
  ]);

  if (!plaidConnected) {
    await insertEvent(pool, { userId, eventType: 'evening_checkin.skipped', payload: { reason: 'no_plaid_token', date: localToday } });
    return { sent: false, reason: 'no_plaid_token' };
  }
  if (!hasTx) {
    await insertEvent(pool, { userId, eventType: 'evening_checkin.skipped', payload: { reason: 'no_transactions_today', date: localToday } });
    return { sent: false, reason: 'no_transactions_today' };
  }
  if (!eveningEnabled) {
    await insertEvent(pool, { userId, eventType: 'evening_checkin.skipped', payload: { reason: 'evening_disabled', date: localToday } });
    return { sent: false, reason: 'evening_disabled' };
  }
  if (!sessionIncomplete) {
    await insertEvent(pool, { userId, eventType: 'evening_checkin.skipped', payload: { reason: 'session_already_complete', date: localToday } });
    return { sent: false, reason: 'session_already_complete' };
  }

  // All conditions pass → send push
  const title = 'FocusLedger';
  const body  = "Let's wrap up today's spending — tap to check in.";
  const url   = '/money';

  let sentCount = 0;
  try {
    sentCount = await sendPushToUser(pool, userId, title, body, url);
  } catch (err) {
    console.warn(`[NotificationService] Push send failed for user ${userId}:`, err.message);
  }

  if (sentCount > 0) {
    await recordNotificationSent(pool, userId, notifKey, 'evening_checkin', localToday);
    await insertEvent(pool, { userId, eventType: 'evening_checkin.sent', payload: { date: localToday, channels: sentCount > 1 ? 'web+apns' : 'web_or_apns' } });
    return { sent: true };

  } else {
    // No push tokens configured — record as skipped with reason
    await insertEvent(pool, { userId, eventType: 'evening_checkin.skipped', payload: { reason: 'no_push_tokens', date: localToday } });

    // Schedule retry in 15 minutes
    setTimeout(() => {
      retryEveningCheckin(pool, userId, timezone).catch(err =>
        console.warn(`[NotificationService] Retry failed for user ${userId}:`, err.message)
      );
    }, 15 * 60 * 1000);

    await insertEvent(pool, { userId, eventType: 'evening_checkin.retry_scheduled', payload: { date: localToday, retry_in_minutes: 15 } });
    return { sent: false, reason: 'retry_scheduled' };
  }
}

/**
 * Retry the evening check-in push after a prior failure.
 * Skips conditions (push tokens already checked) and goes straight to send.
 * On failure, records retry_failed — no further automatic retries.
 */
async function retryEveningCheckin(pool, userId, timezone) {
  const notifKey = 'evening_checkin';
  const localToday = getUserLocalDate(timezone || 'America/New_York', new Date());
  const alreadySent = await wasNotificationSentToday(pool, userId, notifKey, localToday);
  if (alreadySent) return { sent: false, reason: 'already_sent_today' };

  let sentCount = 0;
  try {
    sentCount = await sendPushToUser(pool, userId, 'FocusLedger', "Let's wrap up today's spending — tap to check in.", '/money');
  } catch (err) {
    console.warn(`[NotificationService] Retry push failed for user ${userId}:`, err.message);
  }

  if (sentCount > 0) {
    await recordNotificationSent(pool, userId, notifKey, 'evening_checkin_retry', localToday);
    await insertEvent(pool, { userId, eventType: 'evening_checkin.sent', payload: { date: localToday, is_retry: true } });
  } else {
    await insertEvent(pool, { userId, eventType: 'evening_checkin.retry_failed', payload: { date: localToday } });
  }

  return { sent: sentCount > 0 };
}

/**
 * Get notification preferences for a user.
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @returns {Promise<{ evening_enabled: boolean, evening_time: string }>}
 */
async function get_preferences(pool, userId) {
  return getPreferences(pool, userId);
}

/**
 * Update notification preferences for a user.
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {{ evening_enabled?: boolean, evening_time?: string }} prefs
 */
async function update_preferences(pool, userId, prefs) {
  return upsertPreferences(pool, userId, prefs);
}

// Wrapper for deleteSubscriptionByEndpoint (needs to be imported from db/notifications)
const { deleteSubscriptionByEndpoint } = require('../db/notifications');

module.exports = { send_evening_checkin, get_preferences, update_preferences };