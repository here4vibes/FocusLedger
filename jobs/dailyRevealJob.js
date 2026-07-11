#!/usr/bin/env node
/**
 * jobs/dailyRevealJob.js — Stage each user's Daily Reveal.
 *
 * The reveal is the retention engine's "give before ask": one new discovery
 * about the user, staged overnight, hidden behind the app open. The headline
 * is a curiosity gap (never gives the answer away — Loewenstein's information
 * gap); the body is the payoff in Buddy's voice, tied to a science-page
 * concept so every reveal reinforces WHY the product works.
 *
 * Runs daily at 09:00 UTC (pre-dawn across US timezones, so the reveal is
 * waiting when the user wakes). For each user active in the last 7 days:
 *   1. Skip if a reveal already exists for their local date (idempotent).
 *   2. Pull the week's tasks / spending / check-ins / focus / streak data.
 *   3. Ask Claude Haiku for {headline, body, science_tag} JSON.
 *   4. If AI fails or output is invalid, build a deterministic reveal from
 *      real data — an active user never wakes to nothing.
 *
 * Never touches is_qa_user accounts. Standalone cron (render.yaml), no
 * in-process scheduling.
 */
'use strict';

const { upsertReveal, revealExists } = require('../db/reveals');
const { getUserLocalDate } = require('../lib/timezone');

const LOOKBACK_DAYS = 7;

// Science-page concepts a reveal may cite (footer: "why this works").
const SCIENCE_TAGS = [
  'avoidance_loops',    // Avoidance loops & task initiation
  'salutogenesis',      // From deficit to coherence
  'cross_domain',       // The FocusLedger loop: cross-domain intelligence
  'accountability',     // Accountability & social commitment
  'executive_function', // Executive function & working memory
  'impulse_spending',   // ADHD & impulsive spending
  'habit_formation',    // Behavioral nudges & habit formation
];

const SYSTEM_PROMPT = `You are Buddy, an ADHD co-pilot inside FocusLedger. Each night you stage the user's "Daily Reveal" — ONE discovery about them, from their real week of data, that they unwrap in the morning.

Return ONLY a JSON object, no other text:
{"headline": "...", "body": "...", "science_tag": "..."}

HEADLINE rules (the curiosity gap — this is shown BEFORE they tap):
- Tease the discovery without giving ANY of it away. No numbers, no conclusions.
- Specific enough to feel personal, open enough to demand the tap.
- Max 60 characters. No emoji.
- Good: "Something about your Tuesdays" / "Your 2pm pattern is real" / "The coffee thing isn't random"
- Bad: "You completed 12 tasks!" (gives it away) / "Your weekly insight" (generic)

BODY rules (the payoff — shown after the tap):
- ONE discovery, 1-3 short sentences, Buddy's voice: direct, warm, real. No manufactured enthusiasm.
- Use real numbers from the data. Cross two life domains when the data supports it.
- End with one tiny concrete thing to try today.
- Never shame. A rough week gets a curious, kind observation — not a pep talk.

science_tag: exactly one of ${JSON.stringify(SCIENCE_TAGS)} — the concept this discovery demonstrates.`;

// ── Data gathering ────────────────────────────────────────────────────────────

async function fetchUserWeek(pool, userId, sinceDate) {
  const [tasks, expenses, checkins, focus, streaks] = await Promise.all([
    pool.query(
      `SELECT title, is_completed, completed_at::date AS completed_date,
              EXTRACT(DOW  FROM completed_at) AS completed_dow,
              EXTRACT(HOUR FROM completed_at) AS completed_hour
       FROM tasks
       WHERE user_id = $1 AND (completed_at >= $2 OR created_at >= $2)
       ORDER BY created_at DESC LIMIT 40`,
      [userId, sinceDate]
    ),
    pool.query(
      `SELECT e.amount, e.is_impulse, e.expense_date, c.name AS category_name
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.user_id = $1 AND e.expense_date >= $2
       ORDER BY e.expense_date DESC LIMIT 40`,
      [userId, sinceDate]
    ),
    pool.query(
      `SELECT checkin_type, mood, checkin_date
       FROM buddy_checkins
       WHERE user_id = $1 AND checkin_date >= $2
       ORDER BY checkin_date DESC LIMIT 14`,
      [userId, sinceDate]
    ),
    pool.query(
      `SELECT actual_duration_seconds, completed, started_at::date AS session_date
       FROM focus_sessions
       WHERE user_id = $1 AND started_at >= $2
       ORDER BY started_at DESC LIMIT 20`,
      [userId, sinceDate]
    ),
    pool.query(
      `SELECT rs.current_streak, rs.best_streak, r.name AS routine_name
       FROM routine_streaks rs JOIN routines r ON r.id = rs.routine_id
       WHERE rs.user_id = $1 AND r.is_active = true
       ORDER BY rs.current_streak DESC LIMIT 3`,
      [userId]
    ),
  ]);
  return {
    tasks: tasks.rows, expenses: expenses.rows, checkins: checkins.rows,
    focus: focus.rows, streaks: streaks.rows,
  };
}

