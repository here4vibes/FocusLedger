#!/usr/bin/env node
'use strict';
/**
 * ci-write-flows.js — drive the main WRITE flows as a brand-new user.
 *
 * WHY: ci-api-sweep.js only GETs. The bugs that hurt most were writes that
 * "worked" (200) but left the wrong state: INSERTs that skipped a column with
 * no DEFAULT (rows saved inactive / NULL and then filtered out), TEXT columns
 * used as booleans, ON CONFLICT targets with no unique index, a frontend
 * calling a path nothing serves. The from-scratch migrated schema is a copy of
 * production's, so a failure here is a production bug.
 *
 * Each step asserts the HTTP status AND the resulting state through a
 * follow-up GET. The run fails on a 5xx (other than 503 = feature not
 * configured locally), a logged SQL/TypeError line (same patterns as the
 * sweep, scripts/ci-harness.js), or a wrong follow-up state.
 *
 * Flows: tasks (create → list/today → edit → steps → complete → reopen →
 * delete; recurring spawn), routine capture (starter routine → streak 1), the
 * form check-in (mode preference, login check-in, daily plan, accept), Buddy
 * morning / mid-day / evening + evening-data, ideas, journal, values (add,
 * rename, delete), expenses (manual add + triage), budget, the spending
 * check-in on seeded bank rows (queue, classify → expenses, money tab agrees), time blocks, work hours, focus
 * sessions + prefs, time estimates, insurance, settings prefs (notifications,
 * nudges, follow-up emails, routine nudges), routine from template, Tandem
 * invite → accept → share → feed → dissolve (second user), promo redemption
 * error paths, the push "Done ✓" action, account-deletion request, the free
 * 10-task cap with the starter routine excluded (third user).
 * Not covered (no endpoint, or needs admin / an external service): values
 * alignment check-in (no write endpoint), promo redemption success (codes are
 * admin-created), Plaid itself (bank rows are seeded with SQL), Stripe, AI chat and AI breakdowns, documents upload.
 *
 * ~160 requests, three signups: under the global (300/15min) and signup (5/h)
 * limiters, which reset with each server process.
 *
 * Prereqs: DATABASE_URL points at a migrated DB, JWT_SECRET set.
 * Run:  node scripts/ci-write-flows.js        (npm run test:flows)
 * Exit: 0 = every flow clean, 1 = a flow failed or the server didn't boot.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, requireEnv, startServer, unexplainedErrors } = require('./ci-harness');
const { createTaskDoneToken } = require('../lib/push-action-token');
const { Pool } = require('pg');

const PORT = process.env.FLOWS_PORT || 3113;
const REQUEST_TIMEOUT_MS = 15000;
const GAP_MS = 200; // lets fire-and-forget work log before the step's window closes
// A timezone whose calendar date differs from UTC's right now, so any code that
// takes "today" from the server clock (UTC) instead of the user's zone fails
// on every run, not just in the evening. UTC-12 is a day behind until 12:00
// UTC; UTC+14 is a day ahead from 10:00 UTC.
const TZ = new Date().getUTCHours() < 12 ? 'Etc/GMT+12' : 'Pacific/Kiritimati';

requireEnv('write-flows');

const localDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });

class FlowError extends Error {}
function expect(cond, msg) { if (!cond) throw new FlowError(msg); }

let server;
// Seeds rows no endpoint can create locally (Plaid). Same DB as the server.
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let requestCount = 0;
const failures = [];
const results = [];

/** One HTTP call. A 5xx (except 503) fails the step on the spot. */
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  requestCount++;
  try {
    res = await fetch(server.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FlowError(`${method} ${path} → network error: ${err.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; } // silent-ok: non-JSON bodies are judged by status
  if (res.status >= 500 && res.status !== 503) {
    throw new FlowError(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: json || {} };
}

/** Expect one of `statuses`; returns the body. */
async function call(method, path, statuses, opts) {
  const r = await api(method, path, opts);
  const ok = Array.isArray(statuses) ? statuses : [statuses];
  expect(ok.includes(r.status), `${method} ${path} → ${r.status}, expected ${ok.join('/')}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

/** Run a flow; any thrown error or logged schema error fails it, the rest still run. */
async function flow(name, fn) {
  let error = null;
  try {
    const skipped = await fn();
    if (typeof skipped === 'string') { results.push(`⏭  ${name} — skipped: ${skipped}`); }
  } catch (err) {
    error = err instanceof FlowError ? err.message : (err.stack || err.message);
  }
  await sleep(GAP_MS);
  const logged = unexplainedErrors(server.drainLogs());
  if (error || logged.length) {
    failures.push({ name, errors: [error, ...logged].filter(Boolean) });
    results.push(`❌ ${name}`);
  } else if (!results.some(r => r.includes(` ${name} — skipped`))) {
    results.push(`✅ ${name}`);
  }
}

async function signup(label) {
  const r = await api('POST', '/api/auth/signup', {
    body: {
      email: `ci-flows-${label}-${Date.now()}@example.com`,
      password: 'Fl0wsTest!pw',
      name: `CI Flows ${label}`,
      timezone: TZ,
    },
  });
  expect(r.body.token, `signup ${label} failed (status ${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return { token: r.body.token, user: r.body.user || {} };
}

async function listTasks(token) {
  return (await call('GET', '/api/tasks', 200, { token })).tasks || [];
}

async function main() {
  server = await startServer(PORT);
  let A;
  let B;

  await flow('signup (user A)', async () => {
    A = await signup('a');
    await sleep(1500); // signup's fire-and-forget seeding (starter routine, welcome email) logs here
  });
  if (!A) throw new Error('cannot continue without user A');
  const token = A.token;
  const today = localDate();

  // 1 ── Tasks ────────────────────────────────────────────────────────────────
  await flow('tasks: create → list → today → edit → steps → complete → reopen → delete', async () => {
    const created = await call('POST', '/api/tasks', 201, { token, body: { title: 'CI flow task', due_date: today, priority: 'high' } });
    const id = created.task && created.task.id;
    expect(id, 'create returned no task id');

    let t = (await listTasks(token)).find(x => x.id === id);
    expect(t, 'created task missing from GET /api/tasks');
    expect(t.is_completed === false, `new task is_completed=${t.is_completed}, expected false`);
    expect(String(t.due_date).slice(0, 10) === today, `due_date ${t.due_date} is not today (${today})`);
    const active = (await call('GET', '/api/tasks?filter=active', 200, { token })).tasks || [];
    expect(active.some(x => x.id === id), 'new task missing from ?filter=active');

    const timeline = await call('GET', '/api/today/timeline', 200, { token });
    expect((timeline.tasks || []).some(x => x.id === id), 'task due today missing from /api/today/timeline');
    const status = await call('GET', '/api/buddy/status', 200, { token });
    expect((status.tasks || []).some(x => x.id === id), 'task due today missing from /api/buddy/status');

    await call('PATCH', `/api/tasks/${id}`, 200, { token, body: { title: 'CI flow task (edited)', notes: 'some notes' } });
    const one = (await call('GET', `/api/tasks/${id}`, 200, { token })).task;
    expect(one.title === 'CI flow task (edited)', `title after edit: ${one.title}`);
    expect(one.notes === 'some notes', `notes after edit: ${one.notes}`);

    const step1 = (await call('POST', `/api/tasks/${id}/steps`, 201, { token, body: { title: 'step one' } })).step;
    await call('POST', `/api/tasks/${id}/steps`, 201, { token, body: { title: 'step two' } });
    expect(step1 && step1.id, 'add step returned no step');
    await call('PATCH', `/api/tasks/${id}/steps/${step1.id}/toggle`, 200, { token });
    t = (await listTasks(token)).find(x => x.id === id);
    expect(t.total_steps === 2 && t.completed_steps === 1, `steps after toggle: ${t.completed_steps}/${t.total_steps}, expected 1/2`);

    const toggled = await call('PATCH', `/api/tasks/${id}/toggle`, 200, { token });
    expect(toggled.task.is_completed === true, 'toggle did not complete the task');
    t = (await listTasks(token)).find(x => x.id === id);
    expect(t.is_completed === true && t.completed_at, 'completed state not reflected in GET /api/tasks');
    expect(t.completed_steps === 2, `completing the task should finish its steps (${t.completed_steps}/2)`);
    const done = (await call('GET', '/api/tasks?filter=completed', 200, { token })).tasks || [];
    expect(done.some(x => x.id === id), 'completed task missing from ?filter=completed');
    const tl2 = await call('GET', '/api/today/timeline', 200, { token });
    expect(!(tl2.tasks || []).some(x => x.id === id), 'completed task still on /api/today/timeline');

    await call('PATCH', `/api/tasks/${id}/toggle`, 200, { token });
    t = (await listTasks(token)).find(x => x.id === id);
    expect(t.is_completed === false && !t.completed_at, 'toggle back did not reopen the task');

    await call('DELETE', `/api/tasks/${id}/steps/${step1.id}`, 200, { token });
    await call('DELETE', `/api/tasks/${id}`, 200, { token });
    expect(!(await listTasks(token)).some(x => x.id === id), 'deleted task still listed');
    await call('GET', `/api/tasks/${id}`, 404, { token });
  });

  // 2 ── Routines ─────────────────────────────────────────────────────────────
  await flow('routines: finish the starter routine → streak 1', async () => {
    let routines = (await call('GET', '/api/routines', 200, { token })).routines || [];
    let routine = routines.find(r => (r.tasks || []).length > 0);
    if (!routine) {
      // No seeded routine with tasks: build one so the capture path still runs.
      routine = (await call('POST', '/api/routines', 200, { token, body: { name: 'CI routine', routine_type: 'morning' } })).routine;
      expect(routine && routine.id, 'create routine returned no id');
      const task = (await call('POST', '/api/tasks', 201, { token, body: { title: 'CI routine step' } })).task;
      await call('POST', `/api/routines/${routine.id}/tasks`, [200, 201], { token, body: { task_id: task.id } });
      routines = (await call('GET', '/api/routines', 200, { token })).routines || [];
      routine = routines.find(r => r.id === routine.id);
      expect(routine, 'created routine missing from GET /api/routines (saved inactive?)');
    }
    expect(routine.is_active === true, `routine is_active=${routine.is_active}`);
    const open = routine.tasks.filter(t => !t.is_completed);
    expect(open.length > 0, 'routine has no open tasks to complete');
    let last;
    for (const t of open) last = await call('PATCH', `/api/tasks/${t.task_id}/toggle`, 200, { token });
    expect((last.routine_completed || []).length > 0, `finishing the routine's last task returned routine_completed=${JSON.stringify(last.routine_completed)}`);

    const streaks = (await call('GET', '/api/routines/streaks', 200, { token })).streaks || [];
    const s = streaks.find(x => x.routine_id === routine.id);
    expect(s, 'no routine_streaks row after finishing the routine');
    expect(Number(s.current_streak) === 1, `current_streak=${s.current_streak}, expected 1`);
    expect(typeof s.current_streak === 'number', `current_streak is ${typeof s.current_streak}, expected an integer column`);

    // Recording the completion again the same day must not double-count.
    const again = await call('POST', `/api/routines/${routine.id}/complete`, 200, { token, body: {} });
    expect(Number(again.streak && again.streak.current_streak) === 1, `same-day re-complete changed the streak: ${JSON.stringify(again.streak)}`);
  });

  // 3 ── Form check-in (public/checkin-form.html) ──────────────────────────────
  await flow('check-in: mode preference → login check-in → daily plan → accept', async () => {
    await call('POST', '/api/tasks', 201, { token, body: { title: 'CI plan candidate', due_date: today } });
    await call('POST', '/api/buddy/mode-preference', 200, { token, body: { mode: 'form', completed: true, skipped: false } });
    const pref = await call('GET', '/api/buddy/mode-preference', 200, { token });
    expect(pref.totalSessions === 1, `mode-preference totalSessions=${pref.totalSessions}, expected 1`);

    await call('POST', '/api/buddy/login-checkin-done', 200, { token, body: { mood: 'okay', intention: 'ship the CI check' } });
    const plan = await call('GET', `/api/buddy/daily-plan?mood=okay&date=${today}`, 200, { token });
    expect(plan.plan, 'daily-plan returned no plan');
    const accepted = await call('POST', '/api/buddy/daily-plan/accept', 200, { token, body: { date: today } });
    expect(accepted.plan && accepted.plan.accepted === true, `accept left plan.accepted=${accepted.plan && accepted.plan.accepted}`);
    const status = await call('GET', `/api/buddy/status?date=${today}`, 200, { token });
    expect(status.dailyPlan && status.dailyPlan.accepted === true, 'accepted plan not reflected in /api/buddy/status');
  });

  // 4 ── Ideas ────────────────────────────────────────────────────────────────
  await flow('ideas: submit → list', async () => {
    const idea = (await call('POST', '/api/ideas', [200, 201], { token, body: { title: 'CI idea', description: 'from the write-flow check' } })).idea;
    expect(idea && idea.id, 'submit idea returned no id');
    const ideas = (await call('GET', '/api/ideas', 200, { token })).ideas || [];
    const got = ideas.find(i => i.id === idea.id);
    expect(got, 'submitted idea missing from GET /api/ideas');
    expect(got.status === 'submitted', `idea status=${got.status}`);
    expect(got.reward_applied === false || got.reward_applied === null, `idea reward_applied=${JSON.stringify(got.reward_applied)}, expected false`);
  });

  // 5 ── Journal ──────────────────────────────────────────────────────────────
  await flow('journal: write → list', async () => {
    const r = await call('POST', '/api/journal', [200, 201], { token, body: { content: 'Wrote the CI write-flow check today.', entry_type: 'evening' } });
    const id = (r.entry && r.entry.id) || r.id;
    expect(id, `journal POST returned no entry id: ${JSON.stringify(r).slice(0, 200)}`);
    const entries = (await call('GET', '/api/journal', 200, { token })).entries || [];
    expect(entries.some(e => e.id === id), 'journal entry missing from GET /api/journal');
  });

  // 6 ── Values ───────────────────────────────────────────────────────────────
  // Skipped part: there is no endpoint that writes values_alignment_scores.
  await flow('values: add → list', async () => {
    const r = await call('POST', '/api/values', [200, 201], { token, body: { value_name: 'CI Health' } });
    const v = r.value || r;
    expect(v && v.id, `add value returned no id: ${JSON.stringify(r).slice(0, 200)}`);
    const values = (await call('GET', '/api/values', 200, { token })).values || [];
    expect(values.some(x => x.id === v.id && x.value_name === 'CI Health'), 'value missing from GET /api/values');
  });

  // 7 ── Expenses + spending check-in ─────────────────────────────────────────
  // /untriaged lists Plaid expenses only (by design), so a manual one is checked through the list.
  await flow('expenses: add (untriaged) → list → triage impulse', async () => {
    const e = (await call('POST', '/api/money/expenses', 201, { token, body: { amount: 12.5, category: 'food_delivery', note: 'CI lunch' } })).expense;
    expect(e && e.id, 'add expense returned no id');
    expect(e.is_impulse === null, `new expense is_impulse=${e.is_impulse}, expected null (untriaged)`);
    const list = (await call('GET', '/api/money/expenses?period=week', 200, { token })).expenses || [];
    expect(list.some(x => x.id === e.id), 'expense missing from GET /api/money/expenses');
    await call('PATCH', `/api/money/expenses/${e.id}/triage`, 200, { token, body: { is_impulse: true } });
    const after = (await call('GET', '/api/money/expenses?period=week', 200, { token })).expenses || [];
    const got = after.find(x => x.id === e.id);
    expect(got && got.is_impulse === true, `triaged expense is_impulse=${got && got.is_impulse}`);
    const todaySpend = await call('GET', '/api/money/expenses/today', 200, { token });
    expect(JSON.stringify(todaySpend).includes('12.5'), `today spend doesn't include the expense: ${JSON.stringify(todaySpend).slice(0, 200)}`);
    await call('DELETE', `/api/money/expenses/${e.id}`, 200, { token });
  });

  await flow('spending check-in: real bank charges → classify → expenses + money tab agree', async () => {
    // The page once called /api/spending-sessions/*, which nothing serves.
    const page = fs.readFileSync(path.join(ROOT, 'public', 'checkin-spending.html'), 'utf8');
    const paths = [...page.matchAll(/['"`](\/api\/[^'"`]*spending-sessions[^'"`]*)/g)].map(m => m[1]);
    expect(paths.length > 0, 'checkin-spending.html no longer calls the spending-sessions API (update this check)');
    for (const p of paths) expect(p.startsWith('/api/v1/spending-sessions'), `checkin-spending.html calls ${p}, which is not mounted`);

    // Seed a bank connection the way Plaid sync leaves it (no Plaid in CI).
    const userId = A.user.id;
    expect(userId, 'signup returned no user id');
    const tag = `ci-${userId}-${Date.now()}`;
    const item = (await db.query(
      `INSERT INTO plaid_items (user_id, access_token, item_id, institution_name, institution_id, created_at)
       VALUES ($1, 'ci-not-a-token', $2, 'CI Bank', $2, now()) RETURNING id`, [userId, `item-${tag}`])).rows[0];
    const acct = (await db.query(
      `INSERT INTO plaid_accounts (plaid_item_id, user_id, account_id, name, type, mask, created_at)
       VALUES ($1, $2, $3, 'CI Checking', 'depository', '0000', now()) RETURNING id`, [item.id, userId, `acct-${tag}`])).rows[0];
    const pt = async (key, amount, date, pending = false) => (await db.query(
      `INSERT INTO plaid_transactions (plaid_account_id, user_id, transaction_id, amount, description, merchant_name, transaction_date, is_confirmed, is_pending)
       VALUES ($1, $2, $3, $4, $5, $5, $6, false, $7) RETURNING id`,
      [acct.id, userId, `${key}-${tag}`, amount, `CI ${key}`, date, pending])).rows[0].id;
    const coffee = await pt('coffee', '6.75', localDate(-1));
    const books = await pt('books', '42.10', localDate(-2));
    await pt('refund', '-20.00', localDate(-1));        // money in: not a spending decision
    await pt('hold', '15.00', localDate(0), true);      // pending: wait until it posts
    await pt('old', '30.00', localDate(-20));           // outside the 14-day window
    // Sync auto-confirms posted charges into expenses with is_impulse NULL.
    const synced = (await db.query(
      `INSERT INTO expenses (user_id, amount, description, expense_date, source, plaid_transaction_id)
       VALUES ($1, '12.99', 'CI streaming', $2, 'plaid', $3) RETURNING id`, [userId, localDate(-3), `stream-${tag}`])).rows[0].id;

    const start = await call('POST', '/api/v1/spending-sessions/start', 200, { token });
    expect(start.session_id, 'start returned no session_id');
    expect(String(start.session_date).slice(0, 10) === today, `session_date ${start.session_date} is not the user's local today (${today})`);
    const t = await call('GET', '/api/v1/spending-sessions/today', 200, { token });
    expect(t.session_id === start.session_id, `today session ${t.session_id} != started ${start.session_id}`);
    const ids = (t.transactions || []).map(x => x.id).sort();
    const want = [`exp:${synced}`, `pt:${books}`, `pt:${coffee}`].sort();
    expect(JSON.stringify(ids) === JSON.stringify(want), `queue ${JSON.stringify(ids)}, expected ${JSON.stringify(want)}`);
    const coffeeCard = t.transactions.find(x => x.id === `pt:${coffee}`);
    expect(coffeeCard.amount === 675 && coffeeCard.date === localDate(-1), `coffee card ${JSON.stringify(coffeeCard)}`);

    const sid = start.session_id;
    const classify = (id, c, status = 200) =>
      call('POST', `/api/v1/spending-sessions/${sid}/classify`, status, { token, body: { transaction_id: id, classification: c } });
    await classify(`pt:${coffee}`, 'impulse');
    await classify(`pt:${books}`, 'impulse');
    await classify(`pt:${books}`, 'planned');               // re-swipe updates, no second expense
    await classify(`exp:${synced}`, 'planned');
    await classify('pt:2147480000', 'impulse', 404);
    await classify('legacy-uuid', 'impulse', 404);
    await call('POST', '/api/v1/spending-sessions/2147480000/classify', 404, { token, body: { transaction_id: `pt:${coffee}`, classification: 'impulse' } });

    const t1 = await call('GET', '/api/v1/spending-sessions/today', 200, { token });
    expect((t1.transactions || []).length === 0, `queue not empty after classifying: ${JSON.stringify(t1.transactions)}`);
    expect(t1.impulse_count === 1 && t1.planned_count === 2, `session counts impulse=${t1.impulse_count} planned=${t1.planned_count}`);

    const exp = (await db.query(
      `SELECT pt.id AS pt_id, pt.is_confirmed, e.id, e.amount::text AS amount, e.is_impulse
         FROM expenses e LEFT JOIN plaid_transactions pt ON pt.expense_id = e.id
        WHERE e.user_id = $1 AND e.source = 'plaid' ORDER BY e.id`, [userId])).rows;
    expect(exp.length === 3, `expected 3 plaid expenses, got ${exp.length}: ${JSON.stringify(exp)}`);
    const byPt = Object.fromEntries(exp.filter(r => r.pt_id).map(r => [r.pt_id, r]));
    expect(byPt[coffee] && byPt[coffee].is_impulse === true && byPt[coffee].amount === '6.75' && byPt[coffee].is_confirmed === true, `coffee expense ${JSON.stringify(byPt[coffee])}`);
    expect(byPt[books] && byPt[books].is_impulse === false, `books expense ${JSON.stringify(byPt[books])}`);
    expect(exp.find(r => r.id === synced).is_impulse === false, 'synced expense not marked planned');

    // The money tab reads the same rows.
    const pending = ((await call('GET', '/api/plaid/transactions/pending', 200, { token })).transactions || []).map(x => x.id);
    expect(!pending.includes(coffee) && !pending.includes(books), `classified charges still in the money tab's review list: ${pending}`);
    const untriaged = (await call('GET', '/api/money/expenses/untriaged', 200, { token })).expenses || [];
    expect(untriaged.length === 0, `money tab still lists ${untriaged.length} untriaged expenses`);
    const stats = await call('GET', '/api/money/spending-sessions/stats', 200, { token });
    expect(stats.impulse_count === 1 && stats.planned_count === 2, `money stats ${JSON.stringify(stats)}`);
    const v1stats = await call('GET', '/api/v1/spending-sessions/stats', 200, { token });
    expect(v1stats.impulse_count === 1 && v1stats.planned_count === 2, `v1 stats ${JSON.stringify(v1stats).slice(0, 200)}`);

    await call('POST', `/api/v1/spending-sessions/${sid}/complete`, 200, { token });
    await call('POST', '/api/v1/spending-sessions/2147480000/complete', 404, { token });
    const t2 = await call('GET', '/api/v1/spending-sessions/today', 200, { token });
    expect(t2.complete === true, `session complete=${t2.complete} after completing`);
    const money = await call('GET', '/api/money/spending-sessions/today', 200, { token });
    expect(money.session && money.session.complete === true, `money tab sees session ${JSON.stringify(money.session)}`);
  });

  // 8 ── Time blocks / work hours ─────────────────────────────────────────────
  await flow('time blocks: create → list → delete', async () => {
    const r = await call('POST', '/api/time-blocks', [200, 201], { token, body: { title: 'CI focus', block_date: today, start_time: '14:00', end_time: '15:00' } });
    const b = r.time_block || r.block || r;
    expect(b && b.id, `create time block returned no id: ${JSON.stringify(r).slice(0, 200)}`);
    const list = (await call('GET', `/api/time-blocks?date=${today}`, 200, { token })).time_blocks || [];
    expect(list.some(x => x.id === b.id), 'time block missing from GET /api/time-blocks');
    const tl = await call('GET', '/api/today/timeline', 200, { token });
    expect((tl.blocks || []).some(x => x.id === b.id), 'time block missing from /api/today/timeline');
    await call('DELETE', `/api/time-blocks/${b.id}`, 200, { token });
    const list2 = (await call('GET', `/api/time-blocks?date=${today}`, 200, { token })).time_blocks || [];
    expect(!list2.some(x => x.id === b.id), 'deleted time block still listed');
  });

  await flow('work hours: create → list → delete', async () => {
    const b = (await call('POST', '/api/work-hours', 201, { token, body: { day_of_week: 1, start_time: '09:00', end_time: '17:00', label: 'CI work' } })).block;
    expect(b && b.id, 'create work-hours block returned no id');
    const list = (await call('GET', '/api/work-hours', 200, { token })).blocks || [];
    expect(list.some(x => x.id === b.id), 'work-hours block missing from GET /api/work-hours');
    await call('DELETE', `/api/work-hours/${b.id}`, 200, { token });
    const list2 = (await call('GET', '/api/work-hours', 200, { token })).blocks || [];
    expect(!list2.some(x => x.id === b.id), 'deleted work-hours block still listed');
  });

  // 9 ── Tandem (regression check for #253) ───────────────────────────────────
  await flow('tandem: A invites → B accepts by token → active for both', async () => {
    B = await signup('b');
    await sleep(1000);
    const invite = (await call('POST', '/api/partnerships/invite', 200, { token })).invite;
    expect(invite && invite.invite_token, 'invite returned no token');
    const pending = await call('GET', '/api/partnerships/status', 200, { token });
    expect(pending.state === 'pending_sent', `inviter status=${pending.state}, expected pending_sent`);
    await call('GET', `/api/partnerships/invite/${invite.invite_token}`, 200, {});
    await call('POST', '/api/partnerships/accept', 400, { token, body: { token: invite.invite_token } }); // own invite
    const accepted = await call('POST', '/api/partnerships/accept', 200, { token: B.token, body: { token: invite.invite_token } });
    expect(accepted.partnership && accepted.partnership.status === 'active', `accept left status=${accepted.partnership && accepted.partnership.status}`);
    const sa = await call('GET', '/api/partnerships/status', 200, { token });
    const sb = await call('GET', '/api/partnerships/status', 200, { token: B.token });
    expect(sa.state === 'active', `inviter status=${sa.state} after accept`);
    expect(sb.state === 'active', `invitee status=${sb.state} after accept`);
    await call('POST', '/api/partnerships/accept', [404, 409], { token: B.token, body: { token: invite.invite_token } }); // used token

    // Sharing: A shares a task → B sees it → A finishes it → B's feed shows it.
    const shared = (await call('POST', '/api/tasks', 201, { token, body: { title: 'CI shared task', due_date: today } })).task;
    await call('PATCH', `/api/partnerships/tasks/${shared.id}/share`, 200, { token, body: { is_shared_with_partner: true } });
    const pt = (await call('GET', '/api/partnerships/partner-tasks', 200, { token: B.token })).tasks || [];
    expect(pt.some(x => x.id === shared.id), 'shared task missing from partner-tasks for the partner');
    await call('PATCH', `/api/tasks/${shared.id}/toggle`, 200, { token });
    const feed = (await call('GET', '/api/partnerships/completion-feed', 200, { token: B.token })).completions || [];
    expect(feed.some(x => (x.id ?? x.task_id) === shared.id || x.title === 'CI shared task'), 'completed shared task missing from the partner\'s completion feed');

    await call('DELETE', `/api/partnerships/${sa.partnership.id}`, 200, { token: B.token });
    const da = await call('GET', '/api/partnerships/status', 200, { token });
    const db = await call('GET', '/api/partnerships/status', 200, { token: B.token });
    expect(da.state === 'none' && db.state === 'none', `after dissolve: inviter=${da.state}, invitee=${db.state}`);
  });

  // 10 ── Promo ───────────────────────────────────────────────────────────────
  // Success path skipped: codes are created only through the admin API.
  await flow('promo: redemption error paths (success needs an admin-made code)', async () => {
    await call('POST', '/api/promo/redeem', 400, { token, body: {} });
    await call('POST', '/api/promo/redeem', 404, { token, body: { code: 'NO-SUCH-CODE-CI' } });
    await call('GET', '/api/promo/status', 200, { token });
  });

  // 11 ── Push "Done ✓" action ─────────────────────────────────────────────────
  await flow('push action: Done ✓ completes the task', async () => {
    const task = (await call('POST', '/api/tasks', 201, { token, body: { title: 'CI push task', due_date: today } })).task;
    const userId = task.user_id;
    const pushToken = createTaskDoneToken(userId, task.id);
    if (!pushToken) return 'JWT_SECRET not set in this process';
    await call('POST', '/api/push-actions/done', 401, { body: { token: pushToken + 'x' } });
    const r = await call('POST', '/api/push-actions/done', 200, { body: { token: pushToken } });
    expect(r.already_done === false, `first Done reported already_done=${r.already_done}`);
    const t = (await listTasks(token)).find(x => x.id === task.id);
    expect(t && t.is_completed === true, 'push Done did not complete the task');
    const r2 = await call('POST', '/api/push-actions/done', 200, { body: { token: pushToken } });
    expect(r2.already_done === true, 'second Done should be a no-op');
  });

  // 12 ── Account deletion request ────────────────────────────────────────────
  // Without RESEND_API_KEY the confirmation email can't be sent, and the route
  // has always answered 500 "Failed to send confirmation email" then. That 500
  // is accepted ONLY with that message; a SQL error answers a different one.
  await flow('account deletion: request (token stored; email may be unconfigured)', async () => {
    const r = await api('POST', '/api/account-deletion/request', { token: B.token }).catch(err => {
      if (/→ 500 .*Failed to send confirmation email/.test(err.message) && !process.env.RESEND_API_KEY) return { status: 500, body: {} };
      throw err;
    });
    expect(r.status === 200 || r.status === 500, `deletion request → ${r.status}`);
    // The account must still work: nothing is deleted until the emailed link is used.
    await call('GET', '/api/tasks', 200, { token: B.token });
  });

  // ── More writes the main screens make ──────────────────────────────────────
  await flow('recurring task: completing spawns the next one, open', async () => {
    const t = (await call('POST', '/api/tasks', 201, { token, body: { title: 'CI daily', due_date: today, recurrence_type: 'daily' } })).task;
    expect(t.recurrence_type === 'daily', `recurrence_type=${t.recurrence_type}`);
    const r = await call('PATCH', `/api/tasks/${t.id}/toggle`, 200, { token });
    const next = r.next_recurring_task;
    expect(next && next.id, 'completing a daily task spawned no next occurrence');
    const listed = (await listTasks(token)).find(x => x.id === next.id);
    expect(listed && listed.is_completed === false, `next occurrence is_completed=${listed && listed.is_completed}`);
    const nextDue = new Date(listed.due_date).toISOString().slice(0, 10);
    expect(nextDue === localDate(1), `next occurrence due ${nextDue}, expected ${localDate(1)}`);
    await call('DELETE', `/api/tasks/${next.id}`, 200, { token });
  });

  await flow('buddy: morning pick → mid-day → evening recap → status', async () => {
    const t = (await call('POST', '/api/tasks', 201, { token, body: { title: 'CI morning pick', due_date: today } })).task;
    const m = await call('POST', '/api/buddy/morning', 200, { token, body: { selected_task_id: t.id, date: today } });
    expect(m.checkin && m.alreadyDone === false, `morning check-in: ${JSON.stringify(m).slice(0, 200)}`);
    const m2 = await call('POST', '/api/buddy/morning', 200, { token, body: { selected_task_id: t.id, date: today } });
    expect(m2.alreadyDone === true, 'second morning check-in the same day was not deduped');
    await call('POST', '/api/buddy/midday-checkin', 200, { token, body: { checkin_type: 'afternoon_energy', response: { energy: 'medium' } } });
    await call('PATCH', `/api/tasks/${t.id}`, 200, { token, body: { is_completed: true } });
    await call('POST', '/api/buddy/evening', 200, { token, body: { date: today, energy_level: 3 } });
    const st = await call('GET', `/api/buddy/status?date=${today}`, 200, { token });
    expect(st.morning && st.morning.selected_task_id === t.id, 'morning check-in not reflected in /api/buddy/status');
    expect(st.evening, 'evening check-in not reflected in /api/buddy/status');
    expect(st.tasksCompletedToday >= 1, `tasksCompletedToday=${st.tasksCompletedToday}`);
    expect(Number(st.evening.tasks_completed) >= 1, `evening recap stored tasks_completed=${st.evening.tasks_completed}`);
    for (const route of ['/api/buddy/evening-data', '/api/evening/evening-data']) {
      const ed = await call('GET', route, 200, { token });
      expect(ed.tasksCompletedToday >= 1, `${route} tasksCompletedToday=${ed.tasksCompletedToday}`);
    }
    await call('POST', '/api/evening/evening', 200, { token, body: { date: today, energy_level: 3 } });
    // The Buddy bubble and the insights card read "today"/"this week" in the user's zone too
    const ctx = await call('GET', '/api/buddy-widget/context', 200, { token });
    expect(ctx.morningCheckinDone === true && ctx.eveningCheckinDone === true,
      `/api/buddy-widget/context check-ins: morning=${ctx.morningCheckinDone} evening=${ctx.eveningCheckinDone}`);
    const badge = await call('GET', '/api/buddy-widget/notification-count', 200, { token });
    expect(badge.eveningReady === false, `/api/buddy-widget/notification-count eveningReady=${badge.eveningReady}, expected false`);
    const ins = await call('GET', '/api/v1/insights/stats', 200, { token });
    expect(ins.weekly && ins.weekly.tasks_completed >= 1, `/api/v1/insights/stats weekly.tasks_completed=${ins.weekly && ins.weekly.tasks_completed}`);
  });

  await flow('focus session: start → complete → recent', async () => {
    const t = (await call('POST', '/api/tasks', 201, { token, body: { title: 'CI focus task' } })).task;
    const s = await call('POST', '/api/v1/focus-sessions/start', 200, { token, body: { task_id: t.id, planned_duration_minutes: 25 } });
    expect(s.session_id, 'focus start returned no session_id');
    const tl = await call('GET', '/api/today/timeline', 200, { token });
    expect(tl.active_focus && tl.active_focus.task_id === t.id, 'running focus session missing from /api/today/timeline');
    await call('POST', `/api/v1/focus-sessions/${s.session_id}/complete`, 200, { token, body: { actual_duration_seconds: 1500, completed: true } });
    const recent = (await call('GET', '/api/v1/focus-sessions/recent', 200, { token })).sessions || [];
    const got = recent.find(x => x.id === s.session_id);
    expect(got && got.completed === true && Number(got.actual_duration_seconds) === 1500, `recent session: ${JSON.stringify(got)}`);
    const tl2 = await call('GET', '/api/today/timeline', 200, { token });
    expect(!tl2.active_focus, 'completed focus session still shown as running');
    await call('POST', '/api/v1/focus-preferences', 200, { token, body: { body_double_enabled: true, ambient_style: 'rain', ambient_volume: 40 } });
    const prefs = await call('GET', '/api/v1/focus-preferences', 200, { token });
    const p = prefs.preferences || prefs.prefs || prefs;
    expect(p.ambient_style === 'rain' && Number(p.ambient_volume) === 40, `focus prefs after save: ${JSON.stringify(prefs).slice(0, 200)}`);
  });

  await flow('time estimate: estimate → complete with time', async () => {
    const t = (await call('POST', '/api/tasks', 201, { token, body: { title: 'CI estimate task' } })).task;
    await call('POST', `/api/v1/tasks/${t.id}/estimate`, 200, { token, body: { estimated_minutes: 20 } });
    const r = await call('POST', `/api/v1/tasks/${t.id}/complete-with-time`, 200, { token, body: { actual_minutes: 30 } });
    expect(r.result && Number(r.result.calibration_score) === 1.5, `calibration after 20→30 min: ${JSON.stringify(r.result)}`);
    await call('DELETE', `/api/tasks/${t.id}`, 200, { token });
  });

  await flow('values: rename → delete', async () => {
    const v = (await call('POST', '/api/values', [200, 201], { token, body: { value_name: 'CI Temp' } }));
    const id = (v.value || v).id;
    await call('PUT', `/api/values/${id}`, 200, { token, body: { value_name: 'CI Renamed' } });
    let values = (await call('GET', '/api/values', 200, { token })).values || [];
    expect(values.some(x => x.id === id && x.value_name === 'CI Renamed'), 'renamed value not reflected');
    await call('DELETE', `/api/values/${id}`, 200, { token });
    values = (await call('GET', '/api/values', 200, { token })).values || [];
    expect(!values.some(x => x.id === id), 'deleted value still listed');
  });

  await flow('budget: set → read', async () => {
    await call('PUT', '/api/expenses/budget', 200, { token, body: { weekly_amount: 250 } });
    const b = await call('GET', '/api/expenses/budget', 200, { token });
    expect(JSON.stringify(b).includes('250'), `budget after save: ${JSON.stringify(b).slice(0, 200)}`);
  });

  await flow('insurance: add → list → delete', async () => {
    const p = (await call('POST', '/api/insurance', 200, { token, body: { type: 'renters', provider: 'CI Mutual', premium_monthly: 15 } })).policy;
    expect(p && p.id, 'add policy returned no id');
    const list = await call('GET', '/api/insurance', 200, { token });
    expect(JSON.stringify(list).includes('CI Mutual'), 'policy missing from GET /api/insurance');
    await call('DELETE', `/api/insurance/${p.id}`, 200, { token });
  });

  await flow('settings: notification, nudge, follow-up email and routine-nudge prefs', async () => {
    await call('PATCH', '/api/v1/notifications/preferences', 200, { token, body: { evening_enabled: false, evening_time: '20:30' } });
    const np = await call('GET', '/api/v1/notifications/preferences', 200, { token });
    expect(np.evening_enabled === false && String(np.evening_time).startsWith('20:30'), `evening prefs after save: ${JSON.stringify(np)}`);
    await call('PUT', '/api/notifications/preferences', 200, { token, body: { morningEnabled: true, morningHour: 7 } });
    await call('PUT', '/api/nudge-system/preferences', 200, { token, body: { email_enabled: true } });
    const nu = (await call('GET', '/api/nudge-system/preferences', 200, { token })).preferences;
    expect(nu && nu.email_enabled === true, `nudge prefs after save: ${JSON.stringify(nu)}`);
    const fp = { task_reminder: false, task_reminder_hour: 9, routine_streak: true, routine_streak_hour: 9, weekly_summary: true, weekly_summary_hour: 8, follow_through: true, follow_through_hour: 10 };
    await call('PUT', '/api/followup-emails/prefs', 200, { token, body: fp });
    const fe = (await call('GET', '/api/followup-emails/prefs', 200, { token })).prefs;
    expect(fe && fe.task_reminder === false && fe.source === 'stored', `follow-up prefs after save: ${JSON.stringify(fe)}`);
    await call('PUT', '/api/routines/nudge-prefs', 200, { token, body: { nudges_enabled: true, frequency: 'gentle' } });
    const rp = await call('GET', '/api/routines/nudge-prefs', 200, { token });
    expect(JSON.stringify(rp).includes('gentle'), `routine nudge prefs after save: ${JSON.stringify(rp)}`);
  });

  await flow('routine from template → listed active', async () => {
    const templates = (await call('GET', '/api/routines/templates', 200, { token })).templates || [];
    if (!templates.length) return 'no routine templates seeded';
    const r = await call('POST', '/api/routines/from-template', [200, 201], { token, body: { template_id: templates[0].id } });
    const id = (r.routine || {}).id;
    expect(id, `from-template returned no routine: ${JSON.stringify(r).slice(0, 200)}`);
    const routines = (await call('GET', '/api/routines', 200, { token })).routines || [];
    const got = routines.find(x => x.id === id);
    expect(got && got.tasks.length > 0, 'template routine missing from GET /api/routines or has no tasks');
    await call('DELETE', `/api/routines/${id}`, 200, { token });
  });

  // 13 ── Free task cap ───────────────────────────────────────────────────────
  // A fresh free user's starter routine tasks must not use up the 10 free
  // slots (db/task-cap.js): 10 own tasks fit, the 11th is refused with 402.
  await flow('free cap: starter routine tasks don\'t count → 10 own tasks, 11th is 402', async () => {
    const C = await signup('c');
    await sleep(1500); // starter routine seeding is fire-and-forget
    const routines = (await call('GET', '/api/routines', 200, { token: C.token })).routines || [];
    const openRoutineTasks = routines.flatMap(r => (r.tasks || []).filter(t => !t.is_completed));
    expect(openRoutineTasks.length > 0, 'new user has no open starter routine tasks to exclude from the cap');
    for (let i = 1; i <= 10; i++) {
      await call('POST', '/api/tasks', 201, { token: C.token, body: { title: `CI cap task ${i}` } });
    }
    const over = await call('POST', '/api/tasks', 402, { token: C.token, body: { title: 'CI cap task 11' } });
    expect(over.code === 'TASK_LIMIT_REACHED', `11th task code=${over.code}, expected TASK_LIMIT_REACHED`);
    const limits = (await call('GET', '/api/subscription/status', 200, { token: C.token })).limits || {};
    expect(limits.active_tasks === 10 && limits.max_tasks === 10 && limits.can_create_task === false,
      `subscription limits should count only own tasks: ${JSON.stringify(limits)}`);
  });

  await flow('logged-out writes are refused', async () => {
    await call('POST', '/api/tasks', 401, { body: { title: 'nope' } });
  });
}

main()
  .catch((err) => failures.push({ name: '(setup)', errors: [err.stack || err.message] }))
  .finally(async () => {
    if (server) await server.stop();
    await db.end().catch(err => console.error('[write-flows] db pool close failed:', err.message));
    for (const r of results) console.log(r);
    for (const f of failures) {
      console.log(`\n❌ ${f.name}`);
      for (const line of f.errors.slice(0, 5)) console.log(`     ${String(line).trim().slice(0, 400)}`);
    }
    console.log(`\n[write-flows] ${results.length} flows run, ${requestCount} requests, ${failures.length} failed`);
    if (failures.length) {
      console.error('[write-flows] FAILED');
      process.exit(1);
    }
    console.log('[write-flows] OK');
    process.exit(0);
  });
