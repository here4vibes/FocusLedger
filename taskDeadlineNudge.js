'use strict';
/**
 * Task Deadline Nudge Scheduler
 *
 * Runs hourly (render.yaml). Only between 08:00–21:59 user-local time; overdue
 * tasks are nudged for at most MAX_OVERDUE_DAYS days.
 * For each user with active push subscriptions:
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
const { getLocalDateParts } = require('./lib/timezone');
const { sendApnsNotification } = require('./lib/apns-sender');
const { getPushTokens, deletePushToken } = require('./db/push-tokens');
const { configureWebPush } = require('./lib/webpush');

// Pushes only between 08:00 and 21:59 the user's time — an overdue task
// became eligible again at local midnight, so "still waiting" arrived ~00:00.
const QUIET_UNTIL_HOUR = 8;
const QUIET_FROM_HOUR = 22;
// Stop pushing about a task after this many days overdue; Buddy surfaces it
// gently instead of a daily push forever.
const MAX_OVERDUE_DAYS = 3;
const TITLE_MAX = 60;

function shortTitle(title) {
  const t = String(title || '').trim() || 'A task';
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t;
}

/** Push body for the tasks being recorded as notified — it must cover all of them. */
function buildDeadlineBody(tasks) {
  const overdue = tasks.filter(t => t.type === 'overdue');
  const soon = tasks.filter(t => t.type === '1h');
  if (tasks.length === 1) {
    return `"${shortTitle(tasks[0].title)}" — ${overdue.length ? 'still waiting' : 'almost time'}`;
  }
  if (!soon.length) return `${overdue.length} things are still waiting`;
  if (!overdue.length) return `${soon.length} things coming up soon`;
  const lead = overdue[0];
  return `"${shortTitle(lead.title)}" and ${tasks.length - 1} more need you today`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

async function sendTaskDeadlineNudges(pool) {
  const { webpush, apnsEnabled, anyConfigured } = configureWebPush('task-deadline-nudge');
  if (!anyConfigured) return; // reason already logged by configureWebPush

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

    let sentUsers = 0;
    for (const user of usersResult.rows) {
      try {
        const userId = user.id;
        const userTz = user.timezone;
        const { date: localToday, hour: localHour } = getLocalDateParts(userTz, now);
        if (localHour < QUIET_UNTIL_HOUR || localHour >= QUIET_FROM_HOUR) continue;

        // Check daily cap first — cheap query, avoids unnecessary work
        const todayCount = await getTodayNotificationCount(pool, userId, localToday);
        if (todayCount >= DAILY_PUSH_CAP) continue;

        // WHY AT TIME ZONE: due_date is stored as DATE (no timezone). We need to
        // interpret it as midnight in the user's timezone to correctly determine
        // whether a task is overdue or due within 1 hour for that user.
        const tasksResult = await pool.query(`
          SELECT id, title, due_date::text AS due_day, due_time,
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
          const daysOverdue = daysBetween(String(task.due_day).slice(0, 10), localToday);

          if (daysOverdue > MAX_OVERDUE_DAYS) continue;
          // No due_time = "sometime that day": never an 'almost time' push at
          // 23:00 — it only counts once the day has passed.
          if (!task.due_time && daysOverdue < 1) continue;

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

        // Consolidated, gentle, ADHD-friendly — and it names/counts every task
        // recorded below (a mixed push used to silently use up the others).
        const body = buildDeadlineBody(tasksToNotify);

        const notifTitle = 'FocusLedger';
        // Land on the CALM home, not a dense list/detail: a tapped reminder opens
        // the weightless home focused on just that one task (surfaced via ?remind),
        // so you see one thing + a clear next action — not the whole pile, which
        // re-creates the overwhelm the nudge was meant to cut through. "Start focus"
        // stays a deliberate deep-work action into Focus Mode.
        const onlyTask = tasksToNotify.length === 1 ? tasksToNotify[0] : null;
        const notifUrl = onlyTask ? `/weightless?remind=${onlyTask.id}` : '/weightless';
        const notifActions = onlyTask
          ? [{ action: 'focus', title: 'Start focus ⏱' }, { action: 'view', title: 'Open' }]
          : null;
        const notifActionUrls = onlyTask
          ? { focus: `/app/focus/${onlyTask.id}`, view: `/weightless?remind=${onlyTask.id}` }
          : null;
        let sentCount = 0;

        // ── Web Push (VAPID) ──────────────────────────────────────────────
        // WHY tag: browser deduplicates by tag, replacing previous notification silently.
        if (webpush) {
          const payload = JSON.stringify({
            title: notifTitle, body, url: notifUrl,
            tag: 'fl-task-deadline', renotify: false,
            ...(notifActions ? { actions: notifActions, actionUrls: notifActionUrls } : {})
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
                await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(e =>
                  console.error('[TaskDeadlineNudge] stale subscription delete failed:', e.message, '| user:', userId));
              } else {
                console.warn('[TaskDeadlineNudge] Web push error for user', userId,
                  '| status:', sendErr.statusCode, '|', sendErr.message);
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
          sentUsers++;
        }

      } catch (userErr) {
        console.warn('[TaskDeadlineNudge] Error processing user', user.id, ':', userErr.message);
      }
    }
    // Always emit a summary so a quiet run is never a mystery.
    console.log(`[task-deadline-nudge] Done. candidates=${usersResult.rows.length} sent=${sentUsers}`);
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

module.exports = { scheduleTaskDeadlineNudges, sendTaskDeadlineNudges, _internal: { buildDeadlineBody, shortTitle } };