function summariseForPrompt({ tasks, expenses, checkins, focus, streaks }) {
  const lines = [];
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const completed = tasks.filter(t => t.is_completed);
  if (tasks.length) {
    lines.push(`TASKS: ${completed.length} completed / ${tasks.length} total this week`);
    const byDow = {};
    for (const t of completed) {
      if (t.completed_dow != null) {
        const d = DOW[Number(t.completed_dow)];
        byDow[d] = (byDow[d] || 0) + 1;
      }
    }
    const dows = Object.entries(byDow);
    if (dows.length) lines.push(`  Completions by weekday: ${dows.map(([d, c]) => `${d}=${c}`).join(', ')}`);
    const byHour = {};
    for (const t of completed) {
      if (t.completed_hour != null) {
        const h = Number(t.completed_hour);
        byHour[h] = (byHour[h] || 0) + 1;
      }
    }
    const topHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
    if (topHour && topHour[1] >= 2) lines.push(`  Most productive hour: ${topHour[0]}:00 (${topHour[1]} completions)`);
  }

  if (expenses.length) {
    const impulse = expenses.filter(e => e.is_impulse === true);
    const total = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    lines.push(`SPENDING: ${expenses.length} transactions, $${total.toFixed(0)} total, ${impulse.length} impulse`);
    const impulseTotal = impulse.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    if (impulse.length) lines.push(`  Impulse total: $${impulseTotal.toFixed(0)}`);
  }

  if (checkins.length) {
    const moods = checkins.filter(c => c.mood).map(c => `${c.checkin_date}:${c.mood}`);
    lines.push(`CHECK-INS: ${checkins.length} this week${moods.length ? ` | moods: ${moods.join(', ')}` : ''}`);
  }

  if (focus.length) {
    const mins = focus.reduce((s, f) => s + Math.round((f.actual_duration_seconds || 0) / 60), 0);
    lines.push(`FOCUS: ${focus.length} sessions, ${mins} minutes total, ${focus.filter(f => f.completed).length} completed`);
  }

  if (streaks.length) {
    lines.push(`STREAKS: ${streaks.map(s => `"${s.routine_name}"=${s.current_streak}d (best ${s.best_streak})`).join(', ')}`);
  }

  return lines.join('\n');
}

// ── AI reveal ─────────────────────────────────────────────────────────────────

function parseRevealJson(text) {
  // Haiku may wrap JSON in prose or fences — extract the first {...} block.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj;
  try { obj = JSON.parse(match[0]); } catch { return null; }
  if (!obj.headline || !obj.body) return null;
  const headline = String(obj.headline).trim().slice(0, 80);
  const body = String(obj.body).trim();
  if (headline.length < 5 || body.length < 20) return null;
  const scienceTag = SCIENCE_TAGS.includes(obj.science_tag) ? obj.science_tag : 'cross_domain';
  return { headline, body, scienceTag, revealType: 'insight' };
}

