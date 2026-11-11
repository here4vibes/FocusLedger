'use strict';
/**
 * Over today's AI budget, every AI route must answer 429 with the stable code
 * AI_DAILY_LIMIT and the plain message, never a 200 with a canned reply.
 * The real budget (lib/ai-budget.js) runs here; only the usage counter and the
 * plan lookup are mocked, so the error travels the same path as in production.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../db/ai-usage', () => ({ incrementAiCalls: jest.fn(), addAiTokens: jest.fn() }));
jest.mock('../middleware/proUtils', () => ({
  ...jest.requireActual('../middleware/proUtils'),
  checkProStatus: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn().mockRejectedValue(new Error('the model must not be called over the limit')) },
})));

const express = require('express');
const request = require('supertest');
const aiUsage = require('../db/ai-usage');
const { checkProStatus } = require('../middleware/proUtils');
const { generateToken } = require('../middleware/auth');
const { requestContext } = require('../lib/request-context');
const { quotaAwareResponses } = require('../lib/ai-budget');

const auth = 'Bearer ' + generateToken({ id: 7, email: 'u7@example.com' });

/** A pool that answers every query with no rows, except the few lookups the routes read. */
function makePool() {
  const query = jest.fn(async (sql) => {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    if (/SELECT timezone FROM users/.test(text)) return { rows: [{ timezone: 'America/Chicago' }] };
    if (/SELECT id, title FROM tasks WHERE id = \$1/.test(text)) return { rows: [{ id: 5, title: 'Do my taxes' }] };
    if (/session_count/.test(text)) return { rows: [{ session_count: 1, buddy_hook_restart_count: 0 }] };
    if (/COUNT\(\*\)/i.test(text)) return { rows: [{ n: 0, count: '0' }] };
    return { rows: [], rowCount: 0 };
  });
  return { query };
}

function makeApp(pool, mount) {
  const app = express();
  app.use(express.json());
  app.use(requestContext(pool), quotaAwareResponses); // as server.js does
  mount(app);
  return app;
}

function expectAiLimit(res, { upsell }) {
  expect(res.status).toBe(429);
  expect(res.body.success).toBe(false);
  expect(res.body.code).toBe('AI_DAILY_LIMIT');
  // Midnight UTC is 6 PM or 7 PM in Chicago, depending on daylight saving.
  expect(res.body.message).toMatch(/^You've used today's AI help\. It resets at [67] PM your time, and everything else still works\.$/);
  expect(res.body.upsell).toBe(upsell);
  expect(typeof res.body.resets_at).toBe('string');
}

let errorSpy;
let warnSpy;
beforeEach(() => {
  jest.clearAllMocks();
  aiUsage.addAiTokens.mockResolvedValue();
  aiUsage.incrementAiCalls.mockResolvedValue(101); // one past the Free limit of 100
  checkProStatus.mockResolvedValue(false);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('Buddy chat over the daily AI limit', () => {
  const mount = (pool) => (app) => app.use('/api/buddy', require('../routes/buddy')(pool));

  test('POST /api/buddy/conversation answers 429 and stores no Buddy turn', async () => {
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/buddy/conversation').set('Authorization', auth)
      .send({ message: 'feeling a bit scattered today', date: '2026-11-10' });
    expectAiLimit(res, { upsell: 'Autopilot raises the daily limit.' });
    const buddyTurnWrites = pool.query.mock.calls.filter(([sql]) => /INSERT INTO buddy_conversations/.test(sql) && /'buddy'/.test(sql));
    expect(buddyTurnWrites).toHaveLength(0);
  });

  test('POST /api/buddy/break-down answers 429 and saves no placeholder steps', async () => {
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/buddy/break-down').set('Authorization', auth)
      .send({ taskId: 5, taskTitle: 'Do my taxes' });
    expectAiLimit(res, { upsell: 'Autopilot raises the daily limit.' });
    expect(pool.query.mock.calls.filter(([sql]) => /task_substeps/.test(sql) && /INSERT|DELETE/.test(sql))).toHaveLength(0);
  });

  test('a route that answers 500 on AI failure (brain-dump-triage) becomes the same 429', async () => {
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/buddy/brain-dump-triage').set('Authorization', auth)
      .send({ text: 'taxes, the dentist, mom birthday, the thing with the car' });
    expectAiLimit(res, { upsell: 'Autopilot raises the daily limit.' });
  });
});

describe('Agent over the daily AI limit', () => {
  const mount = (pool) => (app) => app.use('/api/agent', require('../routes/agent')(pool));

  test('POST /api/agent/chat answers 429, not a 200 "couldn\'t think that through"', async () => {
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/agent/chat').set('Authorization', auth)
      .send({ message: 'move the dentist to Friday' });
    expectAiLimit(res, { upsell: 'Autopilot raises the daily limit.' });
    expect(res.body.reply).toBeUndefined();
  });

  test('POST /api/agent/act answers 429 too', async () => {
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/agent/act').set('Authorization', auth)
      .send({ message: 'mark laundry done' });
    expectAiLimit(res, { upsell: 'Autopilot raises the daily limit.' });
  });

  test('a paid user gets the same message without the upgrade line', async () => {
    checkProStatus.mockResolvedValue(true);
    aiUsage.incrementAiCalls.mockResolvedValue(501);
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/agent/chat').set('Authorization', auth)
      .send({ message: 'move the dentist to Friday' });
    expectAiLimit(res, { upsell: null });
    expect(res.body.tier).toBe('pro');
  });
});

describe('Task AI routes over the daily AI limit', () => {
  const mount = (pool) => (app) => app.use('/api/tasks', require('../routes/tasks-prisma')(pool));

  test('POST /api/tasks/suggest-steps answers 429 instead of an empty "timeout"', async () => {
    checkProStatus.mockResolvedValue(true); // step suggestions are a paid feature
    aiUsage.incrementAiCalls.mockResolvedValue(501);
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/tasks/suggest-steps').set('Authorization', auth)
      .send({ title: 'Plan the kitchen renovation budget' });
    expectAiLimit(res, { upsell: null });
    expect(res.body.suggestions).toBeUndefined();
  });

  test('POST /api/tasks/suggest-duration answers 429', async () => {
    const pool = makePool();
    const res = await request(makeApp(pool, mount(pool)))
      .post('/api/tasks/suggest-duration').set('Authorization', auth)
      .send({ title: 'Plan the kitchen renovation budget' });
    expectAiLimit(res, { upsell: 'Autopilot raises the daily limit.' });
  });
});

describe('POST /api/ai/suggest-tasks over the daily AI limit', () => {
  test('answers 429 instead of an empty task list', async () => {
    const pool = makePool();
    const app = makeApp(pool, (a) => a.use('/api/ai', require('../routes/ai')(pool)));
    const res = await request(app)
      .post('/api/ai/suggest-tasks').set('Authorization', auth)
      .send({ text: 'call the plumber and renew the car registration' });
    expectAiLimit(res, { upsell: 'Autopilot raises the daily limit.' });
  });
});
