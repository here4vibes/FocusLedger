'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const express = require('express');
const request = require('supertest');
const { generateToken } = require('../middleware/auth');
const { isAdminUser } = require('../lib/admin-access');

function appWith(pool) {
  const app = express();
  app.use('/api/plaid', require('../routes/plaid')(pool));
  return app;
}

const bearer = id => 'Bearer ' + generateToken({ id, email: `u${id}@example.com` });

describe('GET /api/plaid/diagnostic access', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    // No Plaid credentials → the handler answers without calling Plaid.
    delete process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_SECRET;
    delete process.env.ADMIN_EMAILS;
  });
  afterAll(() => { process.env = saved; });

  test('401 without a token, and never touches the DB', async () => {
    const pool = { query: jest.fn() };
    const res = await request(appWith(pool)).get('/api/plaid/diagnostic');
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('403 for a signed-in non-admin', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 7, email: 'u7@example.com', is_admin: false }] }) };
    const res = await request(appWith(pool)).get('/api/plaid/diagnostic').set('Authorization', bearer(7));
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('client_id_prefix');
  });

  test('500 (fail closed) when the admin lookup errors', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const res = await request(appWith(pool)).get('/api/plaid/diagnostic').set('Authorization', bearer(7));
    expect(res.status).toBe(500);
  });

  test('200 for an admin, with no secret characters in the response', async () => {
    process.env.PLAID_SECRET = 'supersecretvalue';
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 2, email: 'boss@example.com', is_admin: true }] }) };
    const res = await request(appWith(pool)).get('/api/plaid/diagnostic').set('Authorization', bearer(2));
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.secret_length).toBe(16);
    expect(res.body).not.toHaveProperty('secret_prefix');
    expect(JSON.stringify(res.body)).not.toContain('supe');
  });
});

describe('isAdminUser', () => {
  afterEach(() => { delete process.env.ADMIN_EMAILS; });

  test('is_admin flag grants access', () => {
    expect(isAdminUser({ is_admin: true, email: 'a@b.c' })).toBe(true);
  });

  test('ADMIN_EMAILS match is case-insensitive', () => {
    process.env.ADMIN_EMAILS = ' Boss@Example.com , other@x.y';
    expect(isAdminUser({ is_admin: false, email: 'boss@example.COM' })).toBe(true);
  });

  test('missing user, missing email, or no match is denied', () => {
    process.env.ADMIN_EMAILS = 'boss@example.com';
    expect(isAdminUser(null)).toBe(false);
    expect(isAdminUser({ is_admin: false, email: null })).toBe(false);
    expect(isAdminUser({ is_admin: false, email: 'nope@example.com' })).toBe(false);
  });

  test('empty ADMIN_EMAILS never matches an empty email', () => {
    process.env.ADMIN_EMAILS = '';
    expect(isAdminUser({ is_admin: false, email: '' })).toBe(false);
  });
});
