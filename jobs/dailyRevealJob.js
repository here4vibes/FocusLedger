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
- If INTERESTS are listed, weaving one in makes the insight feel personal — do it when natural, never force it.
- End with one tiny concrete thing to try today.
- Never shame. A rough week gets a curious, kind observation — not a pep talk.

science_tag: exactly one of ${JSON.stringify(SCIENCE_TAGS)} — the concept this discovery demonstrates.`;

const INTEREST_PROMPT = `You are Buddy, an ADHD co-pilot inside FocusLedger. Tonight's Daily Reveal is an INTEREST reveal: a delightful, surprising discovery connected to something this user demonstrably loves (evidence from their own tasks and spending is provided).

Return ONLY a JSON object, no other text:
{"headline": "...", "body": "...", "science_tag": "..."}

The reveal can be:
- a genuinely surprising, TRUE fact about their interest domain, or
- a connection between their interest and how brains/habits/money work, or
- a connection between their interest and their own week.

HEADLINE: curiosity gap, max 60 chars, no emoji, must not give the payoff away. Reference the interest obliquely ("The climbing thing goes deeper") not generically ("Your interest reveal").
BODY: 1-3 short sentences, Buddy's voice — like a friend who shares your obsession. Accurate; never invent statistics. May end with a tiny nudge to enjoy the interest today.
science_tag: one of ${JSON.stringify(SCIENCE_TAGS)} if one genuinely fits, otherwise "none".`;

// ── Interest detection ────────────────────────────────────────────────────────
// Interests are gleaned ONLY from this wholesome whitelist — detection can
// never tag anything sensitive (health, finances, relationships) because no
// such keywords exist in the map.
const INTEREST_KEYWORDS = {
  fitness:  ['gym', 'workout', 'yoga', 'pilates', 'lifting', 'crossfit', 'running', ' run ', '5k', '10k', 'climbing', 'boulder', 'cycling', 'peloton', 'swim'],
  cooking:  ['cook', 'recipe', 'bake', 'baking', 'meal prep', 'sourdough', 'grill', 'kitchenaid'],
  gaming:   ['gaming', 'video game', 'steam', 'playstation', 'nintendo', 'xbox', 'twitch', 'd&d', 'dungeons'],
  music:    ['guitar', 'piano', 'drums', 'violin', 'band practice', 'concert', 'vinyl', 'record store', 'ukulele'],
  outdoors: ['hike', 'hiking', 'trail', 'camping', 'campsite', 'fishing', 'kayak', 'garden', 'gardening', 'birdwatch'],
  reading:  ['book', 'reading', 'library', 'kindle', 'audible', 'bookstore', 'book club'],
  pets:     ['dog', 'cat ', 'vet ', 'petco', 'petsmart', 'chewy', 'groomer', 'dog park', 'kitten', 'puppy'],
  travel:   ['flight', 'airline', 'hotel', 'airbnb', 'passport', 'road trip', 'itinerary'],
  coffee:   ['coffee', 'espresso', 'cafe', 'roaster', 'latte'],
  making:   ['knit', 'crochet', 'sewing', 'woodwork', '3d print', 'lego', 'paint', 'pottery', 'model kit'],
};

/**
 * Derive stable interests from task titles + expense descriptions/categories.
 * @param {Array<{text: string}>} corpus — lowercase-able text items
 * @returns {Array<{tag: string, count: number, evidence: string[]}>} top 3, count >= 3
 */
function deriveInterests(corpus) {
  const hits = {};
  for (const item of corpus || []) {
    const text = ` ${String(item.text || '').toLowerCase()} `;
    if (!text.trim()) continue;
    for (const [tag, keywords] of Object.entries(INTEREST_KEYWORDS)) {
      if (keywords.some(k => text.includes(k))) {
        if (!hits[tag]) hits[tag] = { tag, count: 0, evidence: [] };
        hits[tag].count++;
        const snippet = String(item.text).trim().slice(0, 40);
        if (hits[tag].evidence.length < 3 && !hits[tag].evidence.includes(snippet)) {
          hits[tag].evidence.push(snippet);
        }
      }
    }
  }
  return Object.values(hits)
    .filter(h => h.count >= 3) // one-offs aren't interests
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

async function fetchInterestCorpus(pool, userId) {
  // Interests need a wider window than the weekly reveal data — 90 days gives
  // stable signal instead of whatever last week happened to contain.
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceStr = since.toISOString().slice(0, 10);
  const [tasks, expenses] = await Promise.all([
    pool.query(
      `SELECT title AS text FROM tasks
       WHERE user_id = $1 AND created_at >= $2 AND title IS NOT NULL
       ORDER BY created_at DESC LIMIT 200`,
      [userId, sinceStr]
    ),
    pool.query(
      `SELECT COALESCE(e.description, '') || ' ' || COALESCE(c.name, '') AS text
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.user_id = $1 AND e.expense_date >= $2
       ORDER BY e.expense_date DESC LIMIT 200`,
      [userId, sinceStr]
    ),
  ]);
  return [...tasks.rows, ...expenses.rows];
}

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
    // NUMERIC comes back as a string — accumulate as integer cents, never float-sum money
    const toCents = (a) => Math.round(parseFloat(a || 0) * 100) || 0;
    const totalCents = expenses.reduce((s, e) => s + toCents(e.amount), 0);
    lines.push(`SPENDING: ${expenses.length} transactions, $${(totalCents / 100).toFixed(0)} total, ${impulse.length} impulse`);
    const impulseCents = impulse.reduce((s, e) => s + toCents(e.amount), 0);
    if (impulse.length) lines.push(`  Impulse total: $${(impulseCents / 100).toFixed(0)}`);
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

function interestsLine(interests) {
  if (!interests || !interests.length) return '';
  return 'INTERESTS (gleaned from their tasks & spending): ' + interests
    .map(i => `${i.tag} (${i.count} signals, e.g. ${i.evidence.map(e => `"${e}"`).join(', ')})`)
    .join('; ');
}

// ── AI reveal ─────────────────────────────────────────────────────────────────

function parseRevealJson(text, opts) {
  const { defaultScienceTag = 'cross_domain', revealType = 'insight' } = opts || {};
  // Haiku may wrap JSON in prose or fences — extract the first {...} block.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch (e) {
    // Parse failure feeds the deterministic fallback, but must be visible in
    // Render logs — a persistent AI-format regression is otherwise undiagnosable.
    console.warn('[daily-reveal] AI JSON parse failed:', e.message, '| raw:', text.slice(0, 120));
    return null;
  }
  if (!obj.headline || !obj.body) return null;
  const headline = String(obj.headline).trim().slice(0, 80);
  const body = String(obj.body).trim();
  if (headline.length < 5 || body.length < 20) return null;
  const scienceTag = SCIENCE_TAGS.includes(obj.science_tag) ? obj.science_tag : defaultScienceTag;
  return { headline, body, scienceTag, revealType };
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

async function generateInterestReveal(interest, userContext) {
  const { complete } = require('../lib/claude-client');
  const text = await complete({
    system: INTEREST_PROMPT,
    messages: [{
      role: 'user',
      content: `Interest: ${interest.tag}\nEvidence from their own tasks/spending: ${interest.evidence.map(e => `"${e}"`).join(', ')} (${interest.count} signals over 90 days)\n\nTheir week, for optional context:\n${userContext}\n\nStage tonight's interest reveal as JSON.`,
    }],
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 300,
  });
  // science_tag "none" (or invalid) → no footer; interest reveals don't have
  // to teach science every time.
  return parseRevealJson(text, { defaultScienceTag: null, revealType: 'interest' });
}

