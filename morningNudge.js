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

  // Skip entirely if neither channel is configured. LOUDLY — a silent return
  // here made every run "finish successfully" with zero output while no nudge
  // ever sent, because the cron's env group lacks the push keys (VAPID for web,
  // APNS_* for iOS). Never fail silently: say exactly why nothing happened.
  if (!webPushEnabled && !apnsEnabled) {
    console.warn('[MorningNudge] No push channel configured — set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (web push) or APNS_KEY_ID/APNS_TEAM_ID/APNS_KEY_P8/APNS_BUNDLE_ID (iOS) in the cron env group. Skipping (0 sent).');
    return;
  }

  let webpush = null;
  if (webPushEnabled) {
    try {
      webpush = require('web-push');
      // Trim: pasted env values routinely carry a trailing newline/space, which
      // makes setVapidDetails throw "Vapid public key should be 65 bytes" — and
      // used to disable web push SILENTLY even though the keys were "present".
      webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
        (process.env.VAPID_PUBLIC_KEY || '').trim(),
        (process.env.VAPID_PRIVATE_KEY || '').trim()
      );
      console.log('[MorningNudge] Web push configured (VAPID ok).');
    } catch (e) {
      // Loudly, never silently: distinguishes a malformed key from a missing lib.
      webpush = null;
      console.error('[MorningNudge] Web push DISABLED despite VAPID env being set —',
        e.message, '| likely a malformed key (trailing whitespace/newline?) or web-push not installed.');
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

    let sentUsers = 0;
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

        // Curiosity-gap upgrade: if an UNVIEWED Daily Reveal is staged, the
        // nudge teases its headline. Checked BEFORE the activity suppression
        // because a sealed reveal overrides it: the tease is the pull-back-in
        // mechanic, valuable even for someone who opened the app earlier
        // today. Guarded separately: daily_reveals may not exist on a fresh
        // deploy, and the default copy must survive that.
        let reveal = null;
        try {
          reveal = await getUnviewedRevealForDate(pool, user.id, localDate);
        } catch (revealErr) {
          console.warn('[MorningNudge] reveal lookup failed (using default copy):', revealErr.message);
        }

        // Skip already-active users ONLY when there's no sealed reveal waiting
        if (!reveal && user.last_active_at) {
          const { date: lastActiveDate } = getLocalDateParts(tz, new Date(user.last_active_at));
          if (lastActiveDate === localDate) continue;
        }

        // Always send the morning prompt — even if no tasks yet.
        // The nudge itself is the prompt to plan.
        let notifTitle = 'Good morning \u2600\uFE0F';
        let notifBody  = "What\u2019s on tap for today?";
        let notifUrl   = '/home';

        if (reveal && reveal.headline) {
            notifTitle = 'Buddy found something \uD83D\uDC40';
            notifBody  = reveal.headline;
            notifUrl   = '/app';
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
                // statusCode is the tell: 403 = VAPID key mismatch (the send keys
                // differ from the ones the browser subscribed with); 400 = bad
                // payload/keys. Surface it so "sent=0" is never a mystery.
                console.warn('[MorningNudge] Web push error for user', user.id,
                  '| status:', sendErr.statusCode, '| ', sendErr.message);
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
          sentUsers++;
        }

      } catch (userErr) {
        console.warn('[MorningNudge] Error processing user', user.id, ':', userErr.message);
      }
    }
    // Always emit a summary so a quiet morning is diagnosable at a glance
    // (candidates = users with a push device; sent = nudges actually delivered).
    console.log(`[MorningNudge] Done. candidates=${usersResult.rows.length} sent=${sentUsers}`);
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
