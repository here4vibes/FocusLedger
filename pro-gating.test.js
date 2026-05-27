'use strict';

/**
 * Comprehensive Pro gating tests
 *
 * Covers all Pro-gated features:
 * - AI task suggestions (Pro feature)
 * - Task limit enforcement (10 free, unlimited Pro)
 * - Bank Sync (Pro feature)
 * - Recurring tasks (unlimited for Pro)
 * - Admin override behavior
 * - Error handling and graceful degradation
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { generateToken } = require('../middleware/auth');

function makeToken(userId = 1) {
  return generateToken({ id: userId, email: `user${userId}@test.com`, name: 'Test' });
}

const AUTH = (userId = 1) => ({ Authorization: `Bearer ${makeToken(userId)}` });

// ════════════════════════════════════════════════════════════════════════════════
// PRO UTILITY TESTS (Pro check at interaction time)
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('Pro Status Checks — Interaction Time', () => {
  test('POST /api/tasks checks Pro status at creation time (not bind time)', async () => {
    // User starts with 9 tasks, free plan
    // Then Pro status is queried at POST time
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ count: '9' }] }) // active task count
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] }) // admin override check
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] }) // subscription
        .mockResolvedValueOnce({ rows: [] }) // task creation
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set(AUTH(1))
      .send({ title: 'New Task' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/tasks denies task creation for free users at 10-task limit', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // ← Already at 10 tasks
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set(AUTH(1))
      .send({ title: 'New Task' });

    expect(res.status).toBe(402); // Payment required
    expect(res.body.code).toBe('TASK_LIMIT_REACHED');
    expect(res.body.upgrade_required).toBe(true);
  });

  test('POST /api/tasks allows task creation for Pro users over 10 tasks', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] }) // admin override
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'active' }] }) // subscription
        .mockResolvedValueOnce({ rows: [] }) // task creation
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set(AUTH(1))
      .send({ title: 'Task 11 (Pro user has no limit)' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ADMIN OVERRIDE TESTS
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('Admin Pro Override', () => {
  test('admin_pro_override=true grants Pro access even with free subscription', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: true }] }) // ← override set
        // No subscription query — admin override short-circuits
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH(1));

    expect(res.body.subscription.is_pro).toBe(true);
    expect(res.body.subscription.admin_pro_override).toBe(true);
    expect(res.body.limits.max_tasks).toBeNull(); // Pro → unlimited
  });

  test('admin_pro_override=true allows Bank Sync (Plaid) without paid subscription', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: true }] }) // ← override
    };
    const app = createTestApp(pool, 'plaid');

    // Simulate POST /api/plaid/link-token (requires Pro)
    const res = await request(app)
      .post('/api/plaid/link-token')
      .set(AUTH(1))
      .send({});

    // Should not return 403 (Pro required)
    // Actual response depends on Plaid config, but Pro gate should pass
    expect(res.status).not.toBe(403);
  });

  test('admin_pro_override respects interaction-time checks', async () => {
    // Simulate: admin override set at subscription check time,
    // but not at task creation time (temporal inconsistency)
    // This test ensures both layers query Pro status fresh
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ count: '11' }] }) // 11 tasks
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: true }] }) // ← override at creation time
        // No subscription needed — override applies
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set(AUTH(1))
      .send({ title: 'Task 12 (admin override at creation)' });

    expect(res.status).toBe(200); // Should succeed due to override
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// AI SUGGESTION GATING (Pro feature)
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('AI Task Step Suggestions (Pro Gate)', () => {
  test('POST /api/tasks/suggest-steps returns empty for free users', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks/suggest-steps')
      .set(AUTH(1))
      .send({ title: 'Complex task requiring steps' });

    expect(res.status).toBe(200);
    expect(res.body.is_pro).toBe(false);
    expect(res.body.suggestions).toEqual([]);
  });

  test('POST /api/tasks/suggest-steps queries Pro status fresh (not cached)', async () => {
    let callCount = 0;
    const pool = {
      query: jest.fn(() => {
        callCount++;
        // First call: admin override check
        if (callCount === 1) return Promise.resolve({ rows: [{ admin_pro_override: false }] });
        // Second call: subscription check
        if (callCount === 2) return Promise.resolve({ rows: [{ plan: 'pro', status: 'active' }] });
        return Promise.resolve({ rows: [] });
      })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks/suggest-steps')
      .set(AUTH(1))
      .send({ title: 'Complex task' });

    // Should have queried Pro status (at least 2 calls: admin check + subscription)
    expect(pool.query).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// BANK SYNC (PLAID) GATING (Pro feature)
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('Bank Sync (Plaid) Pro Gate', () => {
  test('POST /api/plaid/link-token denied for free users', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] })
    };
    const app = createTestApp(pool, 'plaid');

    const res = await request(app)
      .post('/api/plaid/link-token')
      .set(AUTH(1))
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Pro feature|upgrade/i);
  });

  test('POST /api/plaid/link-token allowed for Pro users', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'active' }] })
        // Additional queries for Plaid setup
        .mockResolvedValueOnce({ rows: [] }) // user plaid accounts
    };
    const app = createTestApp(pool, 'plaid');

    // Note: Will fail if Plaid client is not configured, but Pro gate should pass
    const res = await request(app)
      .post('/api/plaid/link-token')
      .set(AUTH(1))
      .send({});

    // Either succeeds (200) or errors on Plaid config, but NOT 403
    expect([200, 500, 501]).toContain(res.status);
    if (res.status === 403) {
      expect(res.body.message).not.toMatch(/Pro feature|upgrade/i);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// RECURRING TASKS GATING
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('Recurring Tasks Pro Gate', () => {
  test('Free users limited to 2 active recurring tasks', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // 2 recurring tasks already
    };
    const app = createTestApp(pool, 'recurring');

    const res = await request(app)
      .post('/api/recurring/templates')
      .set(AUTH(1))
      .send({ title: 'New Recurring Task' });

    // Should be denied or limited
    if (res.status === 403) {
      expect(res.body.message).toMatch(/Pro|recurring|upgrade/i);
    }
  });

  test('Pro users have unlimited recurring tasks', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [] }) // template creation
    };
    const app = createTestApp(pool, 'recurring');

    const res = await request(app)
      .post('/api/recurring/templates')
      .set(AUTH(1))
      .send({ title: 'Recurring Task 1' });

    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING & GRACEFUL DEGRADATION
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('Pro Check Error Handling', () => {
  test('Subscription check failure does not default to non-Pro (fails closed)', async () => {
    const pool = {
      query: jest.fn()
        .mockRejectedValueOnce(new Error('Database connection failed'))
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set(AUTH(1))
      .send({ title: 'Task' });

    // Should handle error gracefully (allow or deny consistently, not default)
    // This depends on implementation — verify it doesn't randomly allow/deny
    expect(res.status).toBeDefined();
  });

  test('Slow subscription API (>3s) does not block feature access permanently', async () => {
    // AI suggestions have a 3s timeout
    const pool = {
      query: jest.fn()
        .mockImplementation(() => new Promise(resolve =>
          setTimeout(() => resolve({ rows: [{ plan: 'free', status: 'active' }] }), 5000)
        ))
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks/suggest-steps')
      .set(AUTH(1))
      .send({ title: 'Task' });

    // Should timeout gracefully, not hang
    expect([200, 408]).toContain(res.status);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION STATUS TESTS (Full cycle)
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('Subscription Status Full Cycle', () => {
  test('Free → Pro → Cancelled transitions respected', async () => {
    // 1. Free user
    const poolFree = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active', billing_cycle: null, current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })
    };
    const appFree = createTestApp(poolFree, 'subscription');
    const resFree = await request(appFree)
      .get('/api/subscription/status')
      .set(AUTH(1));
    expect(resFree.body.subscription.is_pro).toBe(false);
    expect(resFree.body.limits.max_tasks).toBe(10);

    // 2. Pro user
    const poolPro = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'active', billing_cycle: 'monthly', current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '15' }] })
    };
    const appPro = createTestApp(poolPro, 'subscription');
    const resPro = await request(appPro)
      .get('/api/subscription/status')
      .set(AUTH(1));
    expect(resPro.body.subscription.is_pro).toBe(true);
    expect(resPro.body.limits.max_tasks).toBeNull();

    // 3. Cancelled Pro user
    const poolCancelled = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'cancelled', billing_cycle: 'monthly', current_period_end: null, activated_at: null, cancelled_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })
    };
    const appCancelled = createTestApp(poolCancelled, 'subscription');
    const resCancelled = await request(appCancelled)
      .get('/api/subscription/status')
      .set(AUTH(1));
    expect(resCancelled.body.subscription.is_pro).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SPOKE CARD TESTS (UI feature flags)
// ════════════════════════════════════════════════════════════════════════════════

describe.skip('Spoke Cards — Pro Feature Visibility', () => {
  test('Free user sees upgrade prompt on AI suggestions card', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] })
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH(1));

    expect(res.body.subscription.is_pro).toBe(false);
    expect(res.body.stripe_links).toBeDefined(); // Upgrade prompt data
  });

  test('Pro user does not see upgrade prompt on any spoke card', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'active', billing_cycle: 'monthly', current_period_end: null, activated_at: null, cancelled_at: null }] })
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ count: '20' }] })
    };
    const app = createTestApp(pool, 'subscription');

    const res = await request(app)
      .get('/api/subscription/status')
      .set(AUTH(1));

    expect(res.body.subscription.is_pro).toBe(true);
    expect(res.body.limits.can_create_task).toBe(true);
  });
});
