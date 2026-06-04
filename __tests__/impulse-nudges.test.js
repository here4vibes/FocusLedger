'use strict';

const {
  getWeeklySpendingStats,
  getRecentImpulseExpenses,
  upsertImpulseAlert,
  getActiveAlerts,
  dismissAlert,
  getSpendingVelocity,
} = require('../db/impulseNudges');

// ── getWeeklySpendingStats ───────────────────────────────────────────────────
describe('getWeeklySpendingStats', () => {
  const mockRow = {
    total_spent: '150.50', impulse_total: '40.00', planned_total: '110.50',
    untriaged_total: '0.00', total_count: '8', impulse_count: '2', untriaged_count: '0',
  };

  test('queries with userId, weekStart, weekEnd params', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [mockRow] }) };
    await getWeeklySpendingStats(pool, 1, '2026-05-28');
    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBe(1);
    expect(params[1]).toBe('2026-05-25'); // Monday of the week containing 2026-05-28
    expect(params[2]).toBe('2026-05-31'); // Sunday
  });

  test('weekStart is always a Monday', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [mockRow] }) };
    const dates = ['2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31'];
    for (const date of dates) {
      pool.query.mockClear();
      await getWeeklySpendingStats(pool, 1, date);
      const weekStart = pool.query.mock.calls[0][1][1];
      const d = new Date(weekStart + 'T12:00:00Z');
      expect(d.getUTCDay()).toBe(1); // Monday
    }
  });

  test('parses string DB values into floats and ints', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [mockRow] }) };
    const result = await getWeeklySpendingStats(pool, 1, '2026-05-28');
    expect(result.total_spent).toBe(150.50);
    expect(result.impulse_total).toBe(40.00);
    expect(result.total_count).toBe(8);
    expect(result.impulse_count).toBe(2);
  });

  test('returns week_start and week_end in the result', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [mockRow] }) };
    const result = await getWeeklySpendingStats(pool, 1, '2026-05-28');
    expect(result.week_start).toBe('2026-05-25');
    expect(result.week_end).toBe('2026-05-31');
  });

  test('falls back to today when no localDate provided', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [mockRow] }) };
    await expect(getWeeklySpendingStats(pool, 1)).resolves.toBeDefined();
  });
});

// ── getRecentImpulseExpenses ─────────────────────────────────────────────────
describe('getRecentImpulseExpenses', () => {
  test('passes userId and date to query, returns rows', async () => {
    const rows = [{ id: 1, amount: 25, description: 'Shoes' }];
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    const result = await getRecentImpulseExpenses(pool, 5, '2026-05-30');
    expect(result).toEqual(rows);
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe(5);
    expect(params[1]).toBe('2026-05-30');
  });
});

// ── upsertImpulseAlert ───────────────────────────────────────────────────────
describe('upsertImpulseAlert', () => {
  test('upserts with ON CONFLICT and returns the row', async () => {
    const row = { id: 1, alert_type: 'high_weekly_spend', message: 'Over budget' };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const result = await upsertImpulseAlert(pool, 1, 'high_weekly_spend', '2026-05-30', 'Over budget');
    expect(result).toEqual(row);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT/);
    expect(params[0]).toBe(1);
    expect(params[1]).toBe('high_weekly_spend');
    expect(params[2]).toBe('2026-05-30');
    expect(params[3]).toBe('Over budget');
  });
});

// ── getActiveAlerts ──────────────────────────────────────────────────────────
describe('getActiveAlerts', () => {
  test('returns undismissed alerts for the user', async () => {
    const rows = [{ id: 2, alert_type: 'rising_impulse_rate', message: 'Watch out' }];
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    const result = await getActiveAlerts(pool, 3);
    expect(result).toEqual(rows);
    expect(pool.query.mock.calls[0][1][0]).toBe(3);
  });

  test('returns empty array when no active alerts', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await getActiveAlerts(pool, 99)).toEqual([]);
  });
});

// ── dismissAlert ─────────────────────────────────────────────────────────────
describe('dismissAlert', () => {
  test('issues UPDATE scoped to alertId and userId', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await dismissAlert(pool, 7, 3);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE impulse_spending_alerts/);
    expect(sql).toMatch(/is_dismissed = true/);
    expect(params).toEqual([7, 3]);
  });
});

// ── getSpendingVelocity ───────────────────────────────────────────────────────
describe('getSpendingVelocity', () => {
  test('returns average daily spend', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ active_days: '7', total: '350.00' }] })
    };
    expect(await getSpendingVelocity(pool, 1)).toBeCloseTo(50.0, 2);
  });

  test('uses a minimum of 1 active day to avoid division by zero', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ active_days: '0', total: '100.00' }] })
    };
    expect(await getSpendingVelocity(pool, 1)).toBeCloseTo(100.0, 2);
  });
});
