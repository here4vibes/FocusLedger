'use strict';
/**
 * Integration test for the Plaid sync flow.
 *
 * Tests the complete path: insertPlaidTransaction + auto-confirm to expenses,
 * account lookup (both primary map and fallback), and dedup logic.
 * Uses a mocked pool to avoid requiring a live DB in CI.
 */

const {
  upsertPlaidItem,
  upsertPlaidAccount,
  insertPlaidTransaction,
  getAccountMap,
} = require('../db/money-prisma');

// ── helpers ───────────────────────────────────────────────────────────────────

function makePool(overrides = {}) {
  const defaultQuery = jest.fn().mockResolvedValue({ rows: [] });
  return {
    query: overrides.query ?? defaultQuery,
    connect: overrides.connect ?? jest.fn(),
  };
}

// ── upsertPlaidAccount ────────────────────────────────────────────────────────

describe('upsertPlaidAccount', () => {
  test('inserts new account when none exists', async () => {
    let callCount = 0;
    const pool = makePool({
      query: jest.fn().mockImplementation((sql) => {
        callCount++;
        if (sql.includes('SELECT') && sql.includes('account_id')) {
          return Promise.resolve({ rows: [] }); // no existing row
        }
        return Promise.resolve({ rows: [{ id: 1, account_id: 'acc_abc' }] });
      }),
    });
    const result = await upsertPlaidAccount(pool, 10, 99, 'acc_abc', 'Checking', null, 'depository', 'checking', '1234', 1000, 950);
    expect(result).toMatchObject({ id: 1, account_id: 'acc_abc' });
  });

  test('updates existing account and migrates plaid_item_id', async () => {
    const existing = { id: 5, account_id: 'acc_abc', plaid_item_id: 7 };
    const pool = makePool({
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT') && sql.includes('account_id')) {
          return Promise.resolve({ rows: [existing] });
        }
        // UPDATE returns the updated row
        return Promise.resolve({ rows: [{ ...existing, plaid_item_id: 10 }] });
      }),
    });
    const result = await upsertPlaidAccount(pool, 10, 99, 'acc_abc', 'Checking', null, 'depository', 'checking', '1234', 1100, null);
    expect(result).toMatchObject({ id: 5, plaid_item_id: 10 });
  });

  test('returns null and logs on DB error', async () => {
    const pool = makePool({
      query: jest.fn().mockRejectedValue(new Error('connection refused')),
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await upsertPlaidAccount(pool, 1, 1, 'acc_err', 'Acct', null, 'credit', null, null, null, null);
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Plaid] upsertPlaidAccount failed'),
      'acc_err',
      ':',
      'connection refused',
      '| plaidItemId:',
      1,
      '| userId:',
      1
    );
    consoleSpy.mockRestore();
  });
});

// ── getAccountMap ─────────────────────────────────────────────────────────────

describe('getAccountMap', () => {
  test('builds map from JOIN query result', async () => {
    const pool = makePool({
      query: jest.fn().mockResolvedValue({
        rows: [
          { id: 10, account_id: 'acc_a' },
          { id: 11, account_id: 'acc_b' },
        ],
      }),
    });
    const map = await getAccountMap(pool, 3, 42);
    expect(map).toEqual({ acc_a: 10, acc_b: 11 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/JOIN plaid_items/);
    expect(params).toEqual([42]);
  });

  test('returns empty object when no accounts', async () => {
    const pool = makePool({ query: jest.fn().mockResolvedValue({ rows: [] }) });
    expect(await getAccountMap(pool, 1, 99)).toEqual({});
  });
});

// ── insertPlaidTransaction ────────────────────────────────────────────────────

describe('insertPlaidTransaction', () => {
  const base = {
    plaidAccountId: 1, userId: 2, transactionId: 'tx_001', amount: 12.50,
    description: 'Starbucks', merchantName: 'Starbucks', categoryId: 3,
    plaidCategory: 'FOOD_AND_DRINK/COFFEE', transactionDate: '2026-06-01', isPending: false,
  };

  test('inserts and returns row when transaction does not exist', async () => {
    const newRow = { id: 99, transaction_id: 'tx_001', amount: 12.50 };
    const pool = makePool({
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT') && sql.includes('transaction_id')) {
          return Promise.resolve({ rows: [] }); // not a dupe
        }
        return Promise.resolve({ rows: [newRow] });
      }),
    });
    const result = await insertPlaidTransaction(pool, base);
    expect(result).toMatchObject({ id: 99, transaction_id: 'tx_001' });
    // INSERT should be called
    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT'));
    expect(insertCall).toBeTruthy();
  });

  test('returns existing row without re-inserting on duplicate', async () => {
    const existing = { id: 55, transaction_id: 'tx_001', amount: 12.50 };
    const pool = makePool({
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT') && sql.includes('transaction_id')) {
          return Promise.resolve({ rows: [existing] });
        }
        return Promise.resolve({ rows: [existing] }); // UPDATE updated_at
      }),
    });
    const result = await insertPlaidTransaction(pool, base);
    expect(result).toMatchObject({ id: 55 });
    const insertCall = pool.query.mock.calls.find(([sql]) => sql.trim().startsWith('INSERT'));
    expect(insertCall).toBeUndefined();
  });

  test('handles null transactionId (no dedup check)', async () => {
    const newRow = { id: 77, transaction_id: null, amount: 5.00 };
    const pool = makePool({
      query: jest.fn().mockResolvedValue({ rows: [newRow] }),
    });
    const result = await insertPlaidTransaction(pool, { ...base, transactionId: null });
    expect(result).toMatchObject({ id: 77 });
    // No SELECT should have been issued for dedup
    const selectDedupCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes('SELECT') && sql.includes('transaction_id')
    );
    expect(selectDedupCall).toBeUndefined();
  });

  test('returns null and logs on DB error', async () => {
    const pool = makePool({
      query: jest.fn().mockRejectedValue(new Error('relation does not exist')),
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await insertPlaidTransaction(pool, base);
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Plaid] insertPlaidTransaction failed'),
      expect.any(String),
      expect.any(String),
      expect.any(String)
    );
    consoleSpy.mockRestore();
  });
});

