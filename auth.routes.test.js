'use strict';

/**
 * Integration tests for routes/auth.js
 * Uses supertest + mocked pool — no real database.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { hashPassword, generateToken } = require('../middleware/auth');

describe('POST /api/auth/signup', () => {
  test('400 when email is missing', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('400 when password is too short (< 6 chars)', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'test@example.com', password: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/6 characters/);
  });

  test('400 on invalid email format', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid email/i);
  });

  test('409 when email already exists', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // existing user check
    };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'existing@example.com', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test('201 and returns JWT on successful signup', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })                              // no existing user
        .mockResolvedValueOnce({ rows: [{ id: 1, email: 'new@example.com', name: 'New', created_at: new Date() }] }) // INSERT user
        .mockResolvedValueOnce({ rows: [] })                              // INSERT budget
        .mockResolvedValueOnce({ rows: [] })                              // INSERT subscription
    };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'new@example.com', password: 'password123', name: 'New' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('new@example.com');
  });

  test('email is stored lowercase (case-insensitive check)', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 2, email: 'upper@example.com', name: null, created_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
    };
    const app = createTestApp(pool, 'auth');

    await request(app)
      .post('/api/auth/signup')
      .send({ email: 'UPPER@EXAMPLE.COM', password: 'password123' });

    // The INSERT call is the second query — check the email param was lowercased
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[1][0]).toBe('upper@example.com');
  });
});

describe('POST /api/auth/login', () => {
  test('400 when credentials are missing', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/login')
      .send({});

    expect(res.status).toBe(400);
  });

  test('401 when user does not exist', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] })
    };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'password' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('401 when password is wrong', async () => {
    const correctHash = hashPassword('correct-password');
    const pool = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{ id: 1, email: 'user@example.com', name: 'User', password_hash: correctHash }]
      })
    };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  test('200 and returns JWT on valid login', async () => {
    const correctHash = hashPassword('my-password');
    const pool = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{ id: 5, email: 'login@example.com', name: 'Login', password_hash: correctHash }]
      })
    };
    const app = createTestApp(pool, 'auth');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'my-password' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.id).toBe(5);
  });

  test('login lookup is case-insensitive (UPPER email finds lowercase record)', async () => {
    const correctHash = hashPassword('pass123');
    const pool = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{ id: 7, email: 'alice@example.com', name: 'Alice', password_hash: correctHash }]
      })
    };
    const app = createTestApp(pool, 'auth');

    // Login with uppercase email
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ALICE@EXAMPLE.COM', password: 'pass123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/auth/me', () => {
  test('401 without token', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'auth');

    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('200 returns user for valid token', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{ id: 1, email: 'me@example.com', name: 'Me', created_at: new Date(), subscription_plan: 'free', subscription_status: 'active' }]
      })
    };
    const app = createTestApp(pool, 'auth');
    const token = generateToken({ id: 1, email: 'me@example.com', name: 'Me' });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe('me@example.com');
  });
});
