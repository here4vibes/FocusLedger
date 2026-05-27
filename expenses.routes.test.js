'use strict';

/**
 * Integration tests for routes/expenses.js
 *
 * Covers: add expense, budget remaining calculation (regression),
 * category assignment, spending summary.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { generateToken } = require('../middleware/auth');

function makeToken(userId = 1) {
  return generateToken({ id: userId, email: `user${userId}@test.com`, name: 'Test' });
}
const AUTH = () => ({ Authorization: `Bearer ${makeToken()}` });

// ────────────────────────────────────────────────────────────────
// POST /api/expenses — add expense
// ────────────────────────────────────────────────────────────────
describe('POST /api/expenses', () => {
  test('400 when amount is missing', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .post('/api/expenses')
      .set(AUTH())
      .send({ description: 'Coffee' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/amount/i);
  });

  test('400 when amount is zero or negative', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .post('/api/expenses')
      .set(AUTH())
      .send({ amount: 0, description: 'Free?' });

    expect(res.status).toBe(400);
  });

  test('201 creates expense successfully', async () => {
    const newExpense = {
      id: 1, user_id: 1, amount: 12.50, description: 'Lunch',
      category_id: 1, expense_date: '2026-04-18', created_at: new Date(),
    };
    // Route calls: fetchUserTimezone → resolveCategoryId (in createExpense) → INSERT
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ tz: 'America/New_York' }] }) // fetchUserTimezone
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })                  // resolveCategoryId
        .mockResolvedValueOnce({ rows: [newExpense] })                  // INSERT expense
    };

    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .post('/api/expenses')
      .set(AUTH())
      .send({ amount: 12.50, description: 'Lunch', expense_date: '2026-04-18' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.expense.amount).toBe(12.50);
  });

  test('category resolved by name when category_id not provided', async () => {
    const expense = { id: 5, user_id: 1, amount: 8.00, description: 'Bus', category_id: 2, expense_date: '2026-04-18' };
    // Route calls: fetchUserTimezone → resolveCategoryId (in createExpense) → INSERT
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ tz: 'America/New_York' }] }) // fetchUserTimezone
        .mockResolvedValueOnce({ rows: [{ id: 2 }] })                  // resolveCategoryId
        .mockResolvedValueOnce({ rows: [expense] })                    // INSERT
    };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .post('/api/expenses')
      .set(AUTH())
      .send({ amount: 8.00, description: 'Bus', category: 'transport' });

    expect(res.status).toBe(201);
  });
});

// ────────────────────────────────────────────────────────────────
// GET /api/expenses/budget — REGRESSION: remaining = weekly_amount - total_spent
// ────────────────────────────────────────────────────────────────
describe('GET /api/expenses/budget', () => {
  test('REGRESSION: remaining = weekly_amount - total_spent (accurate after multiple expenses)', async () => {
    const weeklyAmount = 500;
    const totalSpent = 175.50;
    const expectedRemaining = weeklyAmount - totalSpent; // 324.50

    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1, weekly_amount: String(weeklyAmount), is_active: true, user_id: 1 }] }) // budget
        .mockResolvedValueOnce({ rows: [{ tz: 'America/New_York' }] }) // fetchUserTimezone
        .mockResolvedValueOnce({ rows: [{ total_spent: String(totalSpent) }] }) // expenses sum
    };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .get('/api/expenses/budget')
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.budget.weekly_amount).toBe(weeklyAmount);
    expect(res.body.budget.total_spent).toBe(totalSpent);
    expect(res.body.budget.remaining).toBeCloseTo(expectedRemaining, 2);
  });

  test('returns default budget when no budget row exists', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] }) // no budget
    };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .get('/api/expenses/budget')
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body.budget.weekly_amount).toBe(500); // default
  });

  test('remaining can be negative when over budget', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1, weekly_amount: '200', is_active: true, user_id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ tz: 'America/New_York' }] }) // fetchUserTimezone
        .mockResolvedValueOnce({ rows: [{ total_spent: '350.00' }] }) // spent MORE than budget
    };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .get('/api/expenses/budget')
      .set(AUTH());

    expect(res.body.budget.remaining).toBe(200 - 350); // -150
  });

  test('401 without auth', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app).get('/api/expenses/budget');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/expenses/:id
// ────────────────────────────────────────────────────────────────
describe('DELETE /api/expenses/:id', () => {
  test('deletes expense', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] })
    };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .delete('/api/expenses/1')
      .set(AUTH());

    expect(res.status).toBe(200);
  });

  test('404 when expense not found', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] })
    };
    const app = createTestApp(pool, 'expenses');

    const res = await request(app)
      .delete('/api/expenses/999')
      .set(AUTH());

    expect(res.status).toBe(404);
  });
});
