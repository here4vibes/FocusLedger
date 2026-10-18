'use strict';
/**
 * OAuth callbacks verify the signed state (lib/oauth-state.js) before doing
 * anything: a forged, expired or cross-flow state redirects with an error and
 * never reaches the provider's token exchange; a valid one does.
 */
const express = require('express');
const request = require('supertest');
const { signUserState, signPayload, MAX_AGE_MS } = require('../lib/oauth-state');

// Read at require time by the route modules; makes /google/start build a URL.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-secret';

const savedSecret = process.env.JWT_SECRET;
const realFetch = global.fetch;
let fetchMock;

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });
afterAll(() => { process.env.JWT_SECRET = savedSecret; global.fetch = realFetch; });
beforeEach(() => {
  // The provider rejects the code: only reachable after the state verified.
  fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  global.fetch = fetchMock;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };

describe('email connect callbacks (routes/email.js)', () => {
  const app = express();
  app.use('/api/email', require('../routes/email')(pool));

  const cases = [
    ['gmail', '/api/email/auth/callback', 'email-gmail'],
    ['outlook', '/api/email/callback/outlook', 'email-outlook'],
    ['yahoo', '/api/email/callback/yahoo', 'email-yahoo'],
  ];

  test.each(cases)('%s: forged state → invalid_state, no token exchange', async (_p, url) => {
    const forged = Buffer.from('7:' + Date.now() + ':deadbeefdeadbeef').toString('base64url');
    const res = await request(app).get(url).query({ code: 'c', state: forged });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/email?error=invalid_state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(cases)('%s: expired state → invalid_state', async (_p, url, purpose) => {
    const realNow = Date.now;
    Date.now = () => realNow() - MAX_AGE_MS - 1000;
    const old = signUserState(purpose, 42);
    Date.now = realNow;
    const res = await request(app).get(url).query({ code: 'c', state: old });
    expect(res.headers.location).toBe('/email?error=invalid_state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(cases)('%s: state from another flow → invalid_state', async (_p, url) => {
    const res = await request(app).get(url).query({ code: 'c', state: signUserState('gcal', 42) });
    expect(res.headers.location).toBe('/email?error=invalid_state');
  });

  test.each(cases)('%s: valid state passes verification and reaches the token exchange', async (_p, url, purpose) => {
    const res = await request(app).get(url).query({ code: 'c', state: signUserState(purpose, 42) });
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/email?error=invalid_state');
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('Google sign-in callback (routes/auth.js)', () => {
  const app = express();
  const pass = (_req, _res, next) => next();
  app.use('/api/auth', require('../routes/auth')(pool, pass, pass));

  test('forged state → invalid_state', async () => {
    const res = await request(app).get('/api/auth/google/callback').query({ code: 'c', state: 'login~focusledger.net~1~abc' });
    expect(res.headers.location).toBe('/login?google_error=invalid_state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a returnTo other than login/signup is refused even when signed', async () => {
    const state = signPayload('google-signin', { returnTo: '/evil', host: 'focusledger.net' });
    const res = await request(app).get('/api/auth/google/callback').query({ code: 'c', state });
    expect(res.headers.location).toBe('/login?google_error=invalid_state');
  });

  test('an untrusted host falls back to focusledger.net', async () => {
    const state = signPayload('google-signin', { returnTo: 'signup', host: 'evil.example' });
    const res = await request(app).get('/api/auth/google/callback').query({ code: 'c', state });
    expect(res.headers.location.startsWith('https://focusledger.net/signup?google_error=')).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  test('the start URL never signs an untrusted Host header', async () => {
    const res = await request(app).get('/api/auth/google/start').set('Host', 'evil.example');
    expect(res.status).toBe(200);
    const state = new URL(res.body.url).searchParams.get('state');
    const body = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString());
    expect(body.d.host).toBe('focusledger.net');
  });
});
