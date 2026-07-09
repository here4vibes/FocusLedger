'use strict';
/**
 * Unit tests for streak-freeze logic in recordRoutineCompletion.
 *
 * A "freeze" forgives one missed day so a single slip doesn't reset a streak.
 * Uses a mocked pool: the first query (getOrCreateStreak SELECT) returns the
 * existing streak row; the UPDATE captures the written values.
 */

const { recordRoutineCompletion } = require('../db/routineNudges');

function makePool(existingRow) {
  const calls = [];
  const query = jest.fn().mockImplementation((sql, params) => {
    calls.push({ sql, params });
    if (sql.trimStart().startsWith('SELECT')) {
      return Promise.resolve({ rows: existingRow ? [existingRow] : [] });
    }
    // INSERT (getOrCreateStreak fallback) or UPDATE
    return Promise.resolve({ rows: [existingRow || {}] });
  });
  return { query, calls };
}

// Extract the params of the UPDATE ... routine_streaks call.
function updateParams(pool) {
  const call = pool.calls.find((c) => c.sql.includes('UPDATE routine_streaks'));
  return call ? call.params : null;
}

describe('recordRoutineCompletion — streak freeze', () => {
  test('consecutive day increments the streak, no freeze spent', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 4, best_streak: 4,
      last_completed_date: '2026-07-08', freeze_available: true,
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09');
    expect(r.current_streak).toBe(5);
    expect(r.freeze_used).toBe(false);
    expect(r.freeze_available).toBe(true);
  });

  test('same-day re-completion does not inflate or reset', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 5, best_streak: 5,
      last_completed_date: '2026-07-09', freeze_available: true,
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09');
    expect(r.current_streak).toBe(5);
    expect(r.freeze_used).toBe(false);
  });

  test('one missed day WITH freeze is forgiven — streak survives, freeze spent', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 6, best_streak: 6,
      last_completed_date: '2026-07-07', freeze_available: true,
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09'); // gap of 2
    expect(r.current_streak).toBe(7);
    expect(r.freeze_used).toBe(true);
    // Consumed this turn — but 7 % 7 === 0 would replenish; freeze_used guards it.
    expect(r.freeze_available).toBe(false);
  });

  test('one missed day WITHOUT freeze resets to 1 and grants a fresh freeze', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 6, best_streak: 9,
      last_completed_date: '2026-07-07', freeze_available: false,
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09');
    expect(r.current_streak).toBe(1);
    expect(r.freeze_used).toBe(false);
    expect(r.freeze_available).toBe(true);
    expect(r.best_streak).toBe(9); // best preserved
  });

  test('large gap resets to 1 regardless of freeze', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 12, best_streak: 12,
      last_completed_date: '2026-07-01', freeze_available: true,
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09'); // gap 8
    expect(r.current_streak).toBe(1);
    expect(r.freeze_used).toBe(false);
  });

  test('reaching 7 consecutive days replenishes the freeze', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 6, best_streak: 6,
      last_completed_date: '2026-07-08', freeze_available: false,
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09'); // gap 1 → 7
    expect(r.current_streak).toBe(7);
    expect(r.freeze_available).toBe(true); // replenished at the 7-day mark
  });

  test('first-ever completion starts at 1 with a freeze available', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 0, best_streak: 0,
      last_completed_date: null, freeze_available: true,
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09');
    expect(r.current_streak).toBe(1);
    expect(updateParams(pool)).not.toBeNull();
  });

  test('missing freeze_available column (pre-migration row) defaults to available', async () => {
    const pool = makePool({
      routine_id: 1, current_streak: 3, best_streak: 3,
      last_completed_date: '2026-07-07', // freeze_available undefined
    });
    const r = await recordRoutineCompletion(pool, 9, 1, '2026-07-09'); // gap 2
    expect(r.current_streak).toBe(4);
    expect(r.freeze_used).toBe(true); // undefined treated as available
  });
});
