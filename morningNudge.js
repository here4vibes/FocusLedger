'use strict';
/**
 * Morning Nudge Scheduler
 *
 * Runs every 5 minutes. For each user with active push subscriptions:
 *   1. Converts current UTC time to the user's local timezone.
 *   2. If local hour matches the user's configured morning hour (default 8),
 *      checks whether a nudge was already sent today.
 *   3. Skips if notif_morning_enabled = false.
 *   4. Skips if the user was active in the app today (last_active_at).
 *   5. Sends: "What's on tap for today?" regardless of task count.
 *      Tapping opens /home which shows the command center.
 *   6. Also sends via APNs for iOS (Capacitor) users if APNS_* env vars set.
 *
 * Idempotent — morning_nudge_log enforces one-per-user-per-day via UNIQUE constraint.
 * Uses getLocalDateParts from lib/timezone.js (shared, single source of truth).
 */

const { getLocalDateParts } = require('./lib/timezone');
const { sendApnsNotification, isApnsConfigured } = require('./lib/apns-sender');
const { getPushTokens, deletePushToken } = require('./db/push-tokens');
const { resolveMorningHour } = require('./lib/energy-timing');
const { getUnviewedRevealForDate } = require('./db/reveals');

async function sendMorningNudges(pool) {
  const webPushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const apnsEnabled = isApnsConfigured();

  // Skip entirely if neither channel is configured
  if (!webPushEnabled && !apnsEnabled) return;

  let webpush = null;
  if (webPushEnabled) {
    try {
      webpush = require('web-push');
      webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
    } catch (e) {
      // web-push not installed — skip web push silently
      webpush = null;
    }
  }

  const now = new Date();

  try {
    // All users with at least one active push subscription OR an APNs token.
    // WHY UNION: web push users and APNs users have separate tables; a user
    // might have only an APNs token (iOS-only) or only a VAPID sub (web).
    const usersResult = await pool.query(`
      SELECT DISTINCT
        u.id,
        COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone,
        u.last_active_at,
        COALESCE(u.notif_morning_enabled, true)  AS notif_morning_enabled,
        u.notif_morning_hour                      AS notif_morning_hour,
        u.adhd_profile->>'peak_energy'            AS peak_energy
      FROM users u
      WHERE u.id IN (
        SELECT user_id FROM push_subscriptions WHERE enabled = true
        UNION
        SELECT user_id FROM push_tokens
      )
    `);

    for (const user of usersResult.rows) {
      try {
        // Skip if user has disabled morning notifications
        if (!user.notif_morning_enabled) continue;

        const tz = user.timezone;
        // Honor an explicit custom hour; otherwise time the nudge to the user's
        // peak-energy window so a plan-the-day prompt lands when they can act on it.
        const targetHour = resolveMorningHour(user.notif_morning_hour, user.peak_energy);
        const { date: localDate, hour: localHour } = getLocalDateParts(tz, now);

        // Only send during the configured morning hour window
        if (localHour !== targetHour) continue;

        // Skip if already sent today (UNIQUE constraint also enforces this server-side)
        const alreadySent = await pool.query(
          'SELECT 1 FROM morning_nudge_log WHERE user_id = $1 AND send_date = $2 LIMIT 1',
          [user.id, localDate]
        );
        if (alreadySent.rows.length > 0) continue;

        // Skip if user was already active today
        if (user.last_active_at) {
          const { date: lastActiveDate } = getLocalDateParts(tz, new Date(user.last_active_at));
          if (lastActiveDate === localDate) continue;
        }

        // Always send the morning prompt — even if no tasks yet.
        // The nudge itself is the prompt to plan.
        let notifTitle = 'Good morning \u2600\uFE0F';
        let notifBody  = "What\u2019s on tap for today?";
        let notifUrl   = '/home';

        // Curiosity-gap upgrade: if a Daily Reveal is staged for today, tease
        // its headline instead \u2014 "Buddy noticed something" out-pulls a generic
        // prompt. Guarded separately: daily_reveals may not exist yet on a
        // fresh deploy (cron images can start before the web service migrates),
        // and the default copy must survive that.
        try {
          const reveal = await getUnviewedRevealForDate(pool, user.id, localDate);
          if (reveal && reveal.headline) {
            notifTitle = 'Buddy found something \uD83D\uDC40';
            notifBody  = reveal.headline;
            notifUrl   = '/app';
          }
        } catch (revealErr) {
          console.warn('[MorningNudge] reveal lookup failed (using default copy):', revealErr.message);
        }

        let sentCount = 0;

        // ── Web Push (VAPID) ──────────────────────────────────────────────
        if (webpush) {
          const payload = JSON.stringify({
            title: notifTitle, body: notifBody, url: notifUrl,
            tag: 'fl-morning', renotify: false
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
                console.warn('[MorningNudge] Web push error for user', user.id, sendErr.message);
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
            `INSERT INTO morning_nudge_log (user_id, send_date, task_count, sent_at)
             VALUES ($1, $2, 0, NOW())
             ON CONFLICT (user_id, send_date) DO NOTHING`,
            [user.id, localDate]
          );
          console.log(`[MorningNudge] Sent to user ${user.id} (tz: ${tz}, hour: ${targetHour})`);
        }

      } catch (userErr) {
        console.warn('[MorningNudge] Error processing user', user.id, ':', userErr.message);
      }
    }
  } catch (err) {
    console.error('[MorningNudge] Fatal error:', err.message);
  }
}

/**
 * scheduleMorningNudges(pool)
 * Call once at server startup. Runs sendMorningNudges every 5 minutes.
 * The function is idempotent — duplicate runs within the same hour are no-ops.
 */
function scheduleMorningNudges(pool) {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // First run immediately (catches the configured hour window if server restarts within it)
  sendMorningNudges(pool).catch(err =>
    console.error('[MorningNudge] Startup run error:', err.message)
  );

  setInterval(() => {
    sendMorningNudges(pool).catch(err =>
      console.error('[MorningNudge] Scheduled run error:', err.message)
    );
  }, INTERVAL_MS);

  console.log('[MorningNudge] Scheduler started — checking every 5 minutes');
}

module.exports = { scheduleMorningNudges, sendMorningNudges };
