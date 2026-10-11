'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const express = require('express');
const request = require('supertest');
const { generateToken } = require('../middleware/auth');
const { keepSubscription } = require('../db/bills');

describe('keepSubscription', () => {
  test('upserts the merchant as a kept subscription', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await keepSubscription(pool, 7, 'netflix', 'Netflix');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/kept_at = NOW\(\)/);
    expect(sql).toMatch(/ON CONFLICT \(user_id, merchant_key\)/);
    expect(params).toEqual([7, 'netflix', 'Netflix']);
  });
});

describe('POST /api/plaid/recurring/:key/keep', () => {
  const app = (pool) => { const a = express(); a.use(express.json()); a.use('/api/plaid', require('../routes/plaid')(pool)); return a; };
  const auth = 'Bearer ' + generateToken({ id: 7, email: 'u7@example.com' });

  test('requires auth', async () => {
    const pool = { query: jest.fn() };
    const res = await request(app(pool)).post('/api/plaid/recurring/netflix/keep');
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects a malformed merchant key without touching the DB', async () => {
    const pool = { query: jest.fn() };
    const res = await request(app(pool)).post('/api/plaid/recurring/Bad%20Key/keep').set('Authorization', auth);
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('saves for the signed-in user', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const res = await request(app(pool)).post('/api/plaid/recurring/netflix/keep').set('Authorization', auth).send({ name: 'Netflix' });
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([7, 'netflix', 'Netflix']);
  });

  test('500 when the save fails', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const res = await request(app(pool)).post('/api/plaid/recurring/netflix/keep').set('Authorization', auth);
    expect(res.status).toBe(500);
  });
});

describe('cancellationVerdict', () => {
  const { cancellationVerdict } = require('../lib/bill-guardian');
  const day = (s) => Date.parse(s + 'T12:00:00Z');
  const pref = { merchant_key: 'netflix', cancel_requested_at: new Date('2026-10-11T15:00:00Z'),
    cancel_expected_by: '2026-10-16', cancel_frequency: 'monthly' };
  const tx = (date, name = 'Netflix', amount = 15.49) => ({ merchant_name: name, amount, transaction_date: date });

  test('too early to tell before expected date + grace', () => {
    expect(cancellationVerdict(pref, [tx('2026-09-16')], day('2026-10-20'))).toBeNull();
  });
  test('confirmed once past expected date + tolerance + posting lag with no new charge', () => {
    // monthly tol 4 + lag 3 = 7 days after Oct 16
    expect(cancellationVerdict(pref, [tx('2026-09-16')], day('2026-10-23'))).toBeNull();
    expect(cancellationVerdict(pref, [tx('2026-09-16')], day('2026-10-24'))).toBe('confirmed');
  });
  test('charged_again when the merchant charges after the request day', () => {
    expect(cancellationVerdict(pref, [tx('2026-10-16')], day('2026-10-17'))).toBe('charged_again');
  });
  test('a charge on the request day itself does not count against it', () => {
    expect(cancellationVerdict(pref, [tx('2026-10-11')], day('2026-10-24'))).toBe('confirmed');
  });
  test('other merchants and refunds are ignored', () => {
    expect(cancellationVerdict(pref, [tx('2026-10-16', 'Hulu'), tx('2026-10-17', 'Netflix', -15.49)], day('2026-10-24'))).toBe('confirmed');
  });
});

describe('cancel endpoints', () => {
  const app = (pool) => { const a = express(); a.use(express.json()); a.use('/api/plaid', require('../routes/plaid')(pool)); return a; };
  const auth = 'Bearer ' + generateToken({ id: 7, email: 'u7@example.com' });

  test('POST records a pending cancel and returns the known cancel page', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const res = await request(app(pool)).post('/api/plaid/recurring/netflix/cancel').set('Authorization', auth)
      .send({ name: 'Netflix', expected_by: '2026-10-16', amount: 15.49, frequency: 'monthly' });
    expect(res.status).toBe(200);
    expect(res.body.cancel_link.url).toBe('https://www.netflix.com/cancelplan');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/cancel_status = 'pending'/);
    expect(params).toEqual([7, 'netflix', 'Netflix', '2026-10-16', '15.49', 'monthly']);
  });

  test('POST rejects missing or bad fields without touching the DB', async () => {
    const pool = { query: jest.fn() };
    for (const body of [{}, { expected_by: '10/16', amount: 5, frequency: 'monthly' },
      { expected_by: '2026-10-16', amount: -1, frequency: 'monthly' }, { expected_by: '2026-10-16', amount: 5, frequency: 'daily' }]) {
      const res = await request(app(pool)).post('/api/plaid/recurring/netflix/cancel').set('Authorization', auth).send(body);
      expect(res.status).toBe(400);
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('DELETE clears only a pending request', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const res = await request(app(pool)).delete('/api/plaid/recurring/netflix/cancel').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toMatch(/cancel_status = 'pending'/);
  });

  test('unknown merchants get no link', async () => {
    const { cancelLinkFor } = require('../lib/cancel-links');
    expect(cancelLinkFor('Joe\'s Gym')).toBeNull();
    expect(cancelLinkFor('APPLE.COM/BILL').store).toBe(true);
  });
});

describe('runBillGuardian settles pending cancellations', () => {
  const { runBillGuardian } = require('../lib/bill-guardian');
  test('confirms a quiet merchant and flags one that charged again', async () => {
    const resolved = [];
    const db = {
      getRecentOutflows: async () => [
        { merchant_name: 'Hulu', amount: 17.99, transaction_date: '2026-10-14' },
      ],
      getBillPreferences: async () => [
        { merchant_key: 'netflix', cancel_status: 'pending', cancel_requested_at: new Date('2026-10-01T12:00:00Z'), cancel_expected_by: '2026-10-05', cancel_frequency: 'monthly' },
        { merchant_key: 'hulu', cancel_status: 'pending', cancel_requested_at: new Date('2026-10-01T12:00:00Z'), cancel_expected_by: '2026-10-14', cancel_frequency: 'monthly' },
        { merchant_key: 'spotify', cancel_status: 'confirmed', cancel_requested_at: new Date('2026-09-01T12:00:00Z') },
      ],
      resolveCancellation: async (pool, userId, key, status) => { resolved.push([key, status]); return true; },
    };
    const out = await runBillGuardian({}, 7, { today: new Date('2026-10-20T12:00:00Z'), db });
    expect(resolved).toEqual([['netflix', 'confirmed'], ['hulu', 'charged_again']]);
    expect(out.cancellations).toEqual({ confirmed: 1, chargedAgain: 1 });
  });
});
