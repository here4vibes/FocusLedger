'use strict';
/**
 * The free plan's task cap (10 open tasks of the user's own) must hold on every
 * way a user can add a task, not only POST /api/tasks: Buddy's create_task
 * tool, the plain "Add a task: …" path, the brain dump, the check-in's
 * confirm-tasks and the journal's create-task. And when the cap stops an add,
 * Buddy says so; it never claims the task was added.
 *
 * The real cap code runs here (middleware/proUtils.js taskSlotsLeft,
 * db/task-cap.js); only the model and the pool are stand-ins.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../lib/claude-client', () => ({
  ...jest.requireActual('../lib/claude-client'),
  completeWithTools: jest.fn(),
}));
jest.mock('../lib/taskParsingService', () => ({
  ...jest.requireActual('../lib/taskParsingService'),
  extractBrainDump: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { completeWithTools } = require('../lib/claude-client');
const { extractBrainDump } = require('../lib/taskParsingService');
const { generateToken } = require('../middleware/auth');
const { taskSlotsLeft } = require('../middleware/proUtils');
const { dispatch } = require('../lib/agent-tools');
const { taskCapReply, TASK_LIMIT_CODE } = require('../lib/task-cap-reply');

const auth = 'Bearer ' + generateToken({ id: 7, email: 'u7@example.com' });
const IOS_APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 FocusLedgerApp';

/**
 * A pool that knows the user's plan and how many capped open tasks they have.
 * Each INSERT INTO tasks is recorded and counts toward the next cap check.
 */
function makePool({ open = 0, pro = false, planCheckFails = false, openTitles = [] } = {}) {
  const inserted = [];
  const query = jest.fn(async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    if (/SELECT admin_pro_override/.test(text)) {
      if (planCheckFails) throw new Error('connection reset');
      return { rows: [{ admin_pro_override: pro, pro_granted_until: null, autopilot_expires_at: null }] };
    }
    if (/COUNT\(\*\)::int AS c\s+FROM tasks t/.test(text)) return { rows: [{ c: open + inserted.length }] };
    if (/^\s*INSERT INTO tasks/.test(text)) {
      const row = { id: 100 + inserted.length, title: params[1], priority: 'medium', due_date: null, created_at: new Date() };
      inserted.push(row);
      return { rows: [row] };
    }
    if (/SELECT id, title FROM tasks WHERE user_id = \$1 AND is_completed = false$/.test(text.trim())) {
      return { rows: openTitles.map((title, i) => ({ id: i + 1, title })) };
    }
    if (/INSERT INTO agent_actions/.test(text)) return { rows: [{ id: 900 }] };
    if (/SELECT timezone FROM users/.test(text)) return { rows: [{ timezone: 'America/Chicago' }] };
    if (/session_count/.test(text)) return { rows: [{ session_count: 1, buddy_hook_restart_count: 0 }] };
    if (/COUNT\(\*\)/i.test(text)) return { rows: [{ n: 0, count: '0' }] };
    return { rows: [], rowCount: 0 };
  });
  return { query, inserted };
}

function makeApp(mount) {
  const app = express();
  app.use(express.json());
  mount(app);
  return app;
}

const modelSays = (text, ...titles) => completeWithTools.mockResolvedValue({
  content: [
    { type: 'text', text },
    ...titles.map((title, i) => ({ type: 'tool_use', id: 'tu_' + i, name: 'create_task', input: { title } })),
  ],
});

let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  completeWithTools.mockReset();
  extractBrainDump.mockReset();
});
afterEach(() => errorSpy.mockRestore());

describe('taskSlotsLeft (the one shared check)', () => {
  test('Autopilot has no limit', async () => {
    expect(await taskSlotsLeft(makePool({ open: 40, pro: true }), 7)).toBe(Infinity);
  });
  test('free: the slots left under 10, never negative', async () => {
    expect(await taskSlotsLeft(makePool({ open: 7 }), 7)).toBe(3);
    expect(await taskSlotsLeft(makePool({ open: 10 }), 7)).toBe(0);
    expect(await taskSlotsLeft(makePool({ open: 13 }), 7)).toBe(0);
  });
  test('a failed plan lookup is treated as free and logged', async () => {
    expect(await taskSlotsLeft(makePool({ open: 10, planCheckFails: true }), 7)).toBe(0);
    expect(errorSpy.mock.calls.some(c => /\[task-cap\] plan check failed/.test(c[0]))).toBe(true);
  });
  test('the count excludes routine-linked tasks (db/task-cap.js query)', async () => {
    const pool = makePool({ open: 2 });
    await taskSlotsLeft(pool, 7);
    const countSql = pool.query.mock.calls.map(c => c[0]).find(s => /COUNT\(\*\)::int AS c/.test(s));
    expect(countSql).toMatch(/NOT EXISTS[\s\S]*routine_task_links[\s\S]*r\.is_active = true/);
  });
});

