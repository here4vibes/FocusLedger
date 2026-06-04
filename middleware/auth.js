const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'REDACTED' + crypto.randomBytes(8).toString('hex');

if (!process.env.JWT_SECRET) {
  console.warn('[Auth] WARNING: JWT_SECRET not set. Using generated fallback. Set JWT_SECRET env var in production.');
}

// ============================================
// JWT Implementation (HMAC-SHA256)
// ============================================

function base64UrlEncode(data) {
  return Buffer.from(data).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function createSignature(headerPayload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(headerPayload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateToken(user, expiresInDays) {
  expiresInDays = expiresInDays || 30;
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    id: user.id,
    email: user.email,
    name: user.name || null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (expiresInDays * 24 * 60 * 60)
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createSignature(headerB64 + '.' + payloadB64, JWT_SECRET);

  return headerB64 + '.' + payloadB64 + '.' + signature;
}

function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const headerPayload = parts[0] + '.' + parts[1];
  const signature = parts[2];
  const expectedSignature = createSignature(headerPayload, JWT_SECRET);

  if (signature !== expectedSignature) {
    throw new Error('Invalid token signature');
  }

  const payload = JSON.parse(base64UrlDecode(parts[1]));

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

// ============================================
// Password Hashing (PBKDF2)
// ============================================

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const salt = parts[0];
  const hash = parts[1];
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
}

// ============================================
// Express Middleware — dual auth support
// Phase 2 migration: session (HttpOnly cookie) takes priority over JWT.
// JWT support is preserved for the dual-running period.
// When session.user exists, JWT is ignored.
// ============================================

function authenticateToken(req, res, next) {
  // 1. Session auth (primary — HttpOnly cookie from express-session)
  if (req.session && req.session.user) {
    req.user = req.session.user;
    return next();
  }

  // 2. JWT fallback (legacy — for existing localStorage tokens during migration)
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// ── Session helpers (used by auth routes) ───────────────────────────────────

function establishSession(req, user) {
  // Guard: session middleware may not be mounted in test environments.
  // Production server.js mounts buildSessionMiddleware(pool) before routes.
  if (!req.session) return;
  req.session.user = {
    id: user.id,
    email: user.email,
    name: user.name || null,
    is_qa_user: user.is_qa_user || false,
  };
}

// ============================================
// Pro Status Check
// Honors both Stripe subscriptions and admin-granted Pro overrides.
// Used by all routes that gate Pro features.
//
// DEPRECATED: Use middleware/proUtils.checkProStatus instead.
// This function is kept for backward compatibility during migration.
// ============================================
async function checkIsPro(pool, userId) {
  // Fast path: check admin override first (avoids a sub query in most cases)
  const userResult = await pool.query(
    'SELECT admin_pro_override, pro_granted_until FROM users WHERE id = $1',
    [userId]
  );
  const user = userResult.rows[0];
  if (user?.admin_pro_override) {
    // Respect expiry if set; null = permanent override
    if (!user.pro_granted_until || new Date(user.pro_granted_until) > new Date()) {
      return true;
    }
  }

  // Fall back to Stripe subscription
  const subResult = await pool.query(
    'SELECT plan, status FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [userId]
  );
  const sub = subResult.rows[0];
  return !!(sub && sub.plan === 'pro' && sub.status === 'active');
}

module.exports = {
  authenticateToken: authenticateToken,
  establishSession: establishSession,
  generateToken: generateToken,
  verifyToken: verifyToken,
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  checkIsPro: checkIsPro,
  JWT_SECRET: JWT_SECRET
};
