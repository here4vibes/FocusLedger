'use strict';
/**
 * Evening Nudge Scheduler
 *
 * Runs every 5 minutes. For each user with active push subscriptions:
 *   1. Converts current UTC time to the user's local timezone.
 *   2. If local hour matches the user's configured evening hour (default 20 = 8pm),
 *      checks whether an evening nudge was already sent today.
 *   3. Skips if notif_evening_enabled = false.
 *   4. Always fires — even if the user completed nothing.
 *      No guilt, no stats, just the gentle reflective prompt.
 *   5. Also sends via APNs for iOS (Capacitor) users if APNS_* env vars set.
 *
 * Message: "How did today go?"
 * Tap target: /home (command center with today's completion summary visible)
 *
 * Idempotent — evening_nudge_log enforces one-per-user-per-day via UNIQUE constraint.
 * Uses getLocalDateParts from lib/timezone.js (shared, single source of truth).
 */

const { getLocalDateParts } = require('./lib/timezone');
const { sendApnsNotification, isApnsConfigured } = require('./lib/apns-sender');
const { getPushTokens, deletePushToken } = require('./db/push-tokens');

async function sendEveningNudges(pool) {
  const webPushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const apnsEnabled = isApnsConfigured();
  if (!webPushEnabled && !apnsEnabled) {
    console.warn('[evening-nudge] No push channel configured — set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (web push) or APNS_* (iOS) in the cron env group. Skipping (0 sent).');
    return;
  }

  let webpush = null;
  if (webPushEnabled) {
    try {
      webpush = require('web-push');
      webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
        (process.env.VAPID_PUBLIC_KEY || '').trim(),
        (process.env.VAPID_PRIVATE_KEY || '').trim()
      );
      console.log('[evening-nudge] Web push configured (VAPID ok).');
    } catch (e) {
      webpush = null;
      console.error('[evening-nudge] Web push DISABLED despite VAPID env being set —', e.message, '| malformed key?');
    }
  }

  const now = new Date();

  try {
    // All users with at least one active push subscription OR APNs token + evening enabled
    const usersResult = await pool.query(`
      SELECT DISTINCT
        u.id,
        COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone,
        COALESCE(u.notif_evening_enabled, true)  AS notif_evening_enabled,
        COALESCE(u.notif_evening_hour, 20)        AS notif_evening_hour
      FROM users u
      WHERE u.id IN (
        SELECT user_id FROM push_subscriptions WHERE enabled = true
        UNION
        SELECT user_id FROM push_tokens
      )
    `);

    for (const user of usersResult.rows) {
      try {
        // Skip if user has disabled evening notifications
        if (!user.notif_evening_enabled) continue;

        const tz = user.timezone;
        const targetHour = typeof user.notif_evening_hour === 'number'
          ? user.notif_evening_hour
          : 20;
        const { date: localDate, hour: localHour } = getLocalDateParts(tz, now);

        // Only send during the configured evening hour window
        if (localHour !== targetHour) continue;

        // Skip if already sent today
        const alreadySent = await pool.query(
          'SELECT 1 FROM evening_nudge_log WHERE user_id = $1 AND send_date = $2 LIMIT 1',
          [user.id, localDate]
        );
        if (alreadySent.rows.length > 0) continue;

        // No guilt. No stats. Just the gentle reflective prompt.
        const notifTitle = 'FocusLedger \uD83C\uDF19';
        const notifBody  = 'How did today go?';
        const notifUrl   = '/home';

        let sentCount = 0;

        // ── Web Push (VAPID) ──────────────────────────────────────────────
        if (webpush) {
          const payload = JSON.stringify({
            title: notifTitle, body: notifBody, url: notifUrl,
            tag: 'fl-evening', renotify: false
          });
          const subResult = await pool.query(
            'SELECT subscription, endpoint FROM push_subscriptions WHERE user_id = $1 AND enabled = true',
            [user.id]
          );
          for (const row of subResult.rows) {
            try {
              const sub = typeof row.subscription === 'string'
                ? JSON.parse(row.subscription) : row.subscription;
              await webpush.sendNotification(sub, payload);
              sentCount++;
            } catch (sendErr) {
              if (sendErr.statusCode === 410 || sendErr.statusCode === 404) {
                await pool.query(
                  'DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]
                ).catch(() => {});
              } else {
                console.warn('[EveningNudge] Web push error for user', user.id, sendErr.message);
              }
            }
          }
        }

        // ── APNs (iOS / Capacitor) ────────────────────────────────────────
        if (apnsEnabled) {
          const iosTokenRows = await getPushTokens(pool, user.id);
          if (iosTokenRows.length > 0) {
            const tokens = iosTokenRows.map(r => r.token);
            const { sent } = await sendApnsNotification(
              tokens,
              { title: notifTitle, body: notifBody, url: notifUrl },
              (invalidToken) => deletePushToken(pool, invalidToken)
            );
            sentCount += sent;
          }
        }

        if (sentCount > 0) {
          // Record the send — UNIQUE constraint prevents duplicates on race conditions
          await pool.query(
            `INSERT INTO evening_nudge_log (user_id, send_date, sent_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (user_id, send_date) DO NOTHING`,
            [user.id, localDate]
          );
          console.log(`[EveningNudge] Sent to user ${user.id} (tz: ${tz}, hour: ${targetHour})`);
        }

      } catch (userErr) {
        console.warn('[EveningNudge] Error processing user', user.id, ':', userErr.message);
      }
    }
  } catch (err) {
    console.error('[EveningNudge] Fatal error:', err.message);
  }
}

/**
 * scheduleEveningNudges(pool)
 * Call once at server startup. Runs sendEveningNudges every 5 minutes.
 * The function is idempotent — duplicate runs within the same hour are no-ops.
 */
function scheduleEveningNudges(pool) {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // First run immediately (catches the evening window if server restarts within it)
  sendEveningNudges(pool).catch(err =>
    console.error('[EveningNudge] Startup run error:', err.message)
  );

  setInterval(() => {
    sendEveningNudges(pool).catch(err =>
      console.error('[EveningNudge] Scheduled run error:', err.message)
    );
  }, INTERVAL_MS);

  console.log('[EveningNudge] Scheduler started — checking every 5 minutes');
}

module.exports = { scheduleEveningNudges, sendEveningNudges };
