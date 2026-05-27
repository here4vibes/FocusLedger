'use strict';
/**
 * Task Deadline Nudge Scheduler
 *
 * Runs every 15 minutes. For each user with active push subscriptions:
 *   1. Fetches the user's timezone and computes "today" in their local time.
 *   2. Finds tasks due within 1 hour or overdue (using user's local timezone).
 *   3. Checks notification_send_log — skips tasks already notified today (user's local date).
 *   4. Respects daily cap of 3 push notifications per user.
 *   5. Sends one consolidated notification per user (not per task).
 *
 * Idempotent — notification_send_log UNIQUE constraint prevents double sends.
 */

const {
  DAILY_PUSH_CAP,
  wasNotificationSentToday,
  getTodayNotificationCount,
  recordNotificationSent,
  getActiveSubscriptions,
  deleteSubscriptionByEndpoint,
} = require('./db/notifications');
const { getUserLocalDate } = require('./lib/timezone');
const { sendApnsNotification, isApnsConfigured } = require('./lib/apns-sender');
const { getPushTokens, deletePushToken } = require('./db/push-tokens');

async function sendTaskDeadlineNudges(pool) {
  const webPushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const apnsEnabled = isApnsConfigured();
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
    } catch {
      webpush = null;
    }
  }

  const now = new Date();

  try {
    // Get all users with active push subscriptions OR APNs tokens + their timezone
    const usersResult = await pool.query(`
      SELECT DISTINCT u.id, COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone
      FROM users u
      WHERE u.id IN (
        SELECT user_id FROM push_subscriptions WHERE enabled = true
        UNION
        SELECT user_id FROM push_tokens
      )
    `);

    for (const user of usersResult.rows) {
      try {
        const userId = user.id;
        const userTz = user.timezone;
        const localToday = getUserLocalDate(userTz, now);

        // Check daily cap first — cheap query, avoids unnecessary work
        const todayCount = await getTodayNotificationCount(pool, userId, localToday);
        if (todayCount >= DAILY_PUSH_CAP) continue;

        // WHY AT TIME ZONE: due_date is stored as DATE (no timezone). We need to
        // interpret it as midnight in the user's timezone to correctly determine
        // whether a task is overdue or due within 1 hour for that user.
        const tasksResult = await pool.query(`
          SELECT id, title, due_date, due_time,
            CASE
              WHEN due_time IS NOT NULL
                THEN (due_date::date + due_time::time) AT TIME ZONE $2
              ELSE (due_date::date + TIME '23:59:59') AT TIME ZONE $2
            END AS due_at
          FROM tasks
          WHERE user_id = $1
            AND is_completed = false
            AND due_date IS NOT NULL
          ORDER BY due_date ASC, due_time ASC NULLS LAST
        `, [userId, userTz]);

        // Filter to tasks that are overdue or due within 1 hour
        const urgentTasks = [];
        for (const task of tasksResult.rows) {
          const dueAt = new Date(task.due_at);
          const msUntilDue = dueAt - now;
          const hoursUntilDue = msUntilDue / (1000 * 60 * 60);

          if (msUntilDue < 0 || hoursUntilDue <= 1) {
            const key = `task:${task.id}`;
            const alreadySent = await wasNotificationSentToday(pool, userId, key, localToday);
            if (!alreadySent) {
              urgentTasks.push({
                id: task.id,
                title: task.title,
                type: msUntilDue < 0 ? 'overdue' : '1h'
              });
            }
          }
        }

        if (urgentTasks.length === 0) continue;

        // Respect daily cap — only send up to remaining allowance
        const remaining = DAILY_PUSH_CAP - todayCount;
        const tasksToNotify = urgentTasks.slice(0, remaining);

        // Build notification payload — consolidated, gentle, ADHD-friendly
        const overdueCount = tasksToNotify.filter(t => t.type === 'overdue').length;
        const urgentCount = tasksToNotify.filter(t => t.type === '1h').length;

        let body;
        if (overdueCount > 0 && overdueCount === 1) {
          body = `"${tasksToNotify.find(t => t.type === 'overdue').title}" — still waiting`;
        } else if (overdueCount > 1) {
          body = `${overdueCount} things are still waiting`;
        } else if (urgentCount === 1) {
          body = `"${tasksToNotify.find(t => t.type === '1h').title}" — almost time`;
        } else {
          body = `${urgentCount} things coming up soon`;
        }

        const notifTitle = 'FocusLedger';
        const notifUrl   = '/app';
        let sentCount = 0;

        // ── Web Push (VAPID) ──────────────────────────────────────────────
        // WHY tag: browser deduplicates by tag, replacing previous notification silently.
        if (webpush) {
          const payload = JSON.stringify({
            title: notifTitle, body, url: notifUrl,
            tag: 'fl-task-deadline', renotify: false
          });
          const subscriptions = await getActiveSubscriptions(pool, userId);
          for (const row of subscriptions) {
            try {
              const sub = typeof row.subscription === 'string'
                ? JSON.parse(row.subscription) : row.subscription;
              await webpush.sendNotification(sub, payload);
              sentCount++;
            } catch (sendErr) {
              if (sendErr.statusCode === 410 || sendErr.statusCode === 404) {
                await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(() => {});
              } else {
                console.warn('[TaskDeadlineNudge] Web push error for user', userId, sendErr.message);
              }
            }
          }
        }

        // ── APNs (iOS / Capacitor) ────────────────────────────────────────
        if (apnsEnabled) {
          const iosTokenRows = await getPushTokens(pool, userId);
          if (iosTokenRows.length > 0) {
            const tokens = iosTokenRows.map(r => r.token);
            const { sent } = await sendApnsNotification(
              tokens,
              { title: notifTitle, body, url: notifUrl },
              (invalidToken) => deletePushToken(pool, invalidToken)
            );
            sentCount += sent;
          }
        }

        // Record all notified tasks in the log — prevents re-sending today
        if (sentCount > 0) {
          for (const task of tasksToNotify) {
            await recordNotificationSent(pool, userId, `task:${task.id}`, 'task_deadline', localToday);
          }
          console.log(`[TaskDeadlineNudge] Sent to user ${userId}: ${tasksToNotify.length} tasks`);
        }

      } catch (userErr) {
        console.warn('[TaskDeadlineNudge] Error processing user', user.id, ':', userErr.message);
      }
    }
  } catch (err) {
    console.error('[TaskDeadlineNudge] Fatal error:', err.message);
  }
}

/**
 * scheduleTaskDeadlineNudges(pool)
 * Call once at server startup. Runs sendTaskDeadlineNudges every 15 minutes.
 * Idempotent — duplicate runs are no-ops for already-notified tasks.
 */
function scheduleTaskDeadlineNudges(pool) {
  const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  // First run after a short delay (let server finish booting)
  setTimeout(() => {
    sendTaskDeadlineNudges(pool).catch(err =>
      console.error('[TaskDeadlineNudge] Startup run error:', err.message)
    );
  }, 30 * 1000);

  setInterval(() => {
    sendTaskDeadlineNudges(pool).catch(err =>
      console.error('[TaskDeadlineNudge] Scheduled run error:', err.message)
    );
  }, INTERVAL_MS);

  console.log('[TaskDeadlineNudge] Scheduler started — checking every 15 minutes');
}

module.exports = { scheduleTaskDeadlineNudges, sendTaskDeadlineNudges };
