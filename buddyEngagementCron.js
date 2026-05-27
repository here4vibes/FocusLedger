'use strict';
/**
 * Buddy Engagement Cron
 *
 * Runs every hour. For each active user it processes the PREVIOUS local day:
 *   1. Checks whether the user completed a Buddy check-in that day.
 *   2. If yes  → resets lapse state.
 *   3. If no   → increments consecutive_missed_checkins and fires re-engagement
 *                touches in this exact cadence:
 *                  Day 3 of lapse → push notification + hook restart (session_count reset)
 *                  Day 5 of lapse → re-engagement email ("Your stuff is still here")
 *                  Day 14 of lapse → final email + stop (3 touches max)
 *
 * A "check-in" is ANY of:
 *   - buddy_conversations row with session_date = target date and role = 'buddy'
 *   - login_checkin_done_date = target date on the users row
 *   - buddy_checkins row for target date (morning or evening type)
 *
 * Idempotent — last_processed_date gates double-processing of the same day.
 * No guilt language in any messaging. Warm re-entry, zero shame.
 */

const { getUserLocalDate } = require('./lib/timezone');
const { sendEmail }        = require('./lib/emailService');
const {
  buddyReengageDay5Template,
  buddyReengageDay14Template,
} = require('./lib/emailTemplates');
const {
  getActiveSubscriptions,
  recordNotificationSent,
  wasNotificationSentToday,
  deleteSubscriptionByEndpoint,
} = require('./db/notifications');
const { sendApnsNotification, isApnsConfigured } = require('./lib/apns-sender');
const { getPushTokens, deletePushToken }         = require('./db/push-tokens');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Subtract one calendar day from a YYYY-MM-DD string.
 */
function subtractOneDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Return days elapsed since a given ISO timestamp (or date string).
 * Returns 0 if null.
 */
