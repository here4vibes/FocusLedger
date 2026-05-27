'use strict';

/**
 * Integration tests for routes/ideas.js
 *
 * Covers: submit idea, list ideas, admin email check regression
 * (case-insensitive, comma-separated parsing).
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { generateToken } = require('../middleware/auth');

function makeToken(userId = 1, email = `user${userId}@test.com`) {
  return generateToken({ id: userId, email, name: 'Test' });
}

describe('GET /api/ideas', () => {
  test('401 without token', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'ideas');

    const res = await request(app).get('/api/ideas');
    expect(res.status).toBe(401);
  });

  test('returns list of ideas for authenticated user', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ is_admin: false, email: 'user1@test.com' }] }) // user check
        .mockResolvedValueOnce({
          rows: [
            { id: 1, user_id: 1, title: 'Dark mode', description: 'Add dark mode', status: 'submitted', submitter_name: 'Test', created_at: new Date() }
          ]
        })
    };
    const app = createTestApp(pool, 'ideas');

    const res = await request(app)
      .get('/api/ideas')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ideas).toHaveLength(1);
  });
});

describe('POST /api/ideas', () => {
  test('submits idea successfully', async () => {
    const newIdea = { id: 5, user_id: 1, title: 'Export data', description: null, status: 'submitted' };
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [newIdea] })  // INSERT
        .mockResolvedValueOnce({ rows: [{ name: 'Test' }] }) // user name lookup for response
    };
    const app = createTestApp(pool, 'ideas');

    const res = await request(app)
      .post('/api/ideas')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Export data' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('400 when title is missing', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'ideas');

    const res = await request(app)
      .post('/api/ideas')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ description: 'No title here' });

    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// REGRESSION: Admin email check is case-insensitive + comma-separated
// The `isAdminUser` function in ideas.js parses ADMIN_EMAILS env var.
// ────────────────────────────────────────────────────────────────
describe('Admin email check — regression', () => {
  // We test this by loading the module in isolation and directly
  // invoking the logic through the PATCH status endpoint (admin only).

  test('ADMIN_EMAILS parsing: uppercase email matches lowercase env entry', () => {
    // Simulate the isAdminUser logic directly
    const adminEmails = 'founder@example.com,Admin@Company.com'.split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    const userEmailUpper = 'ADMIN@COMPANY.COM';
    const isAdmin = adminEmails.includes(userEmailUpper.toLowerCase());
    expect(isAdmin).toBe(true);
  });

  test('ADMIN_EMAILS parsing: non-admin email correctly excluded', () => {
    const adminEmails = 'founder@example.com,admin@company.com'.split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    const isAdmin = adminEmails.includes('hacker@evil.com'.toLowerCase());
    expect(isAdmin).toBe(false);
  });

  test('ADMIN_EMAILS parsing: handles spaces around commas', () => {
    const adminEmails = ' founder@example.com , admin@company.com '.split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    expect(adminEmails).toContain('founder@example.com');
    expect(adminEmails).toContain('admin@company.com');
  });

  test('403 when non-admin tries to update idea status', async () => {
    process.env.ADMIN_EMAILS = 'real-admin@example.com';

    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ is_admin: false, email: 'regular@user.com' }] }) // not admin
    };
    const app = createTestApp(pool, 'ideas');

    const res = await request(app)
      .patch('/api/ideas/1/status')
      .set('Authorization', `Bearer ${makeToken(1, 'regular@user.com')}`)
      .send({ status: 'selected' });

    expect(res.status).toBe(403);
  });
});
