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
    // The pool here has no users row, so the app-wide default zone (New York) is used.
    expect(err.userMessage).toMatch(/^You've used today's AI help\. It resets at [78] PM your time, and everything else still works\.$/);
    expect(err.upsell).toBe('Autopilot raises the daily limit.');
    expect(budget.quotaHit()).toBe(err);
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

describe('when the limit resets, in the user\'s own clock', () => {
  const winter = new Date('2026-01-15T15:00:00Z');
  const summer = new Date('2026-07-15T15:00:00Z');

  test('the budget day is the UTC day', () => {
    expect(budget.nextResetAt(winter).toISOString()).toBe('2026-01-16T00:00:00.000Z');
    expect(budget.nextResetAt(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  test('says the local time of midnight UTC, following daylight saving', () => {
    expect(budget.resetPhrase('America/New_York', winter)).toBe('7 PM your time');
    expect(budget.resetPhrase('America/New_York', summer)).toBe('8 PM your time');
    expect(budget.resetPhrase('America/Los_Angeles', winter)).toBe('4 PM your time');
    expect(budget.resetPhrase('Asia/Kolkata', winter)).toBe('5:30 AM your time');
    expect(budget.resetPhrase('Europe/London', winter)).toBe('midnight your time');
    expect(budget.resetPhrase('Pacific/Auckland', summer)).toBe('noon your time');
  });

  test('says "midnight UTC" when there is no usable timezone', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(budget.resetPhrase(null)).toBe('midnight UTC');
    expect(budget.resetPhrase('Not/AZone')).toBe('midnight UTC');
    warn.mockRestore();
  });

  test('paid users get no upgrade line', () => {
    const err = new budget.AiQuotaError('pro', 500, 'America/Chicago');
    expect(err.upsell).toBeNull();
    expect(budget.aiLimitBody(err)).toMatchObject({ success: false, code: 'AI_DAILY_LIMIT', tier: 'pro', limit: 500, upsell: null });
  });
});

describe('public/js/ai-limit.js (what the pages show)', () => {
  const load = (capacitor) => {
    const win = capacitor ? { Capacitor: capacitor } : {};
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'ai-limit.js'), 'utf8');
    new Function('window', src)(win); // eslint-disable-line no-new-func
    return win.FLAiLimit;
  };
  const body = { code: 'AI_DAILY_LIMIT', message: 'You\'ve used today\'s AI help. It resets at 7 PM your time, and everything else still works.', upsell: 'Autopilot raises the daily limit.' };

  test('recognises the code', () => {
    const fl = load();
    expect(fl.is(body)).toBe(true);
    expect(fl.is({ success: false, message: 'nope' })).toBe(false);
    expect(fl.is(null)).toBe(false);
  });

  test('on the web, Free users also see that Autopilot raises the limit', () => {
    expect(load().text(body)).toBe(body.message + ' Autopilot raises the daily limit.');
  });

  test('inside the native iOS app the upgrade line is left out', () => {
    const ios = { isNativePlatform: () => true, getPlatform: () => 'ios' };
    expect(load(ios).text(body)).toBe(body.message);
  });

  test('paid users (no upsell) see just the message', () => {
    expect(load().text({ ...body, upsell: null })).toBe(body.message);
  });
});
