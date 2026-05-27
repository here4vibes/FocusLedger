'use strict';

/**
 * Integration tests for routes/values.js
 *
 * Migration 012 dropped the redundant `name` column from user_values.
 * All queries must now use `value_name` only — no `name` column references.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { generateToken } = require('../middleware/auth');

function makeToken(userId = 1) {
  return generateToken({ id: userId, email: `user${userId}@test.com`, name: 'Test' });
}

const AUTH = (userId = 1) => ({ Authorization: `Bearer ${makeToken(userId)}` });

// ────────────────────────────────────────────────────────────────
// GET /api/values
// ────────────────────────────────────────────────────────────────
describe('GET /api/values', () => {
  test('returns list of user values', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [
          { id: 1, user_id: 1, name: 'Health', value_name: 'Health', rank: 1, icon: '💪', color: '#F26B3A' },
          { id: 2, user_id: 1, name: 'Family', value_name: 'Family', rank: 2, icon: '❤️', color: '#3A7FF2' },
        ]
      })
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .get('/api/values')
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.values).toHaveLength(2);
  });

  test('401 without token', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'values');

    const res = await request(app).get('/api/values');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/values — uses value_name only (name column dropped in migration 012)
// ────────────────────────────────────────────────────────────────
describe('POST /api/values', () => {
  test('400 when value_name is empty', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .post('/api/values')
      .set(AUTH())
      .send({ value_name: '' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/value_name is required/i);
  });

  test('INSERT uses value_name only — name column was dropped in migration 012', async () => {
    const created = {
      id: 10, user_id: 1, value_name: 'Growth',
      rank: 1, icon: '⭐', color: '#F26B3A',
      weekly_hours_target: null, weekly_spend_target: null
    };
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })         // count check (< 10)
        .mockResolvedValueOnce({ rows: [{ next_rank: 1 }] })     // get next rank
        .mockResolvedValueOnce({ rows: [created] })              // INSERT
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .post('/api/values')
      .set(AUTH())
      .send({ value_name: 'Growth' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.value.value_name).toBe('Growth');

    // The INSERT query (3rd call) must use value_name only — no `name` column
    const insertCall = pool.query.mock.calls[2];
    const insertSQL = insertCall[0];
    expect(insertSQL).toContain('value_name');    // value_name column present
    expect(insertSQL).not.toMatch(/\bname\b(?!_)/); // standalone `name` column absent

    // $2 is value_name in params: [userId, value_name, rank, icon, color, hrs, spend]
    expect(insertCall[1][1]).toBe('Growth'); // value_name param
  });

  test('400 when user already has 10 values (limit)', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ cnt: '10' }] }) // at limit
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .post('/api/values')
      .set(AUTH())
      .send({ value_name: 'Eleventh Value' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Maximum 10/);
  });

  test('creates value with defaults when optional fields omitted', async () => {
    const created = {
      id: 5, user_id: 1, name: 'Fitness', value_name: 'Fitness',
      rank: 3, icon: '⭐', color: '#F26B3A',
      weekly_hours_target: null, weekly_spend_target: null
    };
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ cnt: '2' }] })
        .mockResolvedValueOnce({ rows: [{ next_rank: 3 }] })
        .mockResolvedValueOnce({ rows: [created] })
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .post('/api/values')
      .set(AUTH())
      .send({ value_name: 'Fitness' }); // no icon or color

    expect(res.status).toBe(200);

    // Defaults applied: icon='⭐', color='#F26B3A'
    // Params: [userId, value_name, rank, icon, color, weekly_hours_target, weekly_spend_target]
    const insertParams = pool.query.mock.calls[2][1];
    expect(insertParams[3]).toBe('⭐');        // icon default (index 3, name col removed)
    expect(insertParams[4]).toBe('#F26B3A'); // color default (index 4, name col removed)
  });
});

// ────────────────────────────────────────────────────────────────
// PUT /api/values/:id — update
// ────────────────────────────────────────────────────────────────
describe('PUT /api/values/:id', () => {
  test('updates value successfully', async () => {
    const updated = { id: 1, user_id: 1, name: 'Wellness', value_name: 'Wellness', rank: 1, icon: '🧘', color: '#aabbcc' };
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .put('/api/values/1')
      .set(AUTH())
      .send({ value_name: 'Wellness', icon: '🧘', color: '#aabbcc' });

    expect(res.status).toBe(200);
    expect(res.body.value.value_name).toBe('Wellness');
  });

  test('400 when value_name is empty on update', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .put('/api/values/1')
      .set(AUTH())
      .send({ value_name: '' });

    expect(res.status).toBe(400);
  });

  test('404 when value not found', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 })
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .put('/api/values/999')
      .set(AUTH())
      .send({ value_name: 'Ghost' });

    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/values/:id
// ────────────────────────────────────────────────────────────────
describe('DELETE /api/values/:id', () => {
  test('deletes value and re-ranks remaining', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 }) // DELETE
        .mockResolvedValueOnce({ rows: [] })                        // re-rank
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .delete('/api/values/2')
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Re-rank query should be called after delete
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('404 when value not found', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 })
    };
    const app = createTestApp(pool, 'values');

    const res = await request(app)
      .delete('/api/values/999')
      .set(AUTH());

    expect(res.status).toBe(404);
  });
});