async function generateAiReveal(userContext) {
  // Lazy require — keeps the module importable (tests, environments without
  // the SDK); the AI path is already gated on ANTHROPIC_API_KEY in run().
  const { complete } = require('../lib/claude-client');
  const text = await complete({
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Here is this user's week:\n\n${userContext}\n\nStage tonight's Daily Reveal as JSON.`,
    }],
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 300,
  });
  return parseRevealJson(text);
}

// ── Deterministic fallback ────────────────────────────────────────────────────
// Built from real data so a reveal is never a horoscope. Ordered by how
// surprising each discovery tends to feel. Returns null only when the user
// has no usable data at all.

function buildFallbackReveal({ tasks, expenses, checkins, focus, streaks }) {
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const completed = (tasks || []).filter(t => t.is_completed);

  // 1. Weekday concentration — "your Tuesdays" is the archetype reveal.
  const byDow = {};
  for (const t of completed) {
    if (t.completed_dow != null) {
      const d = Number(t.completed_dow);
      byDow[d] = (byDow[d] || 0) + 1;
    }
  }
  const topDow = Object.entries(byDow).sort((a, b) => b[1] - a[1])[0];
  if (topDow && topDow[1] >= 3 && completed.length >= 5) {
    const day = DOW[Number(topDow[0])];
    const share = Math.round((topDow[1] / completed.length) * 100);
    return {
      headline: `Something about your ${day}s`,
      body: `${share}% of everything you finished this week happened on a ${day}. That's not luck — that's a rhythm. Try putting tomorrow's hardest task where your momentum already lives.`,
      scienceTag: 'habit_formation',
      revealType: 'pattern',
    };
  }

  // 2. Check-in ↔ completion link — the cross-domain classic.
  const checkinDates = new Set((checkins || []).map(c => String(c.checkin_date).slice(0, 10)));
  if (checkinDates.size >= 2 && completed.length >= 4) {
    const onCheckinDays = completed.filter(t =>
      t.completed_date && checkinDates.has(String(t.completed_date).slice(0, 10))
    ).length;
    const share = Math.round((onCheckinDays / completed.length) * 100);
    if (share >= 60) {
      return {
        headline: 'The check-in thing is measurable now',
        body: `${share}% of your completed tasks this week landed on days you checked in with me. Five minutes of morning contact seems to be your highest-leverage habit. Worth protecting.`,
        scienceTag: 'cross_domain',
        revealType: 'insight',
      };
    }
  }

  // 3. Impulse-free stretch — money reveal, salutogenic frame.
  const exp = expenses || [];
  if (exp.length >= 5) {
    const impulse = exp.filter(e => e.is_impulse === true);
    const planned = exp.filter(e => e.is_impulse === false);
    if (planned.length >= 4 && impulse.length <= 1) {
      return {
        headline: 'Your money did something quiet this week',
        body: `${planned.length} planned purchases, ${impulse.length === 0 ? 'zero' : 'just one'} impulse. That's your prefrontal cortex winning the week — notice what was different, because it's repeatable.`,
        scienceTag: 'impulse_spending',
        revealType: 'insight',
      };
    }
  }

  // 4. Focus minutes — effort made visible.
  const mins = (focus || []).reduce((s, f) => s + Math.round((f.actual_duration_seconds || 0) / 60), 0);
  if (mins >= 60) {
    return {
      headline: 'You built more than you think this week',
      body: `${mins} minutes of deep focus across ${focus.length} sessions. ADHD brains rarely get credit for invisible effort — here's yours, counted. One more session today keeps the thread.`,
      scienceTag: 'executive_function',
      revealType: 'stat',
    };
  }

  // 5. Streak status — always available if any routine is alive.
  const topStreak = (streaks || [])[0];
  if (topStreak && topStreak.current_streak >= 2) {
    return {
      headline: `"${topStreak.routine_name}" is quietly compounding`,
      body: `${topStreak.current_streak} days in a row now${topStreak.current_streak >= topStreak.best_streak ? " — that's your best run yet" : ` (best: ${topStreak.best_streak})`}. Consistency you don't have to think about is the whole point. Keep it boring.`,
      scienceTag: 'habit_formation',
      revealType: 'stat',
    };
  }

  // 6. Bare minimum — any completions at all get an honest count.
  if (completed.length >= 1) {
    return {
      headline: 'One number from your week',
      body: `${completed.length} task${completed.length === 1 ? '' : 's'} finished this week. Not a judgment — a baseline. Tomorrow's reveal gets more interesting the more the app sees.`,
      scienceTag: 'salutogenesis',
      revealType: 'stat',
    };
  }

  return null; // genuinely nothing to say — stage no reveal rather than a hollow one
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const { Pool } = require('pg'); // lazy — keeps pure functions testable without pg installed
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });

  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const sinceDate = since.toISOString().slice(0, 10);

  try {
    const { rows: users } = await pool.query(
      `SELECT u.id, COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone
       FROM users u
       WHERE u.is_qa_user IS NOT TRUE
         AND (
           EXISTS (SELECT 1 FROM tasks          WHERE user_id = u.id AND created_at   >= $1)
           OR EXISTS (SELECT 1 FROM expenses       WHERE user_id = u.id AND expense_date >= $2)
           OR EXISTS (SELECT 1 FROM buddy_checkins WHERE user_id = u.id AND checkin_date >= $2)
         )`,
      [since.toISOString(), sinceDate]
    );

    console.log(`[daily-reveal] candidates=${users.length}`);

    let ai = 0, fallback = 0, skipped = 0, empty = 0;
    for (const user of users) {
      try {
        const localDate = getUserLocalDate(user.timezone);
        if (await revealExists(pool, user.id, localDate)) { skipped++; continue; }

        const data = await fetchUserWeek(pool, user.id, sinceDate);

        let reveal = null;
        if (process.env.ANTHROPIC_API_KEY) {
          try {
            reveal = await generateAiReveal(summariseForPrompt(data));
          } catch (aiErr) {
            console.warn(`[daily-reveal] AI failed user=${user.id}:`, aiErr.message, '— using fallback');
          }
        }

        if (reveal) { ai++; } else {
          reveal = buildFallbackReveal(data);
          if (reveal) fallback++;
        }

        if (!reveal) { empty++; continue; }

        await upsertReveal(pool, {
          userId: user.id,
          revealDate: localDate,
          headline: reveal.headline,
          body: reveal.body,
          scienceTag: reveal.scienceTag,
          revealType: reveal.revealType,
        });
      } catch (userErr) {
        console.error(`[daily-reveal] Error user=${user.id}:`, userErr.message);
      }
    }

    console.log(`[daily-reveal] Done. ai=${ai} fallback=${fallback} skipped=${skipped} no_data=${empty} total=${users.length}`);
  } catch (err) {
    console.error('[daily-reveal] Fatal:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Export pure functions for tests; only run when invoked as a script.
module.exports = { buildFallbackReveal, parseRevealJson, summariseForPrompt, SCIENCE_TAGS };
if (require.main === module) run();
