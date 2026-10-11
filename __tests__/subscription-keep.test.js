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
