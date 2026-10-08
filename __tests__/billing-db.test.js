'use strict';

const billingDb = require('../db/billing');

function mockPool(clientQueryImpl) {
  const client = { query: jest.fn(clientQueryImpl), release: jest.fn() };
  return { pool: { connect: jest.fn().mockResolvedValue(client), query: jest.fn() }, client };
}
const sqlOf = (client) => client.query.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' ').trim());

describe('recordActivation', () => {
  const base = {
    userId: 42, sessionId: 'cs_1', subscriptionId: 'sub_1', customerId: 'cus_1',
    billingCycle: 'monthly', periodEnd: new Date('2026-11-08T00:00:00Z'), tandemExpiresAt: null,
  };

  test('first purchase: inserts inside a transaction and reports firstActivation', async () => {
    const { pool, client } = mockPool(async (sql) => (/SELECT id, activated_at/.test(sql) ? { rows: [] } : { rows: [] }));
    const r = await billingDb.recordActivation(pool, base);
    expect(r).toEqual({ duplicate: false, firstActivation: true });
    const sql = sqlOf(client);
    expect(sql[0]).toBe('BEGIN');
    expect(sql.some(s => s.startsWith('INSERT INTO app_subscription'))).toBe(true);
    expect(sql[sql.length - 1]).toBe('COMMIT');
    expect(sql.some(s => /tandem_plan/.test(s))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  test('Tandem purchase also sets tandem access and starts the partner trial', async () => {
    const { pool, client } = mockPool(async () => ({ rows: [] }));
    await billingDb.recordActivation(pool, { ...base, tandemExpiresAt: new Date('2026-11-11T00:00:00Z') });
    const sql = sqlOf(client);
    expect(sql.some(s => /SET tandem_plan = 'tandem'/.test(s))).toBe(true);
    expect(sql.some(s => /UPDATE partnerships/.test(s))).toBe(true);
  });

  test('UNIQUE violation (webhook/redirect race) → rolled back, reported as duplicate', async () => {
    const { pool, client } = mockPool(async (sql) => {
      if (/INSERT INTO app_subscription/.test(sql)) throw Object.assign(new Error('dup'), { code: '23505' });
      return { rows: [] };
    });
    const r = await billingDb.recordActivation(pool, base);
    expect(r).toEqual({ duplicate: true });
    expect(sqlOf(client)).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('any other DB error rolls back and is thrown (no silent failure)', async () => {
    const { pool, client } = mockPool(async (sql) => {
      if (/UPDATE users SET pro_granted_by/.test(sql)) throw new Error('boom');
      return { rows: [] };
    });
    await expect(billingDb.recordActivation(pool, base)).rejects.toThrow('boom');
    expect(sqlOf(client)).toContain('ROLLBACK');
  });
});
