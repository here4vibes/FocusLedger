#!/usr/bin/env node
/**
 * jobs/coldStartNudge.js — Hourly job (render.yaml); sends at 10:00 user-local only.
 *
 * Finds tasks that are 2+ days overdue with no focus session in the last 48 hours
 * and sends one proactive push nudge: "Want one tiny first step to get [Task] moving?"
 *
 * Limits: 1 cold-start push per user per day; respects the global daily push cap (3).
 * Dedup key: cold_start_{task_id} — prevents repeat nudges for the same task on the same day.
 * Each task gets at most MAX_NUDGES_PER_TASK cold-start pushes, then the next-oldest
 * task takes its turn (it used to pick the same oldest task every day, forever).
 */
'use strict';

// dotenv is not an installed dependency — requiring it crashes the job with
// MODULE_NOT_FOUND. Render injects env vars directly.
const { initSentry } = require('../lib/sentry');
initSentry('coldStartNudge'); // console.error → Sentry for this cron (see lib/sentry.js)

const { Pool } = require('pg');
const { getLocalDateParts } = require('../lib/timezone');

// 10:00 local: a gentle mid-morning prompt. The job used to run once at 09:00
// UTC, which is 05:00 Eastern and 02:00 Pacific.
const SEND_HOUR = 10;
const MAX_NUDGES_PER_TASK = 3;
const TITLE_MAX = 50;

function shortTitle(title) {
  const t = String(title || '').trim() || 'that task';
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t;
}
const {
  DAILY_PUSH_CAP,
  getTodayNotificationCount,
  wasNotificationSentToday,
  recordNotificationSent,
  getActiveSubscriptions,
  deleteSubscriptionByEndpoint,
} = require('../db/notifications');
const { isApnsConfigured, sendApnsNotification } = require('../lib/apns-sender');
const { configureWebPush } = require('../lib/webpush');
const { getPushTokens, deletePushToken } = require('../db/push-tokens');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});

async function sendWebPush(webpush, subscriptions, payload, pool) {
  if (!webpush) return 0;
  let sent = 0;
  for (const row of subscriptions) {
    try {
      const sub = typeof row.subscription === 'string'
        ? JSON.parse(row.subscription)
        : row.subscription;
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(e =>
          console.error('[cold-start-nudge] stale subscription delete failed:', e.message));
      } else {
        console.error('[cold-start-nudge] web push failed | status:', err.statusCode, '|', err.message);
      }
    }
  }
  return sent;
}

async function sendApnsPush(userId, payload) {
  if (!isApnsConfigured()) return 0;
  const tokens = await getPushTokens(pool, userId);
  if (!tokens.length) return 0;
  // sendApnsNotification expects { title, body, url } — NOT a raw aps envelope
  // (it builds the aps alert itself). Passing an aps-shaped object dropped the
  // title/body and hard-coded url to /app. Forward the real payload fields.
  const parsed = JSON.parse(payload);
  const { sent } = await sendApnsNotification(
    tokens.map(t => t.token),
    { title: parsed.title, body: parsed.body, url: parsed.url },
    async (invalidToken) => {
      await deletePushToken(pool, invalidToken).catch(e =>
        console.error('[cold-start-nudge] invalid token delete failed:', e.message, '| user:', userId));
    }
  );
  return sent;
}

async function run() {
  console.log('[cold-start-nudge] Starting…');

  // One overdue task per user: 2+ days overdue in the USER's calendar, no focus
  // session in 48h, nudged fewer than MAX_NUDGES_PER_TASK times. Only users for
  // whom it is SEND_HOUR right now.
  const candidates = await pool.query(`
    WITH u AS (
      SELECT id, COALESCE(NULLIF(timezone, ''), 'America/New_York') AS tz
      FROM users
      WHERE COALESCE(is_qa_user, false) = false
        AND EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'America/New_York')) = $1
    )
    SELECT DISTINCT ON (t.user_id)
      t.id        AS task_id,
      t.title,
      t.user_id,
      u.tz
    FROM tasks t
    JOIN u ON u.id = t.user_id
    WHERE t.is_completed = false
      AND t.due_date IS NOT NULL
      AND t.due_date < (NOW() AT TIME ZONE u.tz)::date - 2
      AND NOT EXISTS (
        SELECT 1 FROM focus_sessions fs
        WHERE fs.task_id = t.id
          AND fs.started_at > NOW() - INTERVAL '48 hours'
      )
      AND (
        SELECT COUNT(*) FROM notification_send_log nl
        WHERE nl.user_id = t.user_id AND nl.notification_key = 'cold_start_' || t.id::text
      ) < $2
    ORDER BY t.user_id, t.due_date ASC
  `, [SEND_HOUR, MAX_NUDGES_PER_TASK]);

  console.log(`[cold-start-nudge] ${candidates.rows.length} candidate tasks found`);

  // Configure push once per run (not per user) — logs the reason if unavailable.
  const { webpush } = configureWebPush('cold-start-nudge');

  let sent = 0;

  for (const row of candidates.rows) {
    const { task_id, title, user_id, tz } = row;
    try {
      const { date: localDate } = getLocalDateParts(tz);

      // Respect daily push cap
      const todayCount = await getTodayNotificationCount(pool, user_id, localDate);
      if (todayCount >= DAILY_PUSH_CAP) continue;

      // Dedup: one cold-start nudge per task per day
      const key = `cold_start_${task_id}`;
      const alreadySent = await wasNotificationSentToday(pool, user_id, key, localDate);
      if (alreadySent) continue;

      const body = `Want one tiny first step to get "${shortTitle(title)}" moving?`;
      // Deep-link to the task itself (where the "I'm stuck" micro-step flow lives)
      // and offer a one-tap "Start focus" — the nudge asks for a first step, so
      // land the user exactly where they can take one.
      const payload = JSON.stringify({
        title: 'FocusLedger',
        body,
        url: `/app/task/${task_id}`,
        tag: `fl-cold-start-${task_id}`,
        renotify: false,
        actions: [{ action: 'focus', title: 'Start focus ⏱' }, { action: 'view', title: 'View' }],
        actionUrls: { focus: `/app/focus/${task_id}`, view: `/app/task/${task_id}` },
      });

      // Web push
      const subscriptions = await getActiveSubscriptions(pool, user_id);
      let deliveries = await sendWebPush(webpush, subscriptions, payload, pool);

      // APNs (iOS)
      deliveries += await sendApnsPush(user_id, payload);

      if (deliveries > 0) {
        await recordNotificationSent(pool, user_id, key, 'cold_start_nudge', localDate);
        sent++;
        console.log(`[cold-start-nudge] Sent for task ${task_id} (user ${user_id})`);
      }
    } catch (err) {
      console.error(`[cold-start-nudge] Error for user ${user_id}:`, err.message);
    }
  }

  console.log(`[cold-start-nudge] Done. Nudges sent: ${sent}`);
}

run().finally(() => pool.end());