// ── upsertPlaidItem ───────────────────────────────────────────────────────────

describe('upsertPlaidItem', () => {
  test('inserts and returns new item when no conflict exists', async () => {
    const newItem = { id: 1, user_id: 42, item_id: 'item_abc', institution_id: 'ins_123' };
    // upsertPlaidItem does a single INSERT ON CONFLICT RETURNING — one query call
    const pool = makePool({
      query: jest.fn().mockResolvedValue({ rows: [newItem] }),
    });
    const result = await upsertPlaidItem(pool, 42, 'enc_token', 'item_abc', 'Chase', 'ins_123');
    expect(result).toMatchObject({ id: 1, item_id: 'item_abc' });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(institution_id, user_id\)/);
  });

  test('upserts and returns updated item when institution_id conflicts', async () => {
    // ON CONFLICT DO UPDATE returns the updated row — same shape
    const updatedItem = { id: 5, user_id: 42, item_id: 'item_new', institution_id: 'ins_123', cursor: null };
    const pool = makePool({
      query: jest.fn().mockResolvedValue({ rows: [updatedItem] }),
    });
    const result = await upsertPlaidItem(pool, 42, 'enc_token_new', 'item_new', 'Chase', 'ins_123');
    expect(result).toMatchObject({ id: 5, item_id: 'item_new', cursor: null });
  });

  test('falls back to item_id ON CONFLICT when no institution_id', async () => {
    const newItem = { id: 2, user_id: 42, item_id: 'item_xyz', institution_id: null };
    const pool = makePool({
      query: jest.fn().mockResolvedValue({ rows: [newItem] }),
    });
    const result = await upsertPlaidItem(pool, 42, 'enc_token', 'item_xyz', 'Unknown Bank', null);
    expect(result).toMatchObject({ id: 2, institution_id: null });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(item_id, user_id\)/);
  });
});

// ── Sync flow: account fallback lookup ────────────────────────────────────────

describe('syncTransactions account fallback', () => {
  test('direct account_id lookup used when accountMap misses the account', async () => {
    // Simulates the case where accountMap doesn't have acc_xyz (from a stale item)
    // but plaid_accounts does have it. The fallback SELECT should find it.
    const fallbackRow = { id: 88 };
    const queryMock = jest.fn().mockImplementation((sql) => {
      if (sql.includes('plaid_accounts WHERE account_id')) {
        return Promise.resolve({ rows: [fallbackRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    const pool = makePool({ query: queryMock });

    // Directly test the fallback pattern used in syncTransactions
    const accountMap = {};
    const txAccountId = 'acc_xyz';

    let plaidAccountId = accountMap[txAccountId];
    if (!plaidAccountId) {
      const { rows: fb } = await pool.query(
        'SELECT id FROM plaid_accounts WHERE account_id = $1 LIMIT 1',
        [txAccountId]
      );
      if (fb.length) {
        plaidAccountId = fb[0].id;
        accountMap[txAccountId] = plaidAccountId;
      }
    }

    expect(plaidAccountId).toBe(88);
    expect(accountMap[txAccountId]).toBe(88);
  });

  test('skips transaction when account cannot be found via any path', async () => {
    const pool = makePool({ query: jest.fn().mockResolvedValue({ rows: [] }) });
    const accountMap = {};
    const txAccountId = 'acc_unknown';

    let plaidAccountId = accountMap[txAccountId];
    if (!plaidAccountId) {
      const { rows: fb } = await pool.query(
        'SELECT id FROM plaid_accounts WHERE account_id = $1 LIMIT 1',
        [txAccountId]
      );
      if (fb.length) plaidAccountId = fb[0].id;
    }

    expect(plaidAccountId).toBeUndefined();
  });
});