describe('taskCapReply (what Buddy says)', () => {
  test('web: plain, names what was left off, may mention Autopilot', () => {
    const r = taskCapReply({ skipped: ['Call the dentist'] });
    expect(r).toMatch(/^Your list is full, so I didn’t add “Call the dentist”\./);
    expect(r).toMatch(/10 active tasks of your own \(routine tasks don’t count\)/);
    expect(r).toMatch(/Autopilot/);
  });
  test('iOS app: the same truth with no plan, price or upgrade wording', () => {
    const r = taskCapReply({ native: true, skipped: ['Call the dentist'] });
    expect(r).toMatch(/Your list is full, so I didn’t add “Call the dentist”/);
    expect(r).not.toMatch(/autopilot|upgrad|pricing|subscribe|unlock|\$/i);
  });
  test('some fit, some did not', () => {
    expect(taskCapReply({ added: 2, skipped: ['c'] })).toMatch(/^I added what fit, and then your list was full, so I didn’t add “c”\./);
  });
});

describe('Buddy create_task tool (lib/agent-tools.js dispatch)', () => {
  test('free user at the cap: refused with the code, nothing inserted', async () => {
    const pool = makePool({ open: 10 });
    const out = await dispatch(pool, 7, 'create_task', { title: 'Call the dentist' });
    expect(out).toMatchObject({ ok: false, code: TASK_LIMIT_CODE });
    expect(out.error).toMatch(/Didn’t add “Call the dentist”: your list is full/);
    expect(pool.inserted).toHaveLength(0);
  });
  test('free user with room: created', async () => {
    const pool = makePool({ open: 9 });
    const out = await dispatch(pool, 7, 'create_task', { title: 'Call the dentist' });
    expect(out.ok).toBe(true);
    expect(out.receipt).toMatch(/^Added “Call the dentist”/);
    expect(pool.inserted).toHaveLength(1);
  });
  test('Autopilot user well past 10: created', async () => {
    const pool = makePool({ open: 60, pro: true });
    expect((await dispatch(pool, 7, 'create_task', { title: 'Call the dentist' })).ok).toBe(true);
    expect(pool.inserted).toHaveLength(1);
  });
  test('at the cap, a task already on the list is still pointed at (no add needed)', async () => {
    const pool = makePool({ open: 10, openTitles: ['Cancel MySubaru before it renews'] });
    const out = await dispatch(pool, 7, 'create_task', { title: 'Cancel MySubaru subscription' });
    expect(out.ok).toBe(true);
    expect(out.result.duplicate).toBe(true);
  });
});

