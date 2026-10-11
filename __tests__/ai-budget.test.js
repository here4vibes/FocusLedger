'use strict';

jest.mock('../db/ai-usage', () => ({ incrementAiCalls: jest.fn(), addAiTokens: jest.fn() }));
jest.mock('../middleware/proUtils', () => ({ checkProStatus: jest.fn() }));

const aiUsage = require('../db/ai-usage');
const { checkProStatus } = require('../middleware/proUtils');
const budget = require('../lib/ai-budget');
const { runWithContext } = require('../lib/request-context');

const pool = {};
const inRequest = (user, fn) => runWithContext({ pool, req: { user } }, fn);

beforeEach(() => {
  jest.resetAllMocks();
  aiUsage.addAiTokens.mockResolvedValue();
  delete process.env.AI_DAILY_LIMIT_FREE;
  delete process.env.AI_DAILY_LIMIT_PRO;
});

test('outside a request (cron jobs) nothing is counted or capped', async () => {
  await expect(budget.reserve()).resolves.toBeNull();
  expect(aiUsage.incrementAiCalls).not.toHaveBeenCalled();
});

test('anonymous request (no req.user) is not metered here', async () => {
  await inRequest(undefined, async () => {
    await expect(budget.reserve()).resolves.toBeNull();
  });
  expect(aiUsage.incrementAiCalls).not.toHaveBeenCalled();
});

test('free user within the limit: counted, allowed', async () => {
  checkProStatus.mockResolvedValue(false);
  aiUsage.incrementAiCalls.mockResolvedValue(100);
  await inRequest({ id: 7 }, async () => {
    await expect(budget.reserve()).resolves.toEqual({ pool, userId: 7 });
  });
  expect(aiUsage.incrementAiCalls).toHaveBeenCalledWith(pool, 7);
});

test('free user over the limit: AiQuotaError with a friendly message', async () => {
  checkProStatus.mockResolvedValue(false);
  aiUsage.incrementAiCalls.mockResolvedValue(101);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await inRequest({ id: 7 }, async () => {
    const err = await budget.reserve().catch(e => e);
    expect(budget.isQuotaError(err)).toBe(true);
    expect(err.status).toBe(429);
    expect(err.userMessage).toMatch(/free AI help/);
  });
  warn.mockRestore();
});

test('pro users get the higher limit; plan looked up once per request', async () => {
  checkProStatus.mockResolvedValue(true);
  aiUsage.incrementAiCalls.mockResolvedValueOnce(400).mockResolvedValueOnce(401);
  await inRequest({ id: 9 }, async () => {
    await budget.reserve();
    await budget.reserve();
  });
  expect(checkProStatus).toHaveBeenCalledTimes(1);
});

test('limits are configurable', () => {
  process.env.AI_DAILY_LIMIT_FREE = '5';
  process.env.AI_DAILY_LIMIT_PRO = 'nonsense';
  expect(budget.limitFor('free')).toBe(5);
  expect(budget.limitFor('pro')).toBe(500);
});

test('metering failure fails open (logged), never blocks the feature', async () => {
  checkProStatus.mockResolvedValue(false);
  aiUsage.incrementAiCalls.mockRejectedValue(new Error('db down'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  await inRequest({ id: 7 }, async () => {
    await expect(budget.reserve()).resolves.toBeNull();
  });
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('[ai-budget] usage increment failed'), 'db down', '| user:', 7);
  spy.mockRestore();
});

test('quotaAwareResponses turns a 5xx after a quota hit into a clear 429', async () => {
  checkProStatus.mockResolvedValue(false);
  aiUsage.incrementAiCalls.mockResolvedValue(999);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  let sent;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { sent = { status: this.statusCode, body: b }; return this; } };
  await inRequest({ id: 7 }, async () => {
    budget.quotaAwareResponses({}, res, () => {});
    await budget.reserve().catch(() => {});
    res.status(500).json({ success: false, message: 'Something went wrong' });
  });
  expect(sent.status).toBe(429);
  expect(sent.body).toMatchObject({ success: false, code: 'AI_DAILY_LIMIT' });
  warn.mockRestore();
});

test('a route that handles AI failure itself (200 + canned reply) is left alone', async () => {
  checkProStatus.mockResolvedValue(false);
  aiUsage.incrementAiCalls.mockResolvedValue(999);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  let sent;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { sent = { status: this.statusCode, body: b }; return this; } };
  await inRequest({ id: 7 }, async () => {
    budget.quotaAwareResponses({}, res, () => {});
    await budget.reserve().catch(() => {});
    res.json({ success: true, reply: 'Got it.' });
  });
  expect(sent).toEqual({ status: 200, body: { success: true, reply: 'Got it.' } });
  warn.mockRestore();
});
