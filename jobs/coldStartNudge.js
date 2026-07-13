#!/usr/bin/env node
/**
 * jobs/coldStartNudge.js — Daily job (9 AM UTC via render.yaml).
 *
 * Finds tasks that are 2+ days overdue with no focus session in the last 48 hours
 * and sends one proactive push nudge: "Want one tiny first step to get [Task] moving?"
 *
 * Limits: 1 cold-start push per user per day; respects the global daily push cap (3).
 * Dedup key: cold_start_{task_id} — prevents repeat nudges for the same task on the same day.
 */
'use strict';

// dotenv is not an installed dependency — requiring it crashes the job with
// MODULE_NOT_FOUND. Render injects env vars directly.
const { Pool } = require('pg');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const {
  DAILY_PUSH_CAP,
  getTodayNotificationCount,
  wasNotificationSentToday,
  recordNotificationSent,
  getActiveSubscriptions,
  deleteSubscriptionByEndpoint,
} = require('../db/notifications');
const { isApnsConfigured, sendApnsNotification } = require('../lib/apns-sender');
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

async function sendWebPush(subscriptions, payload, pool) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return 0;
  let webpush;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(
      'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch {
    return 0;
  }
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
        await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(() => {});
      }
    }
  }
  return sent;
}

async function sendApnsPush(userId, payload) {
  if (!isApnsConfigured()) return 0;
  const tokens = await getPushTokens(pool, userId).catch(() => []);
  if (!tokens.length) return 0;
  // sendApnsNotification expects { title, body, url } — NOT a raw aps envelope
  // (it builds the aps alert itself). Passing an aps-shaped object dropped the
  // title/body and hard-coded url to /app. Forward the real payload fields.
  const parsed = JSON.parse(payload);
  const { sent } = await sendApnsNotification(
    tokens.map(t => t.token),
    { title: parsed.title, body: parsed.body, url: parsed.url },
    async (invalidToken) => { await deletePushToken(pool, invalidToken).catch(() => {}); }
  );
  return sent;
}

async function run() {
  console.log('[cold-start-nudge] Starting…');

  // Find overdue tasks with no recent focus session, one per user max
  const candidates = await pool.query(`
    SELECT DISTINCT ON (t.user_id)
      t.id        AS task_id,
      t.title,
      t.user_id,
      t.due_date
    FROM tasks t
    WHERE t.is_completed = false
      AND t.due_date IS NOT NULL
      AND t.due_date < CURRENT_DATE - INTERVAL '2 days'
      AND NOT EXISTS (
        SELECT 1 FROM focus_sessions fs
        WHERE fs.task_id = t.id
          AND fs.started_at > NOW() - INTERVAL '48 hours'
      )
    ORDER BY t.user_id, t.due_date ASC
  `);

  console.log(`[cold-start-nudge] ${candidates.rows.length} candidate tasks found`);

  let sent = 0;

  for (const row of candidates.rows) {
    const { task_id, title, user_id } = row;
    try {
      const tz = await fetchUserTimezone(pool, user_id);
      const localDate = getUserLocalDate(tz || 'America/New_York');

      // Respect daily push cap
      const todayCount = await getTodayNotificationCount(pool, user_id, localDate);
      if (todayCount >= DAILY_PUSH_CAP) continue;

      // Dedup: one cold-start nudge per task per day
      const key = `cold_start_${task_id}`;
      const alreadySent = await wasNotificationSentToday(pool, user_id, key, localDate);
      if (alreadySent) continue;

      const body = `Want one tiny first step to get "${title.slice(0, 50)}" moving?`;
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
      let deliveries = await sendWebPush(subscriptions, payload, pool);

      // APNs (iOS)
      deliveries += await sendApnsPush(user_id, payload);

      if (deliveries > 0) {
        await recordNotificationSent(pool, user_id, key, 'cold_start_nudge', localDate);
        sent++;
        console.log(`[cold-start-nudge] Sent for task ${task_id} (user ${user_id}): "${title.slice(0, 40)}"`);
      }
    } catch (err) {
      console.error(`[cold-start-nudge] Error for user ${user_id}:`, err.message);
    }
  }

  console.log(`[cold-start-nudge] Done. Nudges sent: ${sent}`);
}

run().finally(() => pool.end());
