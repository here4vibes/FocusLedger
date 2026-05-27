'use strict';

/**
 * Unit tests for middleware/auth.js
 * Pure functions only — no database, no HTTP.
 */

// Set JWT_SECRET before requiring the module so it uses our test secret
process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const {
  generateToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  checkIsPro,
} = require('../middleware/auth');

describe('JWT — generateToken / verifyToken', () => {
  const testUser = { id: 42, email: 'alice@example.com', name: 'Alice' };

  test('generateToken returns a 3-part JWT string', () => {
    const token = generateToken(testUser);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  test('verifyToken decodes a freshly generated token', () => {
    const token = generateToken(testUser);
    const payload = verifyToken(token);
    expect(payload.id).toBe(42);
    expect(payload.email).toBe('alice@example.com');
    expect(payload.name).toBe('Alice');
  });

  test('verifyToken throws on tampered token', () => {
    const token = generateToken(testUser);
    const parts = token.split('.');
    // Flip last char of signature
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'a' ? 'b' : 'a');
    const tampered = parts.join('.');
    expect(() => verifyToken(tampered)).toThrow('Invalid token signature');
  });

  test('verifyToken throws on expired token', () => {
    // Generate a token that expired yesterday
    const user = { id: 1, email: 'x@y.com', name: 'X' };
    // Manually craft a token with exp in the past
    const crypto = require('crypto');
    const JWT_SECRET = 'test-jwt-secret-for-focusledger';

    function b64url(data) {
      return Buffer.from(data).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      id: 1, email: 'x@y.com', name: 'X',
      iat: Math.floor(Date.now() / 1000) - 86400,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired 1h ago
    }));
    const sig = crypto.createHmac('sha256', JWT_SECRET)
      .update(header + '.' + payload)
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const expiredToken = `${header}.${payload}.${sig}`;
    expect(() => verifyToken(expiredToken)).toThrow('Token expired');
  });

  test('verifyToken throws on malformed token (wrong part count)', () => {
    expect(() => verifyToken('not.a.valid.jwt.token')).toThrow('Invalid token format');
    expect(() => verifyToken('only.two')).toThrow('Invalid token format');
  });
});

describe('Password — hashPassword / verifyPassword', () => {
  test('hashPassword returns a salt:hash string', () => {
    const hashed = hashPassword('mysecretpassword');
    expect(typeof hashed).toBe('string');
    expect(hashed).toContain(':');
    const parts = hashed.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(64); // 32 bytes hex = 64 chars
  });

  test('verifyPassword returns true for correct password', () => {
    const password = 'correct-horse-battery';
    const hashed = hashPassword(password);
    expect(verifyPassword(password, hashed)).toBe(true);
  });

  test('verifyPassword returns false for wrong password', () => {
    const hashed = hashPassword('correct-password');
    expect(verifyPassword('wrong-password', hashed)).toBe(false);
  });

  test('hashPassword produces different hashes for same password (salted)', () => {
    const h1 = hashPassword('same-password');
    const h2 = hashPassword('same-password');
    expect(h1).not.toBe(h2); // different salts
  });

  test('verifyPassword returns false for malformed stored hash', () => {
    expect(verifyPassword('password', 'nocolon')).toBe(false);
  });
});

describe('checkIsPro', () => {
  test('returns true when admin_pro_override is set', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: true }] })
    };
    const result = await checkIsPro(pool, 1);
    expect(result).toBe(true);
    // Should short-circuit — only 1 query needed
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('returns true for active Pro subscription', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'active' }] })
    };
    const result = await checkIsPro(pool, 2);
    expect(result).toBe(true);
  });

  test('returns false for free user without override', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] })
    };
    const result = await checkIsPro(pool, 3);
    expect(result).toBe(false);
  });

  test('returns false when no subscription row exists', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [] })
    };
    const result = await checkIsPro(pool, 4);
    expect(result).toBe(false);
  });

  test('returns false for cancelled Pro subscription', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })
        .mockResolvedValueOnce({ rows: [{ plan: 'pro', status: 'cancelled' }] })
    };
    const result = await checkIsPro(pool, 5);
    expect(result).toBe(false);
  });
});
