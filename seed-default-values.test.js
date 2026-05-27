'use strict';

/**
 * Regression test: signup → 8 canonical values seeded in correct order.
 *
 * Verifies that lib/seedDefaultValues.js:
 *  1. Seeds exactly the 8 canonical Maslow values
 *  2. In the documented canonical order
 *  3. Does NOT seed if the user already has values (idempotency)
 *
 * This test is unit-level (no real DB) — pool.query is mocked.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const { seedDefaultValues } = require('../lib/seedDefaultValues');

// Canonical names + ranks as documented in engineering-playbook.md
const CANONICAL_NAMES = [
  'Health',
  'Security',
  'Relationships',
  'Growth',
  'Creativity',
  'Autonomy',
  'Learning',
  'Money',
];

describe('seedDefaultValues', () => {
  test('seeds all 8 canonical values when user has none', async () => {
    const insertCalls = [];

    const pool = {
      query: jest.fn().mockImplementation(async (sql, params) => {
        // First call: COUNT query — return 0 to allow seeding
        if (/COUNT/i.test(sql)) {
          return { rows: [{ cnt: '0' }] };
        }
        // Subsequent calls: INSERT statements
        if (/INSERT/i.test(sql)) {
          insertCalls.push({ sql, params });
          return { rows: [] };
        }
        return { rows: [] };
      })
    };

    await seedDefaultValues(pool, 42);

    // Exactly 8 inserts must have been made
    expect(insertCalls).toHaveLength(8);

    // Each insert carries the correct value_name in the expected order
    for (let i = 0; i < CANONICAL_NAMES.length; i++) {
      const params = insertCalls[i].params;
      expect(params[1]).toBe(CANONICAL_NAMES[i]); // $2 = value_name
      expect(params[2]).toBe(i + 1);              // $3 = rank (1-indexed)
    }
  });

  test('seeds with correct userId for each insert', async () => {
    const insertCalls = [];

    const pool = {
      query: jest.fn().mockImplementation(async (sql, params) => {
        if (/COUNT/i.test(sql)) return { rows: [{ cnt: '0' }] };
        if (/INSERT/i.test(sql)) {
          insertCalls.push(params);
          return { rows: [] };
        }
        return { rows: [] };
      })
    };

    await seedDefaultValues(pool, 99);

    // Every insert must use the correct userId ($1)
    for (const params of insertCalls) {
      expect(params[0]).toBe(99);
    }
  });

  test('does NOT seed if user already has values (idempotency guard)', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ cnt: '3' }] }) // already has values
    };

    await seedDefaultValues(pool, 7);

    // Only the COUNT query should have been made — no INSERT
    expect(pool.query).toHaveBeenCalledTimes(1);
    const countSql = pool.query.mock.calls[0][0];
    expect(/COUNT/i.test(countSql)).toBe(true);
  });

  test('is non-fatal: DB error does not throw', async () => {
    const pool = {
      query: jest.fn().mockRejectedValue(new Error('DB connection lost'))
    };

    // Should resolve without throwing — auth must never be blocked by seeding failure
    await expect(seedDefaultValues(pool, 1)).resolves.toBeUndefined();
  });

  test('canonical value names match documented order exactly', () => {
    // This test documents the invariant in code, separate from the runtime path.
    // If someone edits DEFAULT_VALUES in seedDefaultValues.js, this catches drift.
    // We re-require to pick up the module (no cache issues with jest module reset).
    const module = require('../lib/seedDefaultValues');
    // Invoke with a mock that captures the INSERT params order
    const captured = [];
    const pool = {
      query: jest.fn().mockImplementation(async (sql, params) => {
        if (/COUNT/i.test(sql)) return { rows: [{ cnt: '0' }] };
        if (/INSERT/i.test(sql)) captured.push(params[1]); // value_name
        return { rows: [] };
      })
    };

    return module.seedDefaultValues(pool, 1).then(() => {
      expect(captured).toEqual(CANONICAL_NAMES);
    });
  });
});
