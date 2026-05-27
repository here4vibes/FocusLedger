'use strict';

/**
 * Integration tests for routes/subscription.js
 *
 * Covers: Pro gating logic (Stripe active OR admin_pro_override),
 * free-user limits, admin override flow.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { generateToken } = require('../middleware/auth');

function makeToken(userId = 1) {
  return generateToken({ id: userId, email: `user${userId}@test.com`, name: 'Test' });
}
const AUTH = (userId = 1) => ({ Authorization: `Bearer ${makeToken(userId)}` });

describe('GET /api/subscription/status', () => {
  test('401 without token', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app).get('/api/subscription/status');
    expect(res.status).toBe(401);
  });

  test('free user: is_pro=false, max_tasks=10', async () => {
    const pool = {
      query: jest.fn()
        // Promise.all: subscription, user admin override, task count
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active', billing_cycle: null, current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '4' }] })
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription.is_pro).toBe(false);
    expect(res.body.limits.max_tasks).toBe(10);
    expect(res.body.limits.tasks_remaining).toBe(6); // 10 - 4
    expect(res.body.limits.can_create_task).toBe(true);
  });

  test('Pro user via Stripe: is_pro=true, max_tasks=null (unlimited)', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'active', billing_cycle: 'monthly', current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '15' }] }) // 15 active tasks, but Pro so no limit
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH());

    expect(res.body.subscription.is_pro).toBe(true);
    expect(res.body.limits.max_tasks).toBeNull();
    expect(res.body.limits.tasks_remaining).toBeNull();
    expect(res.body.limits.can_create_task).toBe(true);
  });

  test('admin_pro_override=true gives Pro access even with free Stripe sub', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active', billing_cycle: null, current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: true }] })  // ← override set
        .mockResolvedValueOnce({ rows: [{ count: '12' }] })
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH());

    expect(res.body.subscription.is_pro).toBe(true);
    expect(res.body.subscription.admin_pro_override).toBe(true);
    expect(res.body.limits.max_tasks).toBeNull();
  });

  test('cancelled Pro sub: is_pro=false', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'cancelled', billing_cycle: 'monthly', current_period_end: null, activated_at: null, cancelled_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH());

    expect(res.body.subscription.is_pro).toBe(false);
    expect(res.body.limits.max_tasks).toBe(10);
  });

  test('free user at exactly 10 tasks: can_create_task=false', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active', billing_cycle: null, current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // AT the limit
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH());

    expect(res.body.limits.can_create_task).toBe(false);
    expect(res.body.limits.tasks_remaining).toBe(0);
  });

  test('includes stripe_links in response', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active', billing_cycle: null, current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH());

    expect(res.body.stripe_links).toBeDefined();
    expect(res.body.stripe_links.monthly).toMatch(/stripe\.com/);
    expect(res.body.stripe_links.annual).toMatch(/stripe\.com/);
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/subscription/cancel
// ────────────────────────────────────────────────────────────────
describe('POST /api/subscription/cancel', () => {
  test('cancels subscription', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] })
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .post('/api/subscription/cancel')
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