// Deterministic interest fallback — real evidence, no invented facts.
function buildInterestFallback(interest) {
  if (!interest) return null;
  return {
    headline: `The ${interest.tag} thing left a trail`,
    body: `${interest.count} of your recent tasks and purchases orbit ${interest.tag} — ${interest.evidence.map(e => `"${e}"`).join(', ')}. Brains work better inside things they love: today, park your hardest task right next to it.`,
    scienceTag: 'habit_formation',
    revealType: 'interest',
  };
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

  return null; // genuinely nothing to say — personal-data-wise (fun fact covers this)
}

// ── Fun-fact reveals ──────────────────────────────────────────────────────────
// Snapple-lid energy, on-brand: every fact is about brains, habits, or money
// psychology, so a "just for fun" day still reinforces the science identity.
// Two jobs: (1) variable reward — the reveal TYPE varies, so the unwrap never
// becomes predictable; (2) day-one coverage — a user with no data yet still
// wakes up to something worth opening.

const FUN_FACTS = [
  { themes: ['focus', 'brain'],
    headline: 'Your brain bills you for focus',
    body: 'Your brain is about 2% of your body weight but burns roughly 20% of your energy. Focus is literally expensive — that afternoon crash is a fuel gauge, not a character flaw.',
    scienceTag: 'executive_function' },
  { themes: ['dopamine', 'brain'],
    headline: 'The dopamine hit isn’t where you think',
    body: 'Dopamine spikes at the *anticipation* of a reward, not the reward itself — which is why starting a task is harder than finishing one, and why this card was sealed until you tapped it.',
    scienceTag: 'habit_formation' },
  { themes: ['tasks', 'brain'],
    headline: 'Unfinished tasks are squatters',
    body: 'The Zeigarnik effect: unfinished tasks keep occupying working memory rent-free until you either finish them or write them down. That’s the entire science behind Brain Dump.',
    scienceTag: 'executive_function' },
  { themes: ['focus', 'social'],
    headline: 'Why working next to someone works',
    body: 'Body doubling — just having another person present while you work — measurably improves task initiation for ADHD brains. Nobody fully knows why yet. It just works.',
    scienceTag: 'accountability' },
  { themes: ['money'],
    headline: 'Your card is a painkiller',
    body: 'Paying with cash activates the same brain regions as physical pain — cards numb it. Behavioral economists call it the "pain of paying," and it’s why tap-to-pay feels like free money.',
    scienceTag: 'impulse_spending' },
  { themes: ['habits'],
    headline: 'The 21-day habit thing is a myth',
    body: 'The real median time to form a habit is 66 days — and missing a single day made no measurable difference in the research. One slip never broke anyone’s habit. Science says so.',
    scienceTag: 'habit_formation' },
  { themes: ['focus', 'movement'],
    headline: 'The cheapest focus drug is legal',
    body: 'A 20-minute walk produces a short-term focus boost comparable to a low stimulant dose for ADHD brains. It’s why Buddy nags you to stand up mid-focus-session.',
    scienceTag: 'executive_function' },
  { themes: ['sleep', 'brain'],
    headline: 'Your brain takes out the trash at night',
    body: 'During sleep, your brain physically flushes metabolic waste through the glymphatic system. Skimping on sleep means running today on yesterday’s unfiltered brain.',
    scienceTag: 'executive_function' },
  { themes: ['tasks', 'habits'],
    headline: 'A sentence that doubles follow-through',
    body: 'Saying "After I make coffee, I’ll start the report" — instead of "I’ll do it today" — roughly doubles completion rates. Implementation intentions turn vague plans into reflexes.',
    scienceTag: 'habit_formation' },
  { themes: ['time', 'brain'],
    headline: 'ADHD time comes in exactly two sizes',
    body: 'Research describes ADHD time perception as binary: "now" and "not now." Deadlines feel fake until they’re emergencies — which is a clock problem, not a character problem.',
    scienceTag: 'avoidance_loops' },
  { themes: ['money', 'brain'],
    headline: 'Future-you is a stranger (literally)',
    body: 'Brain scans show people process "future me" in the same region as *strangers* — which is why saving feels like giving money away. Seeing tomorrow’s plan tonight shrinks that gap.',
    scienceTag: 'impulse_spending' },
  { themes: ['dopamine', 'habits'],
    headline: 'Boredom is a dopamine invoice',
    body: 'ADHD brains run lower baseline dopamine, so boredom isn’t laziness — it’s a chemical shortfall the brain tries to fix (hello, impulse purchases). Novelty is the legitimate refill.',
    scienceTag: 'salutogenesis' },
];

