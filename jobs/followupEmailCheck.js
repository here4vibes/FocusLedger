#!/usr/bin/env node
'use strict';
/**
 * jobs/followupEmailCheck.js — Follow-up email automation job.
 * Runs via polsia.toml [[crons]] every 15 minutes.
 *
 * Sends 4 types of follow-up emails for Pro users:
 *   task_reminder    — tasks due today or tomorrow
 *   routine_streak   — active routine with streak ≥ 3 days
 *   weekly_summary   — Mondays at user's preferred hour
 *   follow_through   — tasks 1 day past due, still incomplete
 *
 * All sends respect per-user preferences (enabled/disabled, hour).
 * Timezone-aware: sends only within the user's local hour window.
 * Idempotent: followup_email_log prevents duplicate sends per day.
 */

const { Pool } = require('pg');
const { getLocalDateParts } = require('../lib/timezone');
const { getProUsersWithPrefs } = require('../db/followupEmails');
const {
  getIncompleteTasksDue,
  getActiveStreakRoutines,
  getWeeklyStats,
  getPastDueTasks,
  alreadySentToday,
  alreadySentThisWeek,
  logSent,
} = require('../db/followupEmails');
const { sendEmail } = require('../lib/emailService');
const {
  taskReminderTemplate,
  routineStreakTemplate,
  weeklySummaryTemplate,
  followThroughTemplate,
} = require('../lib/followupEmailTemplates');

// ── Pool factory (standalone job) ─────────────────────────────────────────────

function createPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
    statement_timeout: 20000,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  // e.g. "2026-05-21" → "May 21"
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function getWeekMondayStr(date) {
  // ISO week: Monday as the start
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0) ? -6 : 1 - day; // adjust Sunday to Monday
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function getTomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ── Per-user evaluation ───────────────────────────────────────────────────────

async function evaluateUser(pool, user, now) {
  const { id: userId, email, name } = user;
  const { hour, weekday, date: localDate } = getLocalDateParts(user.timezone, now);

  // ── Task Reminder: due today or tomorrow ─────────────────────────────────────
  if (user.task_reminder && hour === user.task_reminder_hour) {
    const tomorrow = getTomorrowStr();
    const today = localDate;

    for (const dueStr of [tomorrow, today]) {
      const tasks = await getIncompleteTasksDue(pool, userId, dueStr);
      for (const task of tasks.slice(0, 3)) { // cap at 3 per run
        if (await alreadySentToday(pool, userId, 'task_reminder', String(task.id))) continue;

        const when = dueStr === tomorrow ? 'tomorrow' : 'today';
        const { subject, html } = taskReminderTemplate({
          name,
          taskTitle: task.title,
          when,
        });

        sendEmail(pool, { to: email, subject, html, templateType: 'task_reminder', userId })
          .catch(err => console.error(`[followupEmailCheck] task_reminder send failed:`, err.message));

        await logSent(pool, { userId, emailType: 'task_reminder', triggerRef: String(task.id), triggerLabel: task.title, subject });
      }
    }
  }

  // ── Routine Streak Nudge: streak ≥ 3 ─────────────────────────────────────────
  if (user.routine_streak && hour === user.routine_streak_hour) {
    const routines = await getActiveStreakRoutines(pool, userId, 3);
    for (const routine of routines.slice(0, 2)) { // cap at 2 per run
      if (await alreadySentToday(pool, userId, 'routine_streak', String(routine.routine_id))) continue;

      const { subject, html } = routineStreakTemplate({
        name,
        routineName: routine.routine_name,
        streak: routine.current_streak,
      });

      sendEmail(pool, { to: email, subject, html, templateType: 'routine_streak', userId })
        .catch(err => console.error(`[followupEmailCheck] routine_streak send failed:`, err.message));

      await logSent(pool, {
        userId, emailType: 'routine_streak',
        triggerRef: String(routine.routine_id),
        triggerLabel: routine.routine_name,
        subject,
      });
    }
  }

  // ── Weekly Summary: Monday only, once per week ───────────────────────────────
  if (user.weekly_summary && hour === user.weekly_summary_hour && weekday === 'Mon') {
    const weekMonday = getWeekMondayStr(now);
    if (await alreadySentThisWeek(pool, userId, 'weekly_summary', weekMonday)) {
      // already sent this week
    } else {
      const stats = await getWeeklyStats(pool, userId, weekMonday);
      const { subject, html } = weeklySummaryTemplate({
        name,
        tasksDue: parseInt(stats.tasks_due, 10) || 0,
        tasksCompleted: parseInt(stats.tasks_completed, 10) || 0,
      });

      sendEmail(pool, { to: email, subject, html, templateType: 'weekly_summary', userId })
        .catch(err => console.error(`[followupEmailCheck] weekly_summary send failed:`, err.message));

      await logSent(pool, {
        userId, emailType: 'weekly_summary',
        triggerRef: weekMonday,
        triggerLabel: `Week of ${formatDate(weekMonday)}`,
        subject,
      });
    }
  }

  // ── Follow-Through: 1 day past due, still incomplete ──────────────────────────
  if (user.follow_through && hour === user.follow_through_hour) {
    const yesterday = getYesterdayStr();
    const pastDueTasks = await getPastDueTasks(pool, userId, yesterday);
    for (const task of pastDueTasks.slice(0, 3)) { // cap at 3 per run
      if (await alreadySentToday(pool, userId, 'follow_through', String(task.id))) continue;

      const { subject, html } = followThroughTemplate({
        name,
        taskTitle: task.title,
        dueDate: formatDate(task.due_date),
      });

      sendEmail(pool, { to: email, subject, html, templateType: 'follow_through', userId })
        .catch(err => console.error(`[followupEmailCheck] follow_through send failed:`, err.message));

      await logSent(pool, {
        userId, emailType: 'follow_through',
        triggerRef: String(task.id),
        triggerLabel: task.title,
        subject,
      });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (!process.env.RESEND_API_KEY) {
    console.log('[followupEmailCheck] RESEND_API_KEY not set — skipping');
    return;
  }

  const pool = createPool();
  const now = new Date();

  try {
    const users = await getProUsersWithPrefs(pool);
    console.log(`[followupEmailCheck] Evaluating ${users.length} Pro users`);

    let processed = 0;
    let errors = 0;

    for (const user of users) {
      try {
        await evaluateUser(pool, user, now);
        processed++;
      } catch (err) {
        errors++;
        console.error(`[followupEmailCheck] User ${user.id} error:`, err.message);
      }
    }

    console.log(`[followupEmailCheck] Done — ${processed} evaluated, ${errors} errors`);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[followupEmailCheck] Fatal error:', err.message);
  process.exit(1);
});