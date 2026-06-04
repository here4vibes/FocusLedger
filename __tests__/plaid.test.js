'use strict';

const {
  getItemsForUser,
  getItemById,
  getRawItemsForUser,
  getAllItems,
  insertItem,
  updateItemCursor,
  deleteItem,
  upsertAccount,
  getAccountMap,
  countPendingReview,
  getPendingTransactions,
  insertTransaction,
  removeTransaction,
  getUnconfirmedTransaction,
  confirmTransaction,
  dismissTransaction,
  recategorizeTransaction,
  getDisabledMerchantKeys,
  upsertBillPreference,
} = require('../db/plaid');

// ── Item queries ─────────────────────────────────────────────────────────────
describe('getItemsForUser', () => {
  test('queries by userId and returns rows', async () => {
    const rows = [{ id: 1, institution_name: 'Chase', accounts: [] }];
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    const result = await getItemsForUser(pool, 42);
    expect(result).toEqual(rows);
    expect(pool.query.mock.calls[0][1]).toEqual([42]);
  });
});

describe('getItemById', () => {
  test('returns the item when found', async () => {
    const item = { id: 5, user_id: 1 };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [item] }) };
    expect(await getItemById(pool, 5, 1)).toEqual(item);
  });

  test('returns null when not found', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await getItemById(pool, 999, 1)).toBeNull();
  });
});

describe('insertItem', () => {
  test('inserts with encrypted token and returns the row', async () => {
    const row = { id: 10, user_id: 1, item_id: 'plaid-item-abc', institution_name: 'Wells Fargo' };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const result = await insertItem(pool, 1, 'encrypted-token', 'plaid-item-abc', 'Wells Fargo', 'ins_123');
    expect(result).toEqual(row);
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe(1);
    expect(params[1]).toBe('encrypted-token');
    expect(params[2]).toBe('plaid-item-abc');
    expect(params[3]).toBe('Wells Fargo');
  });

  test('defaults institution_name to Unknown Bank when null', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{}] }) };
    await insertItem(pool, 1, 'token', 'item-id', null, null);
    const params = pool.query.mock.calls[0][1];
    expect(params[3]).toBe('Unknown Bank');
    expect(params[4]).toBeNull();
  });
});

describe('updateItemCursor', () => {
  test('issues UPDATE with cursor and itemId', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await updateItemCursor(pool, 7, 'next-cursor-value');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE plaid_items/);
    expect(params[0]).toBe('next-cursor-value');
    expect(params[1]).toBe(7);
  });
});

describe('deleteItem', () => {
  test('issues DELETE scoped to userId', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await deleteItem(pool, 3, 9);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM plaid_items/);
    expect(params).toEqual([3, 9]);
  });
});

// ── Account queries ───────────────────────────────────────────────────────────
describe('upsertAccount', () => {
  test('upserts by account_id and returns row', async () => {
    const row = { id: 20, account_id: 'acc_abc', name: 'Checking' };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const acc = { account_id: 'acc_abc', name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1234' };
    const result = await upsertAccount(pool, 1, 5, acc);
    expect(result).toEqual(row);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(account_id\) DO UPDATE/);
  });
});

describe('getAccountMap', () => {
  test('returns a map of account_id → db id', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 10, account_id: 'acc_a' }, { id: 11, account_id: 'acc_b' }]
      })
    };
    const map = await getAccountMap(pool, 1);
    expect(map).toEqual({ acc_a: 10, acc_b: 11 });
  });

  test('returns empty object when no accounts', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await getAccountMap(pool, 99)).toEqual({});
  });
});

// ── Transaction queries ───────────────────────────────────────────────────────
describe('countPendingReview', () => {
  test('returns integer count from query', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ count: '7' }] }) };
    expect(await countPendingReview(pool, 5)).toBe(7);
  });
});

describe('insertTransaction', () => {
  test('returns true when row is inserted', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    const result = await insertTransaction(pool, {
      plaidAccountId: 1, userId: 2, transactionId: 'tx_abc', amount: 12.50,
      description: 'Coffee', merchantName: 'Starbucks', categoryId: 3,
      plaidCategory: 'Food and Drink', transactionDate: '2026-05-01', isPending: false,
    });
    expect(result).toBe(true);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(transaction_id\) DO NOTHING/);
  });

  test('returns false on duplicate (no rows returned)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await insertTransaction(pool, {
      plaidAccountId: 1, userId: 2, transactionId: 'tx_dup', amount: 5,
      description: 'Dup', merchantName: null, categoryId: 1,
      plaidCategory: 'Other', transactionDate: '2026-05-01', isPending: false,
    });
    expect(result).toBe(false);
  });
});

describe('removeTransaction', () => {
  test('deletes unconfirmed transaction scoped to userId', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await removeTransaction(pool, 'tx_gone', 8);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM plaid_transactions/);
    expect(sql).toMatch(/is_confirmed = false/);
    expect(params).toEqual(['tx_gone', 8]);
  });
});

describe('confirmTransaction', () => {
  test('marks is_confirmed=true and links expense_id', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await confirmTransaction(pool, 15, 88);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/is_confirmed = true/);
    expect(params).toEqual([88, 15]);
  });
});

describe('dismissTransaction', () => {
  test('returns true when row is dismissed', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    expect(await dismissTransaction(pool, 5, 3)).toBe(true);
  });

  test('returns false when not found or wrong user', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await dismissTransaction(pool, 999, 1)).toBe(false);
  });
});

// ── Bill preferences ──────────────────────────────────────────────────────────
describe('getDisabledMerchantKeys', () => {
  test('returns a Set of disabled merchant keys', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ merchant_key: 'amazon' }, { merchant_key: 'netflix' }]
      })
    };
    const result = await getDisabledMerchantKeys(pool, 1);
    expect(result).toBeInstanceOf(Set);
    expect(result.has('amazon')).toBe(true);
    expect(result.has('netflix')).toBe(true);
    expect(result.size).toBe(2);
  });

  test('returns empty Set when none disabled', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await getDisabledMerchantKeys(pool, 1);
    expect(result.size).toBe(0);
  });
});

describe('upsertBillPreference', () => {
  test('upserts using ON CONFLICT on (user_id, merchant_key)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await upsertBillPreference(pool, 1, 'amazon', true);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/s);
    expect(params).toEqual([1, 'amazon', true]);
  });
});
