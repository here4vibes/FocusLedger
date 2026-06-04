'use strict';

const {
  hashToken,
  createDeletionToken,
  findValidToken,
  markTokenUsed,
  deleteUserCascade,
  getUserById,
  getUserAdminInfo,
  cancelActiveSubscription,
} = require('../db/account-deletion');

// ── hashToken ────────────────────────────────────────────────────────────────
describe('hashToken', () => {
  test('returns a 64-char hex string', () => {
    const h = hashToken('test-input');
    expect(typeof h).toBe('string');
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  test('is deterministic for the same input', () => {
    expect(hashToken('hello')).toBe(hashToken('hello'));
  });

  test('produces different hashes for different inputs', () => {
    expect(hashToken('input-a')).not.toBe(hashToken('input-b'));
  });
});

// ── createDeletionToken ──────────────────────────────────────────────────────
describe('createDeletionToken', () => {
  test('invalidates existing tokens then inserts a new one', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await createDeletionToken(pool, 7);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE account_deletion_tokens/);
    expect(pool.query.mock.calls[0][1]).toEqual([7]);
    expect(pool.query.mock.calls[1][0]).toMatch(/INSERT INTO account_deletion_tokens/);
  });

  test('returns a 64-char hex raw token', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const { raw } = await createDeletionToken(pool, 1);
    expect(typeof raw).toBe('string');
    expect(raw).toHaveLength(64);
  });

  test('expiresAt is approximately 24h from now', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const before = Date.now();
    const { expiresAt } = await createDeletionToken(pool, 1);
    const after = Date.now();
    const ms24h = 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ms24h - 500);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ms24h + 500);
  });

  test('stores a hash of the raw token (not the raw value)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const { raw } = await createDeletionToken(pool, 1);
    const insertedHash = pool.query.mock.calls[1][1][1];
    expect(insertedHash).not.toBe(raw);
    expect(insertedHash).toHaveLength(64);
    expect(insertedHash).toBe(hashToken(raw));
  });
});

// ── findValidToken ───────────────────────────────────────────────────────────
describe('findValidToken', () => {
  test('returns null when no row found', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await findValidToken(pool, 'any-token')).toBeNull();
  });

  test('returns null when token is already used', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 1, user_id: 5, expires_at: new Date(Date.now() + 60000), used: true }]
      })
    };
    expect(await findValidToken(pool, 'raw')).toBeNull();
  });

  test('returns null when token is expired', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 1, user_id: 5, expires_at: new Date(Date.now() - 1000), used: false }]
      })
    };
    expect(await findValidToken(pool, 'raw')).toBeNull();
  });

  test('returns the row when valid (unused and not expired)', async () => {
    const row = { id: 3, user_id: 9, expires_at: new Date(Date.now() + 60000), used: false };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    expect(await findValidToken(pool, 'raw-token')).toEqual(row);
  });

  test('queries by hashed token, not the raw value', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await findValidToken(pool, 'myrawtoken');
    const passedHash = pool.query.mock.calls[0][1][0];
    expect(passedHash).not.toBe('myrawtoken');
    expect(passedHash).toHaveLength(64);
    expect(passedHash).toBe(hashToken('myrawtoken'));
  });
});

// ── markTokenUsed ────────────────────────────────────────────────────────────
describe('markTokenUsed', () => {
  test('issues UPDATE … used = true with the token id', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await markTokenUsed(pool, 42);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE account_deletion_tokens/);
    expect(sql).toMatch(/used = true/);
    expect(params).toEqual([42]);
  });
});

// ── deleteUserCascade ────────────────────────────────────────────────────────
describe('deleteUserCascade', () => {
  test('deletes the user record last', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await deleteUserCascade(pool, 99);
    const calls = pool.query.mock.calls;
    const [lastSql, lastParams] = calls[calls.length - 1];
    expect(lastSql).toMatch(/DELETE FROM users WHERE id/);
    expect(lastParams[0]).toBe(99);
  });

  test('issues more than 10 DELETE statements (covers all tables)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await deleteUserCascade(pool, 1);
    expect(pool.query.mock.calls.length).toBeGreaterThan(10);
  });

  test('passes userId to every child-table DELETE', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await deleteUserCascade(pool, 77);
    const childCalls = pool.query.mock.calls.slice(0, -1);
    for (const [, params] of childCalls) {
      expect(params[0]).toBe(77);
    }
  });

  test('swallows "does not exist" errors so the cascade completes', async () => {
    let callCount = 0;
    const pool = {
      query: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 3) throw new Error('column "user_id" does not exist');
        return { rows: [] };
      })
    };
    await expect(deleteUserCascade(pool, 1)).resolves.toBeUndefined();
  });
});

// ── getUserById ──────────────────────────────────────────────────────────────
describe('getUserById', () => {
  test('returns user when found', async () => {
    const user = { id: 5, email: 'a@b.com', name: 'Alice' };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [user] }) };
    expect(await getUserById(pool, 5)).toEqual(user);
  });

  test('returns null when not found', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await getUserById(pool, 999)).toBeNull();
  });
});

// ── getUserAdminInfo ─────────────────────────────────────────────────────────
describe('getUserAdminInfo', () => {
  test('returns admin info when user exists', async () => {
    const row = { id: 1, email: 'admin@fl.com', is_admin: true };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    expect(await getUserAdminInfo(pool, 1)).toEqual(row);
  });

  test('returns null when user not found', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await getUserAdminInfo(pool, 0)).toBeNull();
  });
});

// ── cancelActiveSubscription ─────────────────────────────────────────────────
describe('cancelActiveSubscription', () => {
  test('issues UPDATE app_subscription with cancelled status', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await cancelActiveSubscription(pool, 12);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE app_subscription/);
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(params[0]).toBe(12);
  });
});
