#!/usr/bin/env node
/**
 * jobs/crossDomainInsightsJob.js — Nightly cross-domain intelligence pass.
 *
 * For each user active in the last 7 days, pulls tasks + expenses + check-ins
 * + focus sessions, then asks Claude Haiku to identify ONE specific cross-domain
 * behavioral pattern and state it as an actionable observation.
 *
 * Output lands in cross_domain_insights (one row per user per week_start).
 * Buddy surfaces the insight at session start via buildGreetingContext().
 *
 * Safe to re-run — UPSERT overwrites if Claude produces a better insight.
 * Never touches is_qa_user accounts.
 */
'use strict';

const { Pool } = require('pg');
const { complete } = require('../lib/claude-client');
const { saveCrossDomainInsight } = require('../db/insights');

const LOOKBACK_DAYS = 7;

// Monday of the current UTC week (ISO week start)
function getWeekStart() {
  const d = new Date();
  const dow = d.getUTCDay(); // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

const SYSTEM_PROMPT = `You are Buddy, an ADHD co-pilot. Your job: find ONE non-obvious cross-domain pattern in the user's week and state it as a kind, specific, actionable observation.

Rules:
- ONE insight only — one or two short sentences max
- Must cross at least two different life areas (tasks + spending, tasks + focus, check-ins + tasks, etc.)
- Use real numbers when they're meaningful
- End with something concrete they can try
- Never shame — always curious and supportive
- No preamble ("I noticed that...", "Based on your data...") — start with the insight itself

Good example: "Your task completion rate triples on days you log a morning check-in — a 5-minute check-in with me might be your highest-ROI habit this week."
Bad example: "You've been busy this week! Great work."`;

async function fetchUserData(pool, userId, sinceDate) {
  const [tasks, expenses, checkins, focus] = await Promise.all([
    pool.query(
      `SELECT title, is_completed, completed_at::date AS completed_date,
              EXTRACT(HOUR FROM completed_at AT TIME ZONE 'UTC') AS completed_hour
       FROM tasks
       WHERE user_id = $1
         AND (completed_at >= $2 OR created_at >= $2)
       ORDER BY created_at DESC
       LIMIT 40`,
      [userId, sinceDate]
    ),
    pool.query(
      `SELECT e.amount, e.is_impulse, e.expense_date,
              c.name AS category_name
       FROM expenses e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.user_id = $1 AND e.expense_date >= $2
       ORDER BY e.expense_date DESC
       LIMIT 40`,
      [userId, sinceDate]
    ),
    pool.query(
      `SELECT checkin_type, mood, checkin_date
       FROM buddy_checkins
       WHERE user_id = $1 AND checkin_date >= $2
       ORDER BY checkin_date DESC
       LIMIT 14`,
      [userId, sinceDate]
    ),
    pool.query(
      `SELECT planned_duration_seconds, actual_duration_seconds,
              completed, started_at::date AS session_date
       FROM focus_sessions
       WHERE user_id = $1 AND started_at >= $2
       ORDER BY started_at DESC
       LIMIT 20`,
      [userId, sinceDate]
    ),
  ]);

  return {
    tasks: tasks.rows,
    expenses: expenses.rows,
    checkins: checkins.rows,
    focus: focus.rows,
  };
}

function summariseForPrompt({ tasks, expenses, checkins, focus }) {
  const lines = [];

  if (tasks.length > 0) {
    const completed = tasks.filter(t => t.is_completed);
    const completedCount = completed.length;
    lines.push(`TASKS (last 7 days): ${completedCount} completed, ${tasks.length - completedCount} still pending`);

    // Per-day completion map
    const byDay = {};
    for (const t of completed) {
      if (t.completed_date) byDay[t.completed_date] = (byDay[t.completed_date] || 0) + 1;
    }
    const dayEntries = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
    if (dayEntries.length > 0) {
      lines.push(`  By day: ${dayEntries.map(([d, c]) => `${d}=${c}`).join(', ')}`);
    }
  }

  if (expenses.length > 0) {
    const impulseCount = expenses.filter(e => e.is_impulse === true).length;
    // expenses.amount is NUMERIC (string from pg) — accumulate as integer cents
    const toCents = (a) => Math.round(parseFloat(a || 0) * 100) || 0;
    const totalCents = expenses.reduce((s, e) => s + toCents(e.amount), 0);
    lines.push(`SPENDING (last 7 days): ${expenses.length} transactions, $${(totalCents / 100).toFixed(0)} total, ${impulseCount} impulse`);

    const byDay = {};
    for (const e of expenses) {
      const d = String(e.expense_date).slice(0, 10);
      byDay[d] = (byDay[d] || 0) + toCents(e.amount);
    }
    const dayEntries = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
    if (dayEntries.length > 0) {
      lines.push(`  By day: ${dayEntries.map(([d, c]) => `${d}=$${(c / 100).toFixed(0)}`).join(', ')}`);
    }
  }

  if (checkins.length > 0) {
    const mornings = checkins.filter(c => c.checkin_type === 'morning').length;
    const evenings = checkins.filter(c => c.checkin_type === 'evening').length;
    const moodList = checkins.filter(c => c.mood).map(c => c.mood);
    lines.push(`CHECK-INS (last 7 days): ${mornings} morning, ${evenings} evening`);
    if (moodList.length > 0) lines.push(`  Moods logged: ${moodList.join(', ')}`);
  }

  if (focus.length > 0) {
    const completedSessions = focus.filter(s => s.completed).length;
    const totalMins = focus.reduce((s, f) => s + Math.round((f.actual_duration_seconds || 0) / 60), 0);
    lines.push(`FOCUS SESSIONS (last 7 days): ${focus.length} started, ${completedSessions} completed, ${totalMins} total minutes`);
  }

  return lines.join('\n');
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });

  const weekStart = getWeekStart();
  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const sinceDate = since.toISOString().slice(0, 10);

  try {
    // Active users with no insight yet this week (excludes QA user)
    const { rows: users } = await pool.query(
      `SELECT DISTINCT u.id
       FROM users u
       WHERE u.is_qa_user IS NOT TRUE
         AND (
           EXISTS (SELECT 1 FROM tasks       WHERE user_id = u.id AND created_at   >= $1)
           OR EXISTS (SELECT 1 FROM expenses  WHERE user_id = u.id AND expense_date >= $2)
           OR EXISTS (SELECT 1 FROM buddy_checkins WHERE user_id = u.id AND checkin_date >= $2)
         )
         AND NOT EXISTS (
           SELECT 1 FROM cross_domain_insights WHERE user_id = u.id AND week_start = $3
         )`,
      [since.toISOString(), sinceDate, weekStart]
    );

    console.log(`[cross-domain-insights] week=${weekStart}, candidates=${users.length}`);

    let ok = 0;
    let skipped = 0;
    for (const { id: userId } of users) {
      try {
        const data = await fetchUserData(pool, userId, sinceDate);

        // Require data from at least 2 different domains for a meaningful cross-domain insight
        const activeDomains = [
          data.tasks.length > 0,
          data.expenses.length > 0,
          data.checkins.length > 0,
          data.focus.length > 0,
        ].filter(Boolean).length;

        if (activeDomains < 2) { skipped++; continue; }

        const userContext = summariseForPrompt(data);
        const insightText = await complete({
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: `Here is this user's data for the past 7 days:\n\n${userContext}\n\nGenerate one cross-domain insight.`,
            },
          ],
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 150,
        });

        await saveCrossDomainInsight(pool, userId, weekStart, insightText);
        ok++;
        console.log(`[cross-domain-insights] OK user=${userId}`);
      } catch (err) {
        console.error(`[cross-domain-insights] Error user=${userId}:`, err.message);
      }
    }

    console.log(`[cross-domain-insights] Done. generated=${ok} skipped=${skipped} total=${users.length}`);
  } catch (err) {
    console.error('[cross-domain-insights] Fatal:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
