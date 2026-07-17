'use strict';

const {
  DAILY_PUSH_CAP,
  wasNotificationSentToday,
  getTodayNotificationCount,
  recordNotificationSent,
  getActiveSubscriptions,
  deleteSubscriptionByEndpoint,
} = require('../db/notifications');

describe('DAILY_PUSH_CAP', () => {
  test('is 3', () => {
    expect(DAILY_PUSH_CAP).toBe(3);
  });
});

// ── wasNotificationSentToday ─────────────────────────────────────────────────
describe('wasNotificationSentToday', () => {
  test('returns true when a matching row exists', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ 1: 1 }] }) };
    expect(await wasNotificationSentToday(pool, 1, 'morning_nudge')).toBe(true);
  });

  test('returns false when no row', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await wasNotificationSentToday(pool, 1, 'morning_nudge')).toBe(false);
  });

  test('uses CURRENT_DATE when no localDate arg', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await wasNotificationSentToday(pool, 1, 'key');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/CURRENT_DATE/);
    expect(params).toHaveLength(2);
  });

  test('uses $3::date when localDate is provided', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await wasNotificationSentToday(pool, 1, 'key', '2026-05-30');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\$3::date/);
    expect(params[2]).toBe('2026-05-30');
  });

  test('queries by userId and notificationKey', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await wasNotificationSentToday(pool, 7, 'task_deadline');
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe(7);
    expect(params[1]).toBe('task_deadline');
  });
});

// ── getTodayNotificationCount ─────────────────────────────────────────────────
describe('getTodayNotificationCount', () => {
  test('returns the integer count from query result', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ count: 2 }] }) };
    expect(await getTodayNotificationCount(pool, 5)).toBe(2);
  });

  test('returns 0 when count is absent', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{}] }) };
    expect(await getTodayNotificationCount(pool, 5)).toBe(0);
  });

  test('uses CURRENT_DATE when no localDate arg', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ count: 0 }] }) };
    await getTodayNotificationCount(pool, 1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/CURRENT_DATE/);
    expect(params).toHaveLength(1);
  });

  test('passes localDate as $2::date when provided', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ count: 1 }] }) };
    await getTodayNotificationCount(pool, 1, '2026-01-15');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\$2::date/);
    expect(params[1]).toBe('2026-01-15');
  });
});

// ── recordNotificationSent ───────────────────────────────────────────────────
describe('recordNotificationSent', () => {
  test('records the send without ON CONFLICT (prod has no matching constraint)', async () => {
    // Dedup is the caller's wasNotificationSentToday() guard, not a DB unique.
    // An ON CONFLICT against the missing constraint used to THROW, so the send
    // was never logged and nudges re-fired every run (the duplicate-notification bug).
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await recordNotificationSent(pool, 1, 'key', 'task_deadline');
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO notification_send_log/);
    expect(sql).not.toMatch(/ON CONFLICT/);
  });

  test('stores the provided notification type', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await recordNotificationSent(pool, 1, 'key', 'morning_nudge');
    expect(pool.query.mock.calls[0][1][2]).toBe('morning_nudge');
  });

  test('defaults notification type to task_deadline when omitted', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await recordNotificationSent(pool, 1, 'key');
    expect(pool.query.mock.calls[0][1][2]).toBe('task_deadline');
  });

  test('uses $4::date when localDate is provided', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await recordNotificationSent(pool, 2, 'key', 'type', '2026-03-01');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\$4::date/);
    expect(params[3]).toBe('2026-03-01');
  });

  test('uses CURRENT_DATE when no localDate', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await recordNotificationSent(pool, 1, 'key', 'type');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/CURRENT_DATE/);
    expect(params).toHaveLength(3);
  });
});

// ── getActiveSubscriptions ───────────────────────────────────────────────────
describe('getActiveSubscriptions', () => {
  test('returns rows from push_subscriptions for the user', async () => {
    const subs = [{ id: 1, subscription: '{}', endpoint: 'https://push.ex.com' }];
    const pool = { query: jest.fn().mockResolvedValue({ rows: subs }) };
    const result = await getActiveSubscriptions(pool, 7);
    expect(result).toEqual(subs);
    expect(pool.query.mock.calls[0][1]).toEqual([7]);
  });

  test('returns empty array when user has no subscriptions', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await getActiveSubscriptions(pool, 99)).toEqual([]);
  });
});

// ── deleteSubscriptionByEndpoint ─────────────────────────────────────────────
describe('deleteSubscriptionByEndpoint', () => {
  test('deletes by endpoint string', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await deleteSubscriptionByEndpoint(pool, 'https://gone.endpoint.com');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM push_subscriptions/);
    expect(params[0]).toBe('https://gone.endpoint.com');
  });
});