describe('POST /api/agent/chat and /act at the cap', () => {
  const app = (pool) => makeApp(a => a.use('/api/agent', require('../routes/agent')(pool)));

  test.each(['chat', 'act'])('/%s: the model said "added" but the cap refused → the reply tells the truth', async (route) => {
    const pool = makePool({ open: 10 });
    modelSays('Done — I added “Call the dentist” to your list!', 'Call the dentist');
    const res = await request(app(pool)).post('/api/agent/' + route).set('Authorization', auth)
      .send({ message: 'add call the dentist', history: [] });
    expect(res.status).toBe(200);
    expect(pool.inserted).toHaveLength(0);
    expect(res.body.reply).not.toMatch(/I added “Call the dentist” to your list/);
    expect(res.body.reply).toMatch(/^Your list is full, so I didn’t add “Call the dentist”\./);
    expect(res.body.reply).toMatch(/Autopilot/);
    expect(res.body.receipts).toHaveLength(1);
    expect(res.body.receipts[0]).toMatchObject({ ok: false, undoable: false, code: TASK_LIMIT_CODE, action: 'create_task' });
    // The refusal is on the action log as failed, never as executed.
    const logged = pool.query.mock.calls.filter(c => /INSERT INTO agent_actions/.test(c[0])).map(c => c[1][2]);
    expect(logged).toEqual(['failed']);
  });

  test('inside the iOS app the reply has no plan mention', async () => {
    const pool = makePool({ open: 10 });
    modelSays('Added!', 'Call the dentist');
    const res = await request(app(pool)).post('/api/agent/chat').set('Authorization', auth).set('User-Agent', IOS_APP_UA)
      .send({ message: 'add call the dentist', history: [] });
    expect(res.body.reply).toMatch(/Your list is full, so I didn’t add “Call the dentist”/);
    expect(res.body.reply).not.toMatch(/autopilot|upgrad|pricing|subscribe|unlock|\$/i);
    expect(JSON.stringify(res.body.receipts)).not.toMatch(/autopilot|upgrad/i);
  });

  test('one slot, two tasks: the first is added, the second is named as left off', async () => {
    const pool = makePool({ open: 9 });
    modelSays('Added both.', 'Call the dentist', 'Renew the passport');
    const res = await request(app(pool)).post('/api/agent/chat').set('Authorization', auth)
      .send({ message: 'add call the dentist and renew the passport', history: [] });
    expect(pool.inserted.map(t => t.title)).toEqual(['Call the dentist']);
    expect(res.body.receipts.map(r => r.ok)).toEqual([true, false]);
    expect(res.body.reply).toMatch(/^I added what fit, and then your list was full, so I didn’t add “Renew the passport”\./);
  });

  test('with room the model\'s own reply is kept', async () => {
    const pool = makePool({ open: 3 });
    modelSays('On your list.', 'Call the dentist');
    const res = await request(app(pool)).post('/api/agent/chat').set('Authorization', auth)
      .send({ message: 'add call the dentist', history: [] });
    expect(res.body.reply).toBe('On your list.');
    expect(res.body.receipts[0]).toMatchObject({ ok: true, undoable: true });
  });

  test('AI unreachable + "Add a task: …" at the cap: says the list is full, not "try again"', async () => {
    const pool = makePool({ open: 10 });
    completeWithTools.mockRejectedValue(new Error('model unreachable'));
    const res = await request(app(pool)).post('/api/agent/chat').set('Authorization', auth)
      .send({ message: 'Add a task: Call the dentist', history: [] });
    expect(pool.inserted).toHaveLength(0);
    expect(res.body.reply).toMatch(/^Your list is full, so I didn’t add that\./);
    expect(res.body.reply).not.toMatch(/added that exactly as you typed/);
    expect(res.body.receipts[0]).toMatchObject({ ok: false, code: TASK_LIMIT_CODE });
  });
});

describe('POST /api/buddy/confirm-tasks (check-in)', () => {
  const app = (pool) => makeApp(a => a.use('/api/buddy', require('../routes/buddy')(pool)));

  test('at the cap: nothing added, and the response says so', async () => {
    const pool = makePool({ open: 10 });
    const res = await request(app(pool)).post('/api/buddy/confirm-tasks').set('Authorization', auth)
      .send({ tasks: [{ title: 'Call the dentist' }, { title: 'Renew the passport' }] });
    expect(res.status).toBe(200);
    expect(pool.inserted).toHaveLength(0);
    expect(res.body).toMatchObject({ count: 0, code: TASK_LIMIT_CODE, not_added: ['Call the dentist', 'Renew the passport'] });
    expect(res.body.message).toMatch(/^Your list is full/);
  });
  test('two slots, three tasks: two added, one named', async () => {
    const pool = makePool({ open: 8 });
    const res = await request(app(pool)).post('/api/buddy/confirm-tasks').set('Authorization', auth)
      .send({ tasks: [{ title: 'a1' }, { title: 'b2' }, { title: 'c3' }] });
    expect(pool.inserted.map(t => t.title)).toEqual(['a1', 'b2']);
    expect(res.body).toMatchObject({ count: 2, not_added: ['c3'], code: TASK_LIMIT_CODE });
    expect(res.body.message).toMatch(/^I added what fit/);
  });
  test('iOS app: no plan mention in the message', async () => {
    const pool = makePool({ open: 10 });
    const res = await request(app(pool)).post('/api/buddy/confirm-tasks').set('Authorization', auth).set('User-Agent', IOS_APP_UA)
      .send({ tasks: [{ title: 'Call the dentist' }] });
    expect(res.body.message).not.toMatch(/autopilot|upgrad|pricing/i);
  });
  test('Autopilot: all added, no cap fields', async () => {
    const pool = makePool({ open: 30, pro: true });
    const res = await request(app(pool)).post('/api/buddy/confirm-tasks').set('Authorization', auth)
      .send({ tasks: [{ title: 'a1' }, { title: 'b2' }] });
    expect(res.body.count).toBe(2);
    expect(res.body.code).toBeUndefined();
  });
});

