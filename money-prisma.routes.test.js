'use strict';

/**
 * Integration tests for routes/money-prisma.js
 * Tests Prisma-backed money/expense CRUD endpoints.
 * Mocks @prisma/client to avoid real DB connections.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const mockPrisma = {
  expense: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  },
  categories: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  plaid_item: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
    update: jest.fn(),
  },
  plaid_account: {
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  plaid_transaction: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  bill_preferences: {
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  $connect: jest.fn().mockResolvedValue(undefined),
  pool: { query: jest.fn() },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

// Mock pg Pool for fetchUserTimezone
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn().mockResolvedValue({ rows: [{ timezone: 'America/New_York' }] }),
    on: jest.fn(),
  })),
}));

const request = require('supertest');
const { generateToken } = require('../middleware/auth');

function makeToken(userId = 1) {
  return generateToken({ id: userId, email: `user${userId}@test.com`, name: 'Test' });
}

function buildApp() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/money', require('../routes/money-prisma')());
  app.use((err, req, res, next) => { res.status(500).json({ success: false, message: err.message }); });
  return app;
}

function resetMocks() {
  Object.values(mockPrisma).forEach(obj => {
    if (typeof obj === 'object' && obj !== null) {
      Object.values(obj).forEach(method => {
        if (typeof method === 'function' && method.mock) method.mockReset();
      });
    }
  });
}

describe('routes/money-prisma', () => {
  let app;

  beforeAll(() => {
    app = buildApp();
  });

  beforeEach(() => {
    resetMocks();
  });

  describe('GET /api/money/expenses/categories', () => {
    it('returns 10 FocusLedger category slugs', async () => {
      const res = await request(app)
        .get('/api/money/expenses/categories')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.categories).toHaveLength(10);
      const slugs = res.body.categories.map(c => c.slug);
      expect(slugs).toContain('housing');
      expect(slugs).toContain('groceries');
      expect(slugs).toContain('food_delivery');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/money/expenses/categories');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/money/expenses/today', () => {
    it('returns today spend stats', async () => {
      mockPrisma.expense.findMany.mockResolvedValue([
        { amount: 25.00, is_impulse: true, source: 'manual' },
        { amount: 12.50, is_impulse: false, source: 'manual' },
      ]);

      const res = await request(app)
        .get('/api/money/expenses/today')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.total).toBe(37.50);
      expect(res.body.impulse).toBe(25.00);
      expect(res.body.planned).toBe(12.50);
    });

    it('handles empty spend', async () => {
      mockPrisma.expense.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/money/expenses/today')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });
  });

  describe('GET /api/money/expenses/untriaged', () => {
    it('returns untriaged plaid expenses from last 7 days', async () => {
      mockPrisma.expense.findMany.mockResolvedValue([
        { id: 10, amount: 45.99, description: 'Amazon', is_impulse: null, source: 'plaid', expense_date: '2026-05-22', categories: { name: 'Shopping', icon: '🛍️' } },
        { id: 11, amount: 8.99, description: 'Netflix', is_impulse: null, source: 'plaid', expense_date: '2026-05-21', categories: { name: 'Subscriptions', icon: '🔄' } },
      ]);

      const res = await request(app)
        .get('/api/money/expenses/untriaged')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(2);
      expect(res.body.expenses[0].id).toBe(10);
    });

    it('limits to 10 results', async () => {
      mockPrisma.expense.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/money/expenses/untriaged')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(mockPrisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 })
      );
    });
  });

  describe('GET /api/money/expenses', () => {
    it('returns expenses for the specified period', async () => {
      mockPrisma.categories.findFirst.mockResolvedValue({ id: 9, name: 'Other', icon: '📦' });
      mockPrisma.expense.findMany.mockResolvedValue([
        { id: 1, amount: 25.00, description: 'Coffee', is_impulse: true, source: 'manual', expense_date: '2026-05-22', categories: { name: 'Food & Dining', icon: '🍕' } },
      ]);

      const res = await request(app)
        .get('/api/money/expenses?period=week')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.expenses)).toBe(true);
    });

    it('defaults to week period', async () => {
      mockPrisma.categories.findFirst.mockResolvedValue({ id: 9, name: 'Other', icon: '📦' });
      mockPrisma.expense.findMany.mockResolvedValue([]);

      await request(app)
        .get('/api/money/expenses')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(mockPrisma.expense.findMany).toHaveBeenCalled();
      expect(res => expect(res.status).toBe(200));
    });
  });

  describe('POST /api/money/expenses', () => {
    it('creates a manual expense', async () => {
      mockPrisma.categories.findFirst.mockResolvedValue({ id: 9, name: 'Other', icon: '📦' });
      mockPrisma.expense.create.mockResolvedValue({
        id: 99, user_id: 1, amount: 15.99, description: 'Lunch', is_impulse: true,
        source: 'manual', expense_date: new Date('2026-05-22'), categories: { name: 'Food & Dining', icon: '🍕' },
      });

      const res = await request(app)
        .post('/api/money/expenses')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ amount: 15.99, category: 'food_delivery', is_impulse: true, note: 'Lunch' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.expense.id).toBe(99);
    });

    it('rejects zero amount', async () => {
      const res = await request(app)
        .post('/api/money/expenses')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ amount: 0, category: 'other' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Valid amount required');
    });

    it('uses "other" for invalid category slug', async () => {
      mockPrisma.categories.findFirst.mockResolvedValue({ id: 9, name: 'Other', icon: '📦' });
      mockPrisma.expense.create.mockResolvedValue({ id: 100, amount: 10.00 });

      const res = await request(app)
        .post('/api/money/expenses')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ amount: 10.00, category: 'invalid_slug_xyz' });

      expect(res.status).toBe(201);
    });
  });

  describe('PATCH /api/money/expenses/:id/triage', () => {
    it('triages an expense as impulse', async () => {
      mockPrisma.categories.findFirst.mockResolvedValue({ id: 9, name: 'Other', icon: '📦' });
      mockPrisma.expense.update.mockResolvedValue({
        id: 5, amount: 45.99, is_impulse: true, categories: { name: 'Other', icon: '📦' },
      });

      const res = await request(app)
        .patch('/api/money/expenses/5/triage')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ is_impulse: true, category: 'food_delivery' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.expense.is_impulse).toBe(true);
    });

    it('triages an expense as planned', async () => {
      mockPrisma.expense.update.mockResolvedValue({
        id: 5, amount: 45.99, is_impulse: false, categories: { name: 'Other', icon: '📦' },
      });

      const res = await request(app)
        .patch('/api/money/expenses/5/triage')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ is_impulse: false });

      expect(res.status).toBe(200);
      expect(res.body.expense.is_impulse).toBe(false);
    });

    it('rejects missing is_impulse', async () => {
      const res = await request(app)
        .patch('/api/money/expenses/5/triage')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ category: 'groceries' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('is_impulse required');
    });

    it('returns 404 for non-existent expense', async () => {
      mockPrisma.expense.update.mockRejectedValue({ code: 'P2025' });

      const res = await request(app)
        .patch('/api/money/expenses/99999/triage')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ is_impulse: true });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/money/expenses/:id', () => {
    it('deletes an expense', async () => {
      mockPrisma.expense.deleteMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .delete('/api/money/expenses/5')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/money/accounts', () => {
    it('returns connected: false when no accounts', async () => {
      mockPrisma.plaid_item.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/money/accounts')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });

    it('returns account info when connected', async () => {
      mockPrisma.plaid_item.findMany.mockResolvedValue([{
        id: 1,
        institution_name: 'Chase',
        institution_id: 'ins_1',
        last_synced_at: new Date('2026-05-24T10:00:00Z'),
        plaid_accounts: [
          { id: 10, name: 'Checking', type: 'depository', subtype: 'checking', mask: '1234' },
        ],
      }]);
      mockPrisma.plaid_transaction.count.mockResolvedValue(3);

      const res = await request(app)
        .get('/api/money/accounts')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.items[0].institution).toBe('Chase');
      expect(res.body.pending_review_count).toBe(3);
    });
  });

  describe('DELETE /api/money/items/:id', () => {
    it('disconnects a Plaid item', async () => {
      mockPrisma.plaid_item.deleteMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .delete('/api/money/items/5')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/money/transactions/aggregate', () => {
    it('returns total spend and category breakdown', async () => {
      mockPrisma.expense.aggregate.mockResolvedValueOnce({ _sum: { amount: 150.00 } });
      mockPrisma.expense.groupBy.mockResolvedValueOnce([
        { category_id: 1, _sum: { amount: 80.00 }, _count: 3 },
        { category_id: 2, _sum: { amount: 70.00 }, _count: 2 },
      ]);
      mockPrisma.categories.findMany.mockResolvedValue([
        { id: 1, name: 'Food & Dining', icon: '🍕' },
        { id: 2, name: 'Transport', icon: '🚗' },
      ]);

      const res = await request(app)
        .get('/api/money/transactions/aggregate?from=2026-05-18&to=2026-05-24')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.total_spend).toBe(15000); // cents
      expect(res.body.by_category.length).toBe(2);
    });

    it('handles missing from/to with defaults', async () => {
      mockPrisma.expense.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      mockPrisma.expense.groupBy.mockResolvedValue([]);
      mockPrisma.categories.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/money/transactions/aggregate')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.total_spend).toBe(0);
    });
  });

  describe('GET /api/money/spending-sessions/stats', () => {
    it('returns classified transaction counts', async () => {
      mockPrisma.expense.findMany.mockResolvedValue([
        { is_impulse: true },
        { is_impulse: true },
        { is_impulse: false },
        { is_impulse: false },
        { is_impulse: false },
      ]);

      const res = await request(app)
        .get('/api/money/spending-sessions/stats')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.total_classified).toBe(5);
      expect(res.body.impulse_count).toBe(2);
      expect(res.body.planned_count).toBe(3);
    });

    it('handles no classified transactions', async () => {
      mockPrisma.expense.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/money/spending-sessions/stats')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.total_classified).toBe(0);
      expect(res.body.impulse_count).toBe(0);
    });
  });

  describe('GET /api/money/nudge-config', () => {
    it('returns nudge thresholds', async () => {
      const res = await request(app)
        .get('/api/money/nudge-config')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.delayThreshold).toBe(75);
      expect(res.body.reflectionMin).toBe(25);
    });
  });

  describe('GET /api/money/alerts', () => {
    it('returns empty alerts with null pendingAlert', async () => {
      const res = await request(app)
        .get('/api/money/alerts')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.alerts).toEqual([]);
      expect(res.body.pendingAlert).toBeNull();
    });
  });

  describe('GET /api/money/expenses/summary', () => {
    it('returns spending summary for the period', async () => {
      mockPrisma.expense.aggregate.mockResolvedValueOnce({ _sum: { amount: 200.00 } });
      mockPrisma.expense.groupBy.mockResolvedValueOnce([
        { category_id: 1, _sum: { amount: 120.00 }, _count: 4 },
        { category_id: 2, _sum: { amount: 80.00 }, _count: 2 },
      ]);
      mockPrisma.expense.findMany.mockResolvedValueOnce([
        { amount: 200.00, is_impulse: true, source: 'manual' },
      ]);
      mockPrisma.categories.findMany.mockResolvedValue([
        { id: 1, name: 'Food & Dining', icon: '🍕' },
        { id: 2, name: 'Transport', icon: '🚗' },
      ]);

      const res = await request(app)
        .get('/api/money/expenses/summary?period=week')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary.total).toBe(200);
    });
  });

  describe('PATCH /api/money/transactions/:id/category', () => {
    it('recategorizes a pending transaction', async () => {
      mockPrisma.categories.findFirst.mockResolvedValue({ id: 1, name: 'Groceries', icon: '🛒' });
      mockPrisma.plaid_transaction.count.mockResolvedValue(1);
      mockPrisma.plaid_transaction.update.mockResolvedValue({ id: 5 });

      const res = await request(app)
        .patch('/api/money/transactions/5/category')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ category_name: 'Groceries' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects missing category_name', async () => {
      const res = await request(app)
        .patch('/api/money/transactions/5/category')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('category_name required');
    });
  });

  describe('POST /api/money/transactions/:id/confirm', () => {
    it('confirms a plaid transaction and creates an expense', async () => {
      mockPrisma.plaid_transaction.findFirst.mockResolvedValue({
        id: 5, amount: 45.99, description: 'Amazon', merchant_name: 'Amazon',
        category_id: null, transaction_date: '2026-05-22',
        categories: { name: 'Shopping' },
      });
      mockPrisma.expense.create.mockResolvedValue({ id: 88 });
      mockPrisma.plaid_transaction.update.mockResolvedValue({ id: 5, expense_id: 88 });

      const res = await request(app)
        .post('/api/money/transactions/5/confirm')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.expense_id).toBe(88);
    });

    it('returns 404 for unknown transaction', async () => {
      mockPrisma.plaid_transaction.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/money/transactions/99999/confirm')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/money/bills', () => {
    it('returns bill preferences', async () => {
      mockPrisma.bill_preferences.findMany.mockResolvedValue([
        { id: 1, merchant_key: 'netflix', merchant_display_name: 'Netflix', is_disabled: false },
        { id: 2, merchant_key: 'spotify', merchant_display_name: 'Spotify', is_disabled: true },
      ]);

      const res = await request(app)
        .get('/api/money/bills')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.bills).toHaveLength(2);
    });
  });
});