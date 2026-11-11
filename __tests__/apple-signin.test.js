'use strict';
/**
 * Sign in with Apple: id_token verification against a mocked JWKS (keys made
 * here), the account create/link rules, the callback's state + nonce checks,
 * the 503 gate when Apple isn't configured, and token revocation on deletion.
 */
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../lib/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../lib/seedDefaultValues', () => ({ seedDefaultValues: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/seedStarterRoutine', () => jest.fn().mockResolvedValue(undefined));

const apple = require('../lib/apple-signin');
const appleDb = require('../db/apple-auth');
const { signPayload, MAX_AGE_MS } = require('../lib/oauth-state');
const { sendEmail } = require('../lib/emailService');

const CLIENT_ID = 'net.focusledger.signin';
const KID = 'test-kid-1';

// Apple's signing key (RS256) and an impostor's, plus our own ES256 key (.p8).
const appleKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ourKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwks = { keys: [{ ...appleKey.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };

const NONCE = apple.newNonce();

function idToken(claims = {}, { key = appleKey.privateKey, kid = KID, expiresIn = 600 } = {}) {
  return jwt.sign(
    { iss: 'https://appleid.apple.com', aud: CLIENT_ID, sub: 'apple-sub-001', nonce: NONCE.hashed,
      email: 'Person@Example.com', email_verified: 'true', ...claims },
    key,
    { algorithm: 'RS256', keyid: kid, expiresIn }
  );
}

function jwksFetch() {
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => jwks }));
}

const saved = {};
const ENV = {
  APPLE_CLIENT_ID: CLIENT_ID,
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: ourKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'),
  JWT_SECRET: 'test-secret',
};

beforeAll(() => {
  for (const k of [...Object.keys(ENV), 'APPLE_REDIRECT_URI', 'ENCRYPTION_KEY']) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete process.env.APPLE_REDIRECT_URI;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
beforeEach(() => {
  apple.resetJwksCache();
  jest.clearAllMocks();
  for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('verifyIdToken', () => {
  const verify = (token, over = {}) => apple.verifyIdToken(token, { nonce: NONCE.hashed, fetchImpl: jwksFetch(), ...over });

  test('accepts a valid token and normalises the claims', async () => {
    await expect(verify(idToken())).resolves.toEqual({
      sub: 'apple-sub-001', email: 'person@example.com', emailVerified: true, isPrivateEmail: false,
    });
  });

  test('flags a Hide My Email relay address', async () => {
    const id = await verify(idToken({ email: 'abc123@privaterelay.appleid.com', is_private_email: 'true' }));
    expect(id.isPrivateEmail).toBe(true);
    expect(id.emailVerified).toBe(true);
  });

  test('rejects the wrong audience', async () => {
    await expect(verify(idToken({ aud: 'com.someone.else' }))).rejects.toThrow(/audience/);
  });

  test('rejects the wrong issuer', async () => {
    await expect(verify(idToken({ iss: 'https://evil.example.com' }))).rejects.toThrow(/issuer/);
  });

  test('rejects an expired token', async () => {
    await expect(verify(idToken({}, { expiresIn: -60 }))).rejects.toThrow(/expired/);
  });

  test('rejects a token signed by another key (bad signature)', async () => {
    await expect(verify(idToken({}, { key: otherKey.privateKey }))).rejects.toThrow(/signature/);
  });

  test('rejects a nonce that is not the one we sent', async () => {
    await expect(verify(idToken({ nonce: apple.newNonce().hashed }))).rejects.toThrow(/nonce mismatch/);
    await expect(verify(idToken({ nonce: undefined }))).rejects.toThrow(/nonce mismatch/);
  });

  test('rejects an unknown key id, an HS256 token and garbage', async () => {
    await expect(verify(idToken({}, { kid: 'nope' }))).rejects.toThrow(/signing key not found/);
    const hs = jwt.sign({ iss: 'https://appleid.apple.com', aud: CLIENT_ID, sub: 'x', nonce: NONCE.hashed },
      'shared-secret', { algorithm: 'HS256', keyid: KID });
    await expect(verify(hs)).rejects.toThrow(/expected RS256/);
    await expect(verify('not-a-jwt')).rejects.toThrow(/malformed/);
  });

  test('fails when the JWKS cannot be fetched', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(apple.verifyIdToken(idToken(), { nonce: NONCE.hashed, fetchImpl })).rejects.toThrow(/JWKS fetch failed/);
  });

  test('caches the JWKS between verifications', async () => {
    const fetchImpl = jwksFetch();
    await apple.verifyIdToken(idToken(), { nonce: NONCE.hashed, fetchImpl });
    await apple.verifyIdToken(idToken(), { nonce: NONCE.hashed, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('client secret, authorize URL, helpers', () => {
  test('the client secret is an ES256 JWT Apple can check with our public key', () => {
    const claims = jwt.verify(apple.clientSecret(), ourKey.publicKey, { algorithms: ['ES256'], audience: 'https://appleid.apple.com' });
    expect(claims).toMatchObject({ iss: 'TEAM123456', sub: CLIENT_ID });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
    expect(jwt.decode(apple.clientSecret(), { complete: true }).header.kid).toBe('KEY1234567');
  });

  test('the authorize URL asks for form_post with name and email', () => {
    const u = new URL(apple.authorizeUrl({ state: 'S', nonce: 'N' }));
    expect(u.origin + u.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT_ID, redirect_uri: 'https://focusledger.net/api/auth/apple/callback',
      response_type: 'code', response_mode: 'form_post', scope: 'name email', state: 'S', nonce: 'N',
    });
  });

  test('name comes from the first-authorization user field only when well formed', () => {
    expect(apple.nameFromUserField(JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }))).toBe('Ada Lovelace');
    expect(apple.nameFromUserField(JSON.stringify({ name: { firstName: '<b>Ada</b>' } }))).toBe('bAda/b');
    expect(apple.nameFromUserField('{not json')).toBeNull();
    expect(apple.nameFromUserField(undefined)).toBeNull();
    expect(apple.nameFromUserField(JSON.stringify({ email: 'x@y.z' }))).toBeNull();
  });

  test('the refresh token round-trips through encryption and tampering is caught', () => {
    const enc = apple.encryptRefreshToken('r.refresh-token');
    expect(enc).not.toContain('refresh-token');
    expect(apple.decryptRefreshToken(enc)).toBe('r.refresh-token');
    const bad = Buffer.from(enc, 'base64');
    bad[bad.length - 1] ^= 1;
    expect(() => apple.decryptRefreshToken(bad.toString('base64'))).toThrow();
  });
});

// ── In-memory stand-in for the users table (only the queries db/apple-auth.js runs) ──
function fakePool(rows = []) {
  const users = rows.map((r) => ({ password_hash: null, auth_method: 'password', apple_sub: null, apple_refresh_token: null, ...r }));
  let nextId = 100;
  const query = jest.fn(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s) || /^INSERT INTO (budgets|app_subscription)/.test(s)) return { rows: [], rowCount: 0 };
    if (/FROM users WHERE apple_sub = \$1/.test(s)) return { rows: users.filter((u) => u.apple_sub === params[0]) };
    if (/FROM users WHERE LOWER\(email\)/.test(s)) return { rows: users.filter((u) => u.email.toLowerCase() === params[0].toLowerCase()).slice(0, 1) };
    if (/^UPDATE users SET apple_sub/.test(s)) {
      const u = users.find((x) => x.id === params[1] && x.apple_sub === null);
      if (!u) return { rowCount: 0 };
      u.apple_sub = params[0];
      u.name = u.name || params[2];
      return { rowCount: 1 };
    }
    if (/^INSERT INTO users/.test(s)) {
      if (users.some((u) => u.apple_sub === params[2])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      const u = { id: nextId++, email: params[0], name: params[1], apple_sub: params[2], auth_method: 'apple', password_hash: null };
      users.push(u);
      return { rows: [{ id: u.id, email: u.email, name: u.name }] };
    }
    if (/^UPDATE users SET apple_refresh_token/.test(s)) {
      users.find((u) => u.id === params[1]).apple_refresh_token = params[0];
      return { rowCount: 1 };
    }
    if (/^SELECT apple_refresh_token/.test(s)) return { rows: users.filter((u) => u.id === params[0]) };
    throw new Error('unexpected SQL in test: ' + s);
  });
  const pool = { query, users, connect: async () => ({ query, release: () => {} }) };
  return pool;
}

describe('resolveAppleUser (create / link)', () => {
  const identity = (over = {}) => ({ sub: 'apple-sub-001', email: 'person@example.com', emailVerified: true, isPrivateEmail: false, ...over });

  test('creates a new account, with the name from the first authorization', async () => {
    const pool = fakePool();
    const r = await appleDb.resolveAppleUser(pool, identity(), 'Ada Lovelace');
    expect(r).toMatchObject({ isNewUser: true, linked: false, user: { email: 'person@example.com', name: 'Ada Lovelace' } });
    expect(pool.users[0]).toMatchObject({ apple_sub: 'apple-sub-001', auth_method: 'apple' });
    const sql = pool.query.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).toMatch(/INSERT INTO budgets/);
    expect(sql).toMatch(/INSERT INTO app_subscription/);
  });

  test('signs in by sub afterwards, even when Apple sends no email or name', async () => {
    const pool = fakePool([{ id: 7, email: 'person@example.com', name: 'Ada', apple_sub: 'apple-sub-001' }]);
    const r = await appleDb.resolveAppleUser(pool, identity({ email: null, emailVerified: false }), null);
    expect(r).toMatchObject({ isNewUser: false, linked: false, user: { id: 7 } });
  });

  test('links to an existing account with the same verified email and keeps its name', async () => {
    const pool = fakePool([{ id: 7, email: 'Person@Example.com', name: 'Existing Name', password_hash: 'h' }]);
    const r = await appleDb.resolveAppleUser(pool, identity(), 'Apple Name');
    expect(r).toMatchObject({ isNewUser: false, linked: true, user: { id: 7 } });
    expect(pool.users).toHaveLength(1);
    expect(pool.users[0]).toMatchObject({ apple_sub: 'apple-sub-001', name: 'Existing Name', auth_method: 'password' });
  });

  test('never links on an unverified email', async () => {
    const pool = fakePool([{ id: 7, email: 'person@example.com', name: 'Victim' }]);
    const r = await appleDb.resolveAppleUser(pool, identity({ emailVerified: false }), null);
    expect(r).toEqual({ error: 'email_unverified' });
    expect(pool.users[0].apple_sub).toBeNull();
  });

  test('refuses when the email belongs to an account tied to another Apple ID', async () => {
    const pool = fakePool([{ id: 7, email: 'person@example.com', name: 'A', apple_sub: 'someone-else' }]);
    expect(await appleDb.resolveAppleUser(pool, identity(), null)).toEqual({ error: 'email_taken' });
  });

  test('a Hide My Email relay address becomes its own account', async () => {
    const pool = fakePool([{ id: 7, email: 'person@example.com', name: 'A' }]);
    const r = await appleDb.resolveAppleUser(pool, identity({ email: 'x9@privaterelay.appleid.com', isPrivateEmail: true }), null);
    expect(r.isNewUser).toBe(true);
    expect(pool.users).toHaveLength(2);
    expect(pool.users[0].apple_sub).toBeNull();
  });

  test('no email and no known sub: cannot create an account', async () => {
    expect(await appleDb.resolveAppleUser(fakePool(), identity({ email: null }), null)).toEqual({ error: 'no_email' });
  });

  test('a racing duplicate insert resolves to the row that won', async () => {
    const pool = fakePool();
    const realQuery = pool.query.getMockImplementation();
    let raced = false;
    pool.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO users/.test(sql) && !raced) {
        raced = true;
        pool.users.push({ id: 55, email: 'person@example.com', name: null, apple_sub: 'apple-sub-001', auth_method: 'apple' });
      }
      return realQuery(sql, params);
    });
    const r = await appleDb.resolveAppleUser(pool, identity({ email: 'other@example.com' }), null);
    expect(r).toMatchObject({ isNewUser: false, user: { id: 55 } });
  });
});

describe('routes: /api/auth/apple', () => {
  function app(pool, fetchImpl) {
    const a = express();
    a.use(express.urlencoded({ extended: false }));
    a.use('/api/auth/apple', require('../routes/auth-apple')(pool, { fetchImpl }));
    return a;
  }

  // Apple's token endpoint + JWKS, as one fetch mock.
  function appleFetch(tokenBody) {
    return jest.fn(async (url) => {
      if (String(url).endsWith('/auth/keys')) return { ok: true, status: 200, json: async () => jwks };
      if (String(url).endsWith('/auth/token')) return { ok: !tokenBody.error, status: tokenBody.error ? 400 : 200, json: async () => tokenBody };
      throw new Error('unexpected fetch ' + url);
    });
  }

  const state = (over = {}) => signPayload('apple-signin', { returnTo: 'login', nonce: NONCE.hashed, ...over });
  const cookie = (raw = NONCE.raw) => `fl_apple_nonce=${raw}`;
  const post = (a, body, c = cookie()) => {
    const r = request(a).post('/api/auth/apple/callback').type('form');
    if (c) r.set('Cookie', c);
    return r.send(body);
  };

  test('GET /config reports whether Apple is configured', async () => {
    const res = await request(app(fakePool())).get('/api/auth/apple/config');
    expect(res.body).toEqual({ success: true, enabled: true });
  });

  test('GET /start redirects to Apple and sets the nonce cookie for the cross-site callback', async () => {
    const res = await request(app(fakePool())).get('/api/auth/apple/start?return_to=signup');
    expect(res.status).toBe(302);
    const u = new URL(res.headers.location);
    expect(u.hostname).toBe('appleid.apple.com');
    const setCookie = res.headers['set-cookie'][0];
    expect(setCookie).toMatch(/^fl_apple_nonce=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=None/);
    expect(setCookie).toMatch(/Path=\/api\/auth\/apple/);
    // Apple gets the hash; the raw nonce only ever lives in the cookie.
    const raw = decodeURIComponent(setCookie.split(';')[0].split('=')[1]);
    expect(u.searchParams.get('nonce')).toBe(apple.sha256Hex(raw));
    expect(res.headers.location).not.toContain(raw);
  });

  test('a valid callback creates the account, stores the encrypted refresh token and returns a session token', async () => {
    const pool = fakePool();
    const fetchImpl = appleFetch({ id_token: idToken(), refresh_token: 'r.apple-refresh' });
    const res = await post(app(pool, fetchImpl), {
      code: 'auth-code', state: state({ returnTo: 'signup' }),
      user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }),
    });
    expect(res.status).toBe(303);
    const u = new URL(res.headers.location, 'https://focusledger.net');
    expect(u.pathname).toBe('/signup');
    expect(u.searchParams.get('apple_new')).toBe('1');
    expect(u.searchParams.get('apple_email')).toBe('person@example.com');
    const session = jwt.decode(u.searchParams.get('apple_token'));
    expect(session.id).toBe(pool.users[0].id);
    expect(pool.users[0]).toMatchObject({ name: 'Ada Lovelace', apple_sub: 'apple-sub-001' });
    expect(pool.users[0].apple_refresh_token).not.toContain('apple-refresh');
    expect(apple.decryptRefreshToken(pool.users[0].apple_refresh_token)).toBe('r.apple-refresh');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The code was exchanged with our client secret.
    const tokenCall = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/auth/token'));
    expect(tokenCall[1].body.get('code')).toBe('auth-code');
    expect(tokenCall[1].body.get('client_secret')).toBeTruthy();
  });

  test('a returning user is signed in without a second welcome email', async () => {
    const pool = fakePool([{ id: 7, email: 'person@example.com', name: 'Ada', apple_sub: 'apple-sub-001' }]);
    const res = await post(app(pool, appleFetch({ id_token: idToken({ email: undefined }) })), { code: 'c', state: state() });
    const u = new URL(res.headers.location, 'https://focusledger.net');
    expect(u.pathname).toBe('/login');
    expect(u.searchParams.get('apple_new')).toBeNull();
    expect(jwt.decode(u.searchParams.get('apple_token')).id).toBe(7);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test.each([
    ['a forged state', () => ({ code: 'c', state: state().slice(0, -2) + 'zz' }), cookie()],
    ['a state signed for another flow', () => ({ code: 'c', state: signPayload('google-signin', { returnTo: 'login', nonce: NONCE.hashed }) }), cookie()],
    ['no nonce cookie (callback in a browser that did not start the flow)', () => ({ code: 'c', state: state() }), null],
    ['someone else’s nonce cookie', () => ({ code: 'c', state: state() }), cookie(apple.newNonce().raw)],
  ])('rejects %s before talking to Apple', async (_name, body, c) => {
    const fetchImpl = appleFetch({ id_token: idToken() });
    const pool = fakePool();
    const res = await post(app(pool, fetchImpl), body(), c);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/login?apple_error=invalid_state');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pool.users).toHaveLength(0);
  });

  test('rejects an expired state', async () => {
    const old = state();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + MAX_AGE_MS + 1000);
    const res = await post(app(fakePool(), appleFetch({ id_token: idToken() })), { code: 'c', state: old });
    expect(res.headers.location).toBe('/login?apple_error=invalid_state');
  });

  test('an id_token minted for a different nonce (replay) is rejected', async () => {
    const pool = fakePool();
    const res = await post(app(pool, appleFetch({ id_token: idToken({ nonce: apple.newNonce().hashed }) })), { code: 'c', state: state() });
    expect(res.headers.location).toBe('/login?apple_error=verification_failed');
    expect(pool.users).toHaveLength(0);
  });

  test('a failed code exchange and a cancelled sign-in go back with an error', async () => {
    const res = await post(app(fakePool(), appleFetch({ error: 'invalid_grant' })), { code: 'c', state: state() });
    expect(res.headers.location).toBe('/login?apple_error=verification_failed');
    const cancelled = await post(app(fakePool(), appleFetch({})), { error: 'user_cancelled_authorize', state: state({ returnTo: 'signup' }) });
    expect(cancelled.headers.location).toBe('/signup?apple_error=access_denied');
  });

  test('not configured: /config says so and /start and /callback answer 503', async () => {
    const keyId = process.env.APPLE_KEY_ID;
    delete process.env.APPLE_KEY_ID;
    try {
      const a = app(fakePool(), appleFetch({ id_token: idToken() }));
      expect((await request(a).get('/api/auth/apple/config')).body.enabled).toBe(false);
      const start = await request(a).get('/api/auth/apple/start');
      expect(start.status).toBe(503);
      expect(start.body.code).toBe('APPLE_SIGNIN_NOT_CONFIGURED');
      expect((await post(a, { code: 'c', state: state() })).status).toBe(503);
    } finally {
      process.env.APPLE_KEY_ID = keyId;
    }
  });
});

describe('account deletion revokes the Apple token', () => {
  const { revokeAppleAccess } = require('../routes/account-deletion');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('posts the decrypted refresh token to Apple’s revoke endpoint', async () => {
    const pool = fakePool([{ id: 7, email: 'p@example.com', apple_sub: 's', apple_refresh_token: apple.encryptRefreshToken('r.tok') }]);
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    expect(await revokeAppleAccess(pool, 7)).toBe('revoked');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://appleid.apple.com/auth/revoke');
    expect(init.body.get('token')).toBe('r.tok');
    expect(init.body.get('token_type_hint')).toBe('refresh_token');
    expect(init.body.get('client_id')).toBe(CLIENT_ID);
  });

  test('users without an Apple token are skipped; a failed revoke is reported, not thrown', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 400 }));
    expect(await revokeAppleAccess(fakePool([{ id: 7, email: 'p@example.com' }]), 7)).toBe('none');
    expect(global.fetch).not.toHaveBeenCalled();
    const pool = fakePool([{ id: 8, email: 'q@example.com', apple_refresh_token: apple.encryptRefreshToken('r.tok') }]);
    expect(await revokeAppleAccess(pool, 8)).toBe('failed');
    expect(console.error).toHaveBeenCalled();
  });
});
