'use strict';
// A paid Tandem plan includes Autopilot for BOTH people in the linked pair.

const express = require('express');
const request = require('supertest');

// Route queries through the mocked pool directly (no retry wrapper).
jest.mock('../lib/queryWithRetry', () => ({
  queryWithRetry: (pool, text, params) => pool.query(text, params),
}));

const { checkProStatus } = require('../middleware/proUtils');

// Pool whose responses are chosen by SQL text, so query order doesn't matter.
function poolFor({ user = {}, sub = null, partnerPaid = false, activeTasks = 0 }) {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM partnerships p/.test(sql)) return { rows: partnerPaid ? [{ '?column?': 1 }] : [] };
      if (/FROM app_subscription/.test(sql)) return { rows: sub ? [sub] : [] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: String(activeTasks) }] };
      if (/FROM users/.test(sql)) return { rows: [{ admin_pro_override: false, pro_granted_until: null, autopilot_expires_at: null, ...user }] };
      return { rows: [] };
    }),
  };
}

describe('checkProStatus — Tandem partner', () => {
  test('a user whose linked partner pays for Tandem gets Autopilot', async () => {
    await expect(checkProStatus(poolFor({ partnerPaid: true }), 7)).resolves.toBe(true);
  });

  test('no paying partner and no own subscription → not Pro', async () => {
    await expect(checkProStatus(poolFor({ partnerPaid: false }), 7)).resolves.toBe(false);
  });

  test('own active subscription → Pro without consulting the partner', async () => {
    const pool = poolFor({ sub: { plan: 'pro', status: 'active' } });
    await expect(checkProStatus(pool, 7)).resolves.toBe(true);
    expect(pool.query.mock.calls.some(([sql]) => /FROM partnerships p/.test(sql))).toBe(false);
  });

  test('the partner query only counts an ACTIVE partnership with a PAID, unexpired Tandem plan', async () => {
    const pool = poolFor({ partnerPaid: true });
    await checkProStatus(pool, 7);
    const sql = pool.query.mock.calls.map(c => c[0]).find(s => /FROM partnerships p/.test(s));
    expect(sql).toMatch(/p\.status = 'active'/);
    expect(sql).toMatch(/pu\.tandem_plan = 'tandem'/);
    expect(sql).toMatch(/pu\.tandem_expires_at > NOW\(\)/);
  });
});

describe('GET /api/subscription/status — partner access', () => {
  jest.doMock('../middleware/auth', () => ({
    authenticateToken: (req, _res, next) => { req.user = { id: 7, email: 'partner@example.com' }; next(); },
  }));

  function app(pool) {
    const a = express();
    a.use(express.json());
    a.use('/api/subscription', require('../routes/subscription')(pool));
    return a;
  }

  test('reports Pro + Tandem via partner, with no billing of their own', async () => {
    const res = await request(app(poolFor({ partnerPaid: true }))).get('/api/subscription/status');
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({
      is_pro: true, is_tandem: true, pro_via_partner: true, plan_label: 'Tandem', has_stripe_billing: false,
    });
    expect(res.body.limits.max_tasks).toBeNull();
  });

  test('without a paying partner: Free', async () => {
    const res = await request(app(poolFor({ partnerPaid: false }))).get('/api/subscription/status');
    expect(res.body.subscription).toMatchObject({ is_pro: false, pro_via_partner: false, plan_label: 'Free' });
  });

  test('the paying subscriber themselves is not marked pro_via_partner', async () => {
    const pool = poolFor({ sub: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_1' }, partnerPaid: false });
    const res = await request(app(pool)).get('/api/subscription/status');
    expect(res.body.subscription).toMatchObject({ is_pro: true, pro_via_partner: false });
  });
});