function daysSince(ts) {
  if (!ts) return 0;
  const ms = Date.now() - new Date(ts).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ── Upsert buddy_engagement row ───────────────────────────────────────────────

async function upsertEngagement(pool, userId, updates) {
  // Build the SET clause dynamically from the updates object.
  // Every call must include at least updated_at.
  const fields = Object.keys(updates);
  if (!fields.length) return;

  const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values     = [userId, ...fields.map(f => updates[f])];

  await pool.query(`
    INSERT INTO buddy_engagement (user_id, ${fields.join(', ')}, updated_at)
    VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET ${setClauses}, updated_at = NOW()
  `, values);
}

// ── Check whether the user completed a check-in on a specific local date ──────

async function didCheckinOnDate(pool, userId, dateStr) {
  const [convResult, loginResult, buddyResult] = await Promise.all([
    pool.query(`
      SELECT 1 FROM buddy_conversations
      WHERE user_id = $1 AND session_date = $2 AND role = 'buddy'
      LIMIT 1
    `, [userId, dateStr]),

    pool.query(`
      SELECT 1 FROM users
      WHERE id = $1 AND login_checkin_done_date::text = $2
      LIMIT 1
    `, [userId, dateStr]),

    pool.query(`
      SELECT 1 FROM buddy_checkins
      WHERE user_id = $1 AND checkin_date = $2 AND checkin_type IN ('morning','evening')
      LIMIT 1
    `, [userId, dateStr]),
  ]);

  return (
    convResult.rows.length > 0 ||
    loginResult.rows.length > 0 ||
    buddyResult.rows.length > 0
  );
}

// ── Send push notification (Web + APNs) ───────────────────────────────────────

async function sendBuddyRestartPush(pool, userId, localToday) {
  const notifKey   = 'buddy:hook_restart';
  const alreadySent = await wasNotificationSentToday(pool, userId, notifKey, localToday);
  if (alreadySent) return false;

  const webPushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const apnsEnabled    = isApnsConfigured();
  if (!webPushEnabled && !apnsEnabled) return false;

  const title = 'FocusLedger';
  const body  = "Buddy's ready when you are. Fresh start — Day 1.";
  const url   = '/app/checkin';
  let sentCount = 0;

  // ── Web Push ────────────────────────────────────────────────────────────────
  if (webPushEnabled) {
    try {
      const webpush = require('web-push');
      webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      const subs = await getActiveSubscriptions(pool, userId);
      const payload = JSON.stringify({ title, body, url, tag: 'fl-buddy-restart', renotify: false });
      for (const row of subs) {
        try {
          const sub = typeof row.subscription === 'string'
            ? JSON.parse(row.subscription) : row.subscription;
          await webpush.sendNotification(sub, payload);
          sentCount++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(() => {});
          } else {
            console.warn('[BuddyEngagement] Web push error user', userId, err.message);
          }
        }
      }
    } catch (_) { /* web-push module not available */ }
  }

  // ── APNs ─────────────────────────────────────────────────────────────────────
  if (apnsEnabled) {
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

  if (sentCount > 0) {
    await recordNotificationSent(pool, userId, notifKey, 'buddy_hook_restart', localToday);
  }

  return sentCount > 0;
}

// ── Restart Buddy hook for a user ─────────────────────────────────────────────
// Resets session_count → 0 so the progressive onboarding hook replays from Day 1.
// Increments buddy_hook_restart_count so prompts can show restart-aware copy.

async function restartBuddyHook(pool, userId) {
  await pool.query(`
    UPDATE users
    SET session_count             = 0,
        buddy_hook_restart_count  = COALESCE(buddy_hook_restart_count, 0) + 1
    WHERE id = $1
  `, [userId]);
}

// ── Per-user processing ───────────────────────────────────────────────────────

async function processUser(pool, user, now) {
  const userId = user.id;
  const tz     = user.timezone || 'America/New_York';

  // Compute today's local date and yesterday's local date
  const localToday     = getUserLocalDate(tz, now);
  const localYesterday = subtractOneDay(localToday);

  const eng = user.engagement || {};

  // Only process each user once per local day (idempotency guard)
  const lastProcessed = eng.last_processed_date
    ? String(eng.last_processed_date).slice(0, 10) : null;
  if (lastProcessed === localYesterday) return; // already processed

  const checkedIn = await didCheckinOnDate(pool, userId, localYesterday);

  if (checkedIn) {
    // User returned — reset all lapse state
    await upsertEngagement(pool, userId, {
      consecutive_missed_checkins: 0,
      last_checkin_at:             now.toISOString(),
      lapse_started_at:            null,
      lapse_push_sent:             false,
      lapse_day5_email_sent:       false,
      lapse_day14_email_sent:      false,
      last_processed_date:         localYesterday,
    });
    return;
  }

  // User missed yesterday — update counters
  const prevMissed       = eng.consecutive_missed_checkins || 0;
  const newMissed        = prevMissed + 1;
  const lapseStartedAt   = eng.lapse_started_at || now.toISOString();
  const lapseDay         = daysSince(lapseStartedAt) || newMissed; // days of inactivity

  const pushSent     = !!eng.lapse_push_sent;
  const day5Sent     = !!eng.lapse_day5_email_sent;
  const day14Sent    = !!eng.lapse_day14_email_sent;

  let newConsecutive     = newMissed;
  let newLastRestartAt   = eng.last_restart_at || null;
  let newPushSent        = pushSent;
  let hookRestartCount   = eng.hook_restart_count || 0;

  // ── Day 3: push + hook restart ────────────────────────────────────────────
  if (lapseDay >= 3 && !pushSent) {
    await restartBuddyHook(pool, userId);
    hookRestartCount += 1;
    newLastRestartAt  = now.toISOString();
    // Reset consecutive counter so user gets another 3-day grace before next restart
    newConsecutive = 0;

    // Best-effort push — never fails the cron run
    try {
      await sendBuddyRestartPush(pool, userId, localToday);
    } catch (pushErr) {
      console.warn('[BuddyEngagement] Push error user', userId, ':', pushErr.message);
    }
    newPushSent = true;
    console.log(`[BuddyEngagement] Hook restarted for user ${userId} (lapse day ${lapseDay})`);
  }

  // ── Day 5: re-engagement email ─────────────────────────────────────────────
  if (lapseDay >= 5 && !day5Sent && process.env.RESEND_API_KEY) {
    try {
      const { subject, html } = buddyReengageDay5Template({ name: user.name });
      sendEmail(pool, {
        to:           user.email,
        subject,
        html,
        templateType: 'buddy_reengage_day5',
        userId,
      }).catch(err => console.error('[BuddyEngagement] Day-5 email error user', userId, err.message));
    } catch (emailErr) {
      console.warn('[BuddyEngagement] Day-5 email build error user', userId, ':', emailErr.message);
    }
    console.log(`[BuddyEngagement] Day-5 email queued for user ${userId}`);
  }

  // ── Day 14: final email ────────────────────────────────────────────────────
  if (lapseDay >= 14 && !day14Sent && process.env.RESEND_API_KEY) {
    try {
      const { subject, html } = buddyReengageDay14Template({ name: user.name });
      sendEmail(pool, {
        to:           user.email,
        subject,
        html,
        templateType: 'buddy_reengage_day14',
        userId,
      }).catch(err => console.error('[BuddyEngagement] Day-14 email error user', userId, err.message));
    } catch (emailErr) {
      console.warn('[BuddyEngagement] Day-14 email build error user', userId, ':', emailErr.message);
    }
    console.log(`[BuddyEngagement] Day-14 final email queued for user ${userId}`);
  }

  await upsertEngagement(pool, userId, {
    consecutive_missed_checkins: newConsecutive,
    hook_restart_count:          hookRestartCount,
    last_restart_at:             newLastRestartAt,
    lapse_started_at:            lapseStartedAt,
    lapse_push_sent:             newPushSent,
    lapse_day5_email_sent:       day5Sent || lapseDay >= 5,
    lapse_day14_email_sent:      day14Sent || lapseDay >= 14,
    last_processed_date:         localYesterday,
  });
}

// ── Main job ──────────────────────────────────────────────────────────────────

async function runBuddyEngagementCheck(pool) {
  const now = new Date();

  let users;
  try {
    // Fetch all non-QA users created > 2 days ago, plus their existing engagement row (if any)
    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.name,
        COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone,
        e.consecutive_missed_checkins,
        e.hook_restart_count,
        e.last_checkin_at,
        e.last_restart_at,
        e.last_processed_date,
        e.lapse_started_at,
        e.lapse_push_sent,
        e.lapse_day5_email_sent,
        e.lapse_day14_email_sent
      FROM users u
      LEFT JOIN buddy_engagement e ON e.user_id = u.id
      WHERE COALESCE(u.is_qa_user, false) = false
        AND u.created_at < NOW() - INTERVAL '2 days'
    `);
    users = result.rows;
  } catch (err) {
    console.error('[BuddyEngagement] Failed to fetch users:', err.message);
    return;
  }

  let processed = 0;
  for (const row of users) {
    const eng = {
      consecutive_missed_checkins: row.consecutive_missed_checkins || 0,
      hook_restart_count:          row.hook_restart_count || 0,
      last_checkin_at:             row.last_checkin_at,
      last_restart_at:             row.last_restart_at,
      last_processed_date:         row.last_processed_date,
      lapse_started_at:            row.lapse_started_at,
      lapse_push_sent:             row.lapse_push_sent || false,
      lapse_day5_email_sent:       row.lapse_day5_email_sent || false,
      lapse_day14_email_sent:      row.lapse_day14_email_sent || false,
    };

    const user = {
      id:       row.id,
      email:    row.email,
      name:     row.name,
      timezone: row.timezone,
      engagement: eng,
    };

    try {
      await processUser(pool, user, now);
      processed++;
    } catch (userErr) {
      console.warn('[BuddyEngagement] Error processing user', row.id, ':', userErr.message);
    }
  }

  if (processed > 0) {
    console.log(`[BuddyEngagement] Processed ${processed} users`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function scheduleBuddyEngagementCron(pool) {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour — catches different timezone midnights

  // Run once 3 minutes after startup (let DB migrations settle)
  setTimeout(() => {
    runBuddyEngagementCheck(pool).catch(err =>
      console.error('[BuddyEngagement] Startup run error:', err.message)
    );
  }, 3 * 60 * 1000);

  setInterval(() => {
    runBuddyEngagementCheck(pool).catch(err =>
      console.error('[BuddyEngagement] Interval run error:', err.message)
    );
  }, INTERVAL_MS);

  console.log('[BuddyEngagement] Cron started — checking every hour');
}

module.exports = { scheduleBuddyEngagementCron, runBuddyEngagementCheck };