// Small deterministic hash — keeps fact choice stable for a given user+date so
// job re-runs are idempotent (revealExists guards anyway; this is belt+braces).
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Rotation: 50% personal insight, 25% interest reveal, 25% fun fact.
// Varying the reveal TYPE is what keeps the unwrap unpredictable; slots that
// can't be filled (no interests, no data) cascade to the next flavor.
function revealSlotFor(userId, localDate) {
  const h = hashSeed(`${userId}:${localDate}`) % 8;
  if (h < 2) return 'fun_fact';
  if (h < 4) return 'interest';
  return 'personal';
}

// Back-compat helper (slot semantics changed from a boolean to three flavors)
function isFunFactDay(userId, localDate) {
  return revealSlotFor(userId, localDate) === 'fun_fact';
}

/**
 * Pick a fun fact for user+date. When the user's adhd_profile names a struggle
 * or interest area that matches a fact theme, prefer those facts; otherwise
 * rotate through the whole bank. Never returns null.
 */
function pickFunFact(userId, localDate, adhdProfile) {
  let pool = FUN_FACTS;
  const profileText = JSON.stringify(adhdProfile || {}).toLowerCase();
  const preferred = FUN_FACTS.filter(f => f.themes.some(t => profileText.includes(t)));
  if (preferred.length >= 2) pool = preferred; // enough variety to rotate within
  const pick = pool[hashSeed(`fact:${userId}:${localDate}`) % pool.length];
  return { ...pick, revealType: 'fun_fact' };
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
      `SELECT u.id, COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone,
              u.adhd_profile
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

    let ai = 0, fallback = 0, interestReveals = 0, funFacts = 0, skipped = 0;
    for (const user of users) {
      try {
        const localDate = getUserLocalDate(user.timezone);
        if (await revealExists(pool, user.id, localDate)) { skipped++; continue; }

        const slot = revealSlotFor(user.id, localDate);
        let reveal = null;

        if (slot !== 'fun_fact') {
          const data = await fetchUserWeek(pool, user.id, sinceDate);
          const interests = deriveInterests(await fetchInterestCorpus(pool, user.id));
          // Personal-insight prompts also see interests — even stat reveals
          // land harder when they reference something the user loves.
          const userContext = summariseForPrompt(data) +
            (interests.length ? '\n' + interestsLine(interests) : '');

          // Interest slot: rotate among their top interests day to day
          if (slot === 'interest' && interests.length) {
            const pick = interests[hashSeed(`int:${user.id}:${localDate}`) % interests.length];
            if (process.env.ANTHROPIC_API_KEY) {
              try {
                reveal = await generateInterestReveal(pick, userContext);
              } catch (aiErr) {
                console.warn(`[daily-reveal] interest AI failed user=${user.id}:`, aiErr.message, '— using fallback');
              }
            }
            if (!reveal) reveal = buildInterestFallback(pick);
            if (reveal) interestReveals++;
          }

          // Personal slot (or interest slot with no detectable interests)
          if (!reveal) {
            if (process.env.ANTHROPIC_API_KEY) {
              try {
                reveal = await generateAiReveal(userContext);
              } catch (aiErr) {
                console.warn(`[daily-reveal] AI failed user=${user.id}:`, aiErr.message, '— using fallback');
              }
            }
            if (reveal) { ai++; } else {
              reveal = buildFallbackReveal(data);
              if (reveal) fallback++;
            }
          }
        }

        // Fun-fact day, or no personal reveal available (e.g. brand-new user):
        // a fact means every user wakes up to something worth opening.
        if (!reveal) {
          reveal = pickFunFact(user.id, localDate, user.adhd_profile);
          funFacts++;
        }

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

    console.log(`[daily-reveal] Done. ai=${ai} fallback=${fallback} interest=${interestReveals} fun_facts=${funFacts} skipped=${skipped} total=${users.length}`);
  } catch (err) {
    console.error('[daily-reveal] Fatal:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Export pure functions for tests; only run when invoked as a script.
module.exports = {
  buildFallbackReveal, parseRevealJson, summariseForPrompt,
  pickFunFact, isFunFactDay, FUN_FACTS, SCIENCE_TAGS,
  deriveInterests, revealSlotFor, buildInterestFallback, interestsLine, INTEREST_KEYWORDS,
};
if (require.main === module) run();