describe('POST /api/buddy/conversation brain dump', () => {
  const app = (pool) => makeApp(a => a.use('/api/buddy', require('../routes/buddy')(pool)));
  const DUMP = 'brain dump: taxes, the dentist, the car thing and the birthday present';
  const tasks = [
    { title: 'Sort the garage', category: 'parked' },
    { title: 'Book the dentist', category: 'do_soon' },
    { title: 'File taxes', category: 'do_today' },
  ];

  test('one slot: today\'s item takes it, the rest are named and not claimed', async () => {
    const pool = makePool({ open: 9 });
    extractBrainDump.mockResolvedValue({ tasks, summary: 'That is a lot to carry.' });
    const res = await request(app(pool)).post('/api/buddy/conversation').set('Authorization', auth).send({ message: DUMP });
    expect(res.status).toBe(200);
    expect(pool.inserted.map(t => t.title)).toEqual(['File taxes']);
    expect(res.body.brainDumpTasks).toHaveLength(1);
    expect(res.body.brainDumpNotAdded).toEqual(['Book the dentist', 'Sort the garage']);
    expect(res.body.reply).not.toMatch(/All added to your task list/);
    expect(res.body.reply).toMatch(/I added what fit, and then your list was full, so I didn’t add “Book the dentist”, “Sort the garage”/);
    // What Buddy said is what gets saved to the conversation.
    const saved = pool.query.mock.calls.filter(c => /INSERT INTO buddy_conversations/.test(c[0]) && /'buddy'/.test(c[0])).map(c => c[1][3]);
    expect(saved).toEqual([res.body.reply]);
  });
  test('at the cap: nothing added and Buddy says the list is full', async () => {
    const pool = makePool({ open: 10 });
    extractBrainDump.mockResolvedValue({ tasks, summary: 'ok' });
    const res = await request(app(pool)).post('/api/buddy/conversation').set('Authorization', auth).set('User-Agent', IOS_APP_UA).send({ message: DUMP });
    expect(pool.inserted).toHaveLength(0);
    expect(res.body.reply).toMatch(/^Your list is full, so I didn’t add “File taxes”/);
    expect(res.body.reply).not.toMatch(/autopilot|upgrad/i);
  });
  test('with room: all added, wording unchanged', async () => {
    const pool = makePool({ open: 2 });
    extractBrainDump.mockResolvedValue({ tasks, summary: 'ok' });
    const res = await request(app(pool)).post('/api/buddy/conversation').set('Authorization', auth).send({ message: DUMP });
    expect(pool.inserted).toHaveLength(3);
    expect(res.body.reply).toMatch(/All added to your task list/);
    expect(res.body.brainDumpNotAdded).toEqual([]);
  });
});

describe('POST /api/journal/create-task', () => {
  const app = (pool) => makeApp(a => a.use('/api/journal', require('../routes/journal')(pool)));

  test('at the cap: 402 TASK_LIMIT_REACHED, nothing inserted', async () => {
    const pool = makePool({ open: 10 });
    const res = await request(app(pool)).post('/api/journal/create-task').set('Authorization', auth).send({ title: 'Call the dentist' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ success: false, code: TASK_LIMIT_CODE, upgrade_required: true });
    expect(pool.inserted).toHaveLength(0);
  });
  test('with room: created', async () => {
    const pool = makePool({ open: 4 });
    const res = await request(app(pool)).post('/api/journal/create-task').set('Authorization', auth).send({ title: 'Call the dentist' });
    expect(res.body.success).toBe(true);
    expect(pool.inserted).toHaveLength(1);
  });
});
