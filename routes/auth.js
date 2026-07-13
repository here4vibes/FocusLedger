const express = require('express');
const crypto = require('crypto');
const { authenticateToken, generateToken, hashPassword, verifyPassword, establishSession } = require('../middleware/auth');
const { sendEmail } = require('../lib/emailService');
const { welcomeTemplate, passwordResetTemplate, passwordResetGoogleOnlyTemplate } = require('../lib/emailTemplates');
const { passwordResetLimiter } = require('../middleware/security');
const { seedDefaultValues } = require('../lib/seedDefaultValues');
const seedStarterRoutine = require('../lib/seedStarterRoutine');
const { getSessionData, markSessionMigrated, isSessionMigrated } = require('../db/buddy-demo');
const { validateTimezone, fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

// ============================================================
// Google OAuth Configuration (Auth Scopes)
// Uses the same GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET as Gmail linking
// but with minimal scopes: email + profile (no mail.readonly)
// Redirect URI: https://focusledger.net/auth/google/callback
// ============================================================
const GOOGLE_CLIENT_ID      = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_AUTH_REDIRECT  = (process.env.GOOGLE_AUTH_REDIRECT_URI || 'https://focusledger.net/auth/google-auth/callback').trim();
const GOOGLE_AUTH_SCOPE    = 'openid email https://www.googleapis.com/auth/userinfo.profile';

const isGoogleAuthConfigured = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// ============================================================
// State signing — prevents CSRF on OAuth callback
// ============================================================
const STATE_SECRET = process.env.JWT_SECRET || 'focusledger-auth-state';

// Trusted hosts for post-OAuth redirect — prevents open redirect
const TRUSTED_REDIRECT_HOSTS = new Set([
  'focusledger.net',
  'www.focusledger.net',
  'focusledger-mwn3.onrender.com',
  'focusledger.net',
  'localhost:3000',
]);
if (process.env.ALLOWED_ORIGIN) {
  try { TRUSTED_REDIRECT_HOSTS.add(new URL(process.env.ALLOWED_ORIGIN).host); } catch {}
}

// State format: {returnTo}~{host}~{ts}~{sig}  (~ avoids colon clash with localhost:port)
function signState(returnTo, host) {
  const ts = Date.now();
  const data = `${returnTo}~${host}~${ts}`;
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(data).digest('hex').slice(0, 16);
  return Buffer.from(`${data}~${sig}`).toString('base64url');
}

function verifyState(state) {
  try {
    const raw = Buffer.from(state, 'base64url').toString();
    const parts = raw.split('~');
    if (parts.length !== 4) return null;
    const [returnTo, host, ts, sig] = parts;
    if (Date.now() - Number(ts) > 600000) return null;
    const expected = crypto.createHmac('sha256', STATE_SECRET)
      .update(`${returnTo}~${host}~${ts}`).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    const safeHost = TRUSTED_REDIRECT_HOSTS.has(host) ? host : 'focusledger.net';
    return { returnTo, host: safeHost };
  } catch {
    return null;
  }
}

// ============================================================
// Token helpers — raw HTTP to Google's endpoints
// ============================================================
async function exchangeGoogleCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  GOOGLE_AUTH_REDIRECT,
      grant_type:    'authorization_code'
    })
  });
  return res.json();
}

async function getGoogleUserInfo(accessToken) {
  const res = await fetch(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

module.exports = function(pool, loginLimiter, signupLimiter) {
  const router = express.Router();

  // ── UTM attribution helper ───────────────────────────────────────────────
  // Writes first-touch UTM fields to a user row (only once — skips if already set).
  // attr is a plain object from the frontend; only known keys are written.
  async function saveAttribution(userId, attr) {
    if (!attr || typeof attr !== 'object') return;
    const allowed = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','signup_referrer'];
    const sets = [];
    const vals = [];
    let idx = 2;
    for (const key of allowed) {
      const v = attr[key];
      if (v && typeof v === 'string') {
        // Only update if column is still NULL (first-touch attribution only)
        sets.push(`${key} = COALESCE(${key}, $${idx})`);
        vals.push(v.slice(0, 500));
        idx++;
      }
    }
    if (sets.length === 0) return;
    await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1`,
      [userId, ...vals]
    );
  }

  // POST /api/auth/signup
  router.post('/signup', ...(signupLimiter ? [signupLimiter] : []), async (req, res) => {
    try {
      const { email, password, name, attribution, timezone } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
      }

      if (!/^[^\n\r@]+@[^\n\r@]+[.][^\n\r@]+$/.test(email.trim())) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address' });
      }

      if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      }

      const existing = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
        [email.trim()]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'An account with this email already exists. Try logging in.' });
      }

      const passwordHash = hashPassword(password);

      const validTz = timezone ? validateTimezone(timezone) : null;
      let result;
      if (validTz) {
        result = await pool.query(
          `INSERT INTO users (email, name, password_hash, timezone)
           VALUES ($1, $2, $3, $4) RETURNING id, email, name, created_at`,
          [email.trim().toLowerCase(), name ? name.trim() : null, passwordHash, validTz]
        );
      } else {
        result = await pool.query(
          `INSERT INTO users (email, name, password_hash)
           VALUES ($1, $2, $3) RETURNING id, email, name, created_at`,
          [email.trim().toLowerCase(), name ? name.trim() : null, passwordHash]
        );
      }

      const user = result.rows[0];

      // Non-essential setup rows — must NEVER fail the signup after the users
      // row exists (that leaves a ghost account that then reports "already
      // exists" on retry). Matches the Google OAuth path's resilience.
      await Promise.all([
        pool.query('INSERT INTO budgets (weekly_amount, is_active, user_id) VALUES (500.00, true, $1)', [user.id]),
        pool.query(`INSERT INTO app_subscription (plan, status, user_id) VALUES ('free', 'active', $1)`, [user.id]),
      ]).catch(err => console.error('[auth/signup] setup rows failed (account still created):', err.message));

      const token = generateToken(user);

      // Phase 2: Establish HttpOnly session cookie alongside JWT
      establishSession(req, user);

      // Save UTM attribution (fire-and-forget — never block the response)
      if (attribution) {
        saveAttribution(user.id, attribution).catch(() => {});
      }

      res.status(201).json({
        success: true,
        token: token,
        user: { id: user.id, email: user.email, name: user.name }
      });

      const { subject: welcomeSubject, html: welcomeHtml } = welcomeTemplate({ name: user.name });
      sendEmail(pool, {
        to: user.email,
        subject: welcomeSubject,
        html: welcomeHtml,
        templateType: 'welcome',
        userId: user.id
      }).catch((err) => {
        console.error('[auth/signup] Welcome email failed:', err.message);
      });

      // Seed Maslow-based default values for new users (fire-and-forget)
      seedDefaultValues(pool, user.id);
      seedStarterRoutine(pool, user.id).catch(() => {});
    } catch (err) {
      console.error('Signup error:', err);
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
      }
      res.status(500).json({ success: false, message: 'Failed to create account' });
    }
  });

  // POST /api/auth/login
  router.post('/login', ...(loginLimiter ? [loginLimiter] : []), async (req, res) => {
    try {
      const { email, password, timezone } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
      }

      const result = await pool.query(
        'SELECT id, email, name, password_hash, auth_method FROM users WHERE LOWER(email) = LOWER($1)',
        [email.trim()]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }

      const user = result.rows[0];

      if (!user.password_hash) {
        const msg = (user.auth_method === 'google')
          ? 'Your account uses Google sign-in. Click \"Log in with Google\" above to continue.'
          : 'Please use Google sign-in or set a password from your account settings.';
        return res.status(401).json({ success: false, message: msg });
      }

      const validPassword = verifyPassword(password, user.password_hash);

      if (!validPassword) {
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }

      // WHY: update timezone on every login — handles travel/device changes
      const loginTz = timezone ? validateTimezone(timezone) : null;
      if (loginTz) {
        Promise.resolve(pool.query(
          `UPDATE users SET login_count = COALESCE(login_count, 0) + 1, last_login_at = NOW(), timezone = $2 WHERE id = $1`,
          [user.id, loginTz]
        )).catch(() => {});
      } else {
        Promise.resolve(pool.query(
          `UPDATE users SET login_count = COALESCE(login_count, 0) + 1, last_login_at = NOW() WHERE id = $1`,
          [user.id]
        )).catch(() => {});
      }

      const token = generateToken(user);

      // Phase 2: Establish HttpOnly session cookie alongside JWT
      establishSession(req, user);

      res.json({
        success: true,
        token: token,
        user: { id: user.id, email: user.email, name: user.name }
      });

      // Seed defaults for existing users who have no values (fire-and-forget)
      seedDefaultValues(pool, user.id);
      seedStarterRoutine(pool, user.id).catch(() => {});
    } catch (err) {
      console.error('[auth/login] ERROR:', err.message, err.stack);
      res.status(500).json({ success: false, message: 'Failed to log in' });
    }
  });

  // POST /api/auth/logout — Phase 2: destroy HttpOnly session
  router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ success: false, message: 'Logout failed' });
      res.json({ success: true, message: 'Logged out' });
    });
  });

  // GET /api/auth/me
  router.get('/me', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, email, name, created_at, subscription_plan, subscription_status, auth_method, avatar_url, hourly_rate FROM users WHERE id = $1',
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      res.json({ success: true, user: result.rows[0] });
    } catch (err) {
      console.error('Error fetching user:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch user' });
    }
  });

  // GET /api/auth/google/start
  router.get('/google/start', async (req, res) => {
    if (!isGoogleAuthConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Google sign-in is not configured. Please use email and password.'
      });
    }

    const returnTo = (req.query.return_to === 'signup') ? 'signup' : 'login';
    const host = req.headers.host || 'focusledger.net';
    const state = signState(returnTo, host);

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id',     GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri',  GOOGLE_AUTH_REDIRECT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         GOOGLE_AUTH_SCOPE);
    url.searchParams.set('state',         state);
    url.searchParams.set('prompt',         'select_account');

    res.json({ success: true, url: url.toString() });
  });

  // GET /api/auth/google/callback
  router.get('/google/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      console.error('[auth/google/callback] OAuth error:', error);
      return res.redirect('/login?google_error=access_denied');
    }

    if (!code || !state) {
      return res.redirect('/login?google_error=invalid_callback');
    }

    const stateData = verifyState(state);
    if (!stateData) {
      return res.redirect('/login?google_error=invalid_state');
    }
    const { returnTo, host } = stateData;
    const proto = host.startsWith('localhost') ? 'http' : 'https';
    const base  = `${proto}://${host}`;

    try {
      const tokens = await exchangeGoogleCode(code);
      if (tokens.error) {
        console.error('[auth/google/callback] Token exchange failed:', tokens.error, tokens.error_description || '');
        return res.redirect(`${base}/${returnTo}?google_error=${encodeURIComponent(tokens.error)}`);
      }

      const userInfo = await getGoogleUserInfo(tokens.access_token);
      if (!userInfo || !userInfo.email) {
        console.error('[auth/google/callback] Failed to get user info:', userInfo);
        return res.redirect(`${base}/${returnTo}?google_error=userinfo_failed`);
      }

      const googleId   = userInfo.id || null;
      const email      = userInfo.email.toLowerCase();
      const name       = userInfo.name || null;
      const avatarUrl  = userInfo.picture || null;

      const existingByEmail = await pool.query(
        'SELECT id, email, name, password_hash, auth_method, google_id FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      let user;
      let accountLinked = false;

      if (existingByEmail.rows.length > 0) {
        const existing = existingByEmail.rows[0];

        if (existing.google_id && existing.google_id !== googleId) {
          return res.redirect(`${base}/login?google_error=email_taken`);
        }

        const newAuthMethod = existing.password_hash ? 'both' : 'google';
        await pool.query(
          `UPDATE users SET
             google_id   = $1,
             auth_method = $2,
             name        = COALESCE(NULLIF(name, ''), $3),
             avatar_url  = COALESCE(avatar_url, $5)
           WHERE id = $4`,
          [googleId, newAuthMethod, name, existing.id, avatarUrl]
        );

        user = { id: existing.id, email, name };
        accountLinked = !!existing.password_hash;
        // Seed defaults for returning Google users who have no values (fire-and-forget)
        seedDefaultValues(pool, user.id);
      seedStarterRoutine(pool, user.id).catch(() => {});
      } else {
        const result = await pool.query(
          `INSERT INTO users (email, name, google_id, auth_method, avatar_url)
           VALUES ($1, $2, $3, 'google', $4)
           RETURNING id, email, name`,
          [email, name, googleId, avatarUrl]
        );

        user = result.rows[0];

        await Promise.all([
          pool.query('INSERT INTO budgets (weekly_amount, is_active, user_id) VALUES (500.00, true, $1)', [user.id]),
          pool.query(`INSERT INTO app_subscription (plan, status, user_id) VALUES ('free', 'active', $1)`, [user.id])
        ]).catch(err => console.error('[auth/google/callback] Setup error:', err));

        const { subject: gWelcomeSubject, html: gWelcomeHtml } = welcomeTemplate({ name: user.name });
        sendEmail(pool, {
          to: user.email,
          subject: gWelcomeSubject,
          html: gWelcomeHtml,
          templateType: 'welcome',
          userId: user.id
        }).catch((err) => {
          console.error('[auth/google/callback] Welcome email failed:', err.message);
        });

        // Seed Maslow-based default values for new Google users (fire-and-forget)
        seedDefaultValues(pool, user.id);
      seedStarterRoutine(pool, user.id).catch(() => {});
      }

      const token = generateToken(user);

      // Phase 2: Establish HttpOnly session cookie alongside JWT
      establishSession(req, user);

      res.redirect(`${base}/${returnTo}?google_token=${encodeURIComponent(token)}&google_email=${encodeURIComponent(email)}${accountLinked ? '&google_linked=1' : ''}`);
    } catch (err) {
      console.error('[auth/google/callback] Error:', err);
      res.redirect(`${base}/${returnTo}?google_error=server_error`);
    }
  });

  // POST /api/auth/google/link-password
  router.post('/google/link-password', authenticateToken, async (req, res) => {
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    try {
      const passwordHash = hashPassword(password);

      const result = await pool.query(
        `UPDATE users SET
           password_hash = $1,
           auth_method   = 'both'
         WHERE id = $2 AND auth_method = 'google'
         RETURNING id, email, name`,
        [passwordHash, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Your account does not support password linking. Only Google-auth accounts can set a password here.'
        });
      }

      res.json({ success: true, message: 'Password set successfully. You can now log in with email and password.' });
    } catch (err) {
      console.error('[auth/google/link-password] Error:', err);
      res.status(500).json({ success: false, message: 'Failed to set password' });
    }
  });

  // ── Password Reset ──────────────────────────────────────────────────────────

  const APP_URL = process.env.APP_URL || 'https://focusledger.net';
  const TOKEN_EXPIRY_HOURS = 1;

  // POST /api/auth/forgot-password
  // Generate a reset token and email it. Always returns 200 to prevent enumeration.
  router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
    try {
      const { email } = req.body;

      if (!email || !/^[^\n\r@]+@[^\n\r@]+[.][^\n\r@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'A valid email address is required.' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      const userResult = await pool.query(
        'SELECT id, email, name, password_hash, auth_method FROM users WHERE LOWER(email) = LOWER($1)',
        [normalizedEmail]
      );

      if (userResult.rows.length === 0) {
        return res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
      }

      const user = userResult.rows[0];

      // Google-only users have no password to reset
      if (!user.password_hash) {
        const { subject, html } = passwordResetGoogleOnlyTemplate({ name: user.name });
        sendEmail(pool, {
          to: user.email,
          subject,
          html,
          templateType: 'password_reset',
          userId: user.id
        }).catch((err) => console.error('[auth/forgot-password] Google-only email failed:', err.message));
        return res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
      }

      // Invalidate any existing unused tokens
      await pool.query(
        'DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL',
        [user.id]
      );

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${APP_URL}/reset-password?token=${rawToken}`;

      const { subject, html } = passwordResetTemplate({ name: user.name, resetUrl });
      sendEmail(pool, {
        to: user.email,
        subject,
        html,
        templateType: 'password_reset',
        userId: user.id
      }).catch((err) => console.error('[auth/forgot-password] Reset email failed:', err.message));

      res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
    } catch (err) {
      console.error('[auth/forgot-password] Error:', err);
      res.status(500).json({ success: false, message: 'Failed to process request. Please try again.' });
    }
  });

  // POST /api/auth/reset-password
  // Validates token and sets new password.
  router.post('/reset-password', passwordResetLimiter, async (req, res) => {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({ success: false, message: 'Token and new password are required.' });
      }

      if (typeof token !== 'string' || token.length !== 64) {
        return res.status(400).json({ success: false, message: 'Invalid reset link. Please request a new one.' });
      }

      if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const tokenResult = await pool.query(
        `SELECT id, user_id FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );

      if (tokenResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'This reset link has expired or was already used. Please request a new one.'
        });
      }

      const record = tokenResult.rows[0];

      // Mark token as used immediately
      await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);

      // Update password
      const passwordHash = hashPassword(password);
      await pool.query(
        'UPDATE users SET password_hash = $1, auth_method = CASE WHEN auth_method = $2 THEN $3 ELSE auth_method END WHERE id = $4',
        [passwordHash, 'google', 'both', record.user_id]
      );

      // Track event
      pool.query(
        `INSERT INTO analytics_events (visitor_hash, user_id, event_name, event_data, occurred_at)
         VALUES ($1, $2, 'password_reset_completed', '{}', NOW())`,
        [`user-${record.user_id}`, record.user_id]
      ).catch(() => {});

      res.json({ success: true, message: 'Your password has been updated. You can now log in.' });
    } catch (err) {
      console.error('[auth/reset-password] Error:', err);
      res.status(500).json({ success: false, message: 'Failed to reset password. Please try again.' });
    }
  });

  // POST /api/auth/google/one-tap
  // Verifies a Google Identity Services credential (id_token) and returns a FL JWT.
  // Owns: One Tap + Google Sign-In button flows from the landing page.
  // Does NOT own: server-side OAuth redirect flow (see /google/start + /google/callback above).
  router.post('/google/one-tap', async (req, res) => {
    try {
      const { credential, attribution } = req.body;
      if (!credential || typeof credential !== 'string') {
        return res.status(400).json({ success: false, message: 'credential is required' });
      }
      if (!GOOGLE_CLIENT_ID) {
        return res.status(503).json({ success: false, message: 'Google sign-in is not configured' });
      }

      // Verify via Google tokeninfo — simple, no library, validates sig + expiry server-side
      const infoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
      );
      const info = await infoRes.json();

      if (info.error || !info.email) {
        console.error('[auth/google/one-tap] tokeninfo error:', info.error || 'no email');
        return res.status(401).json({ success: false, message: 'Invalid Google credential' });
      }

      // Guard against credentials issued for a different app
      if (info.aud !== GOOGLE_CLIENT_ID) {
        console.error('[auth/google/one-tap] aud mismatch:', info.aud, '!=', GOOGLE_CLIENT_ID);
        return res.status(401).json({ success: false, message: 'Invalid credential audience' });
      }

      const email     = info.email.toLowerCase();
      const name      = info.name || null;
      const avatarUrl = info.picture || null;
      const googleId  = info.sub || null;

      const existingRes = await pool.query(
        'SELECT id, email, name, password_hash, auth_method FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      let user;
      let isNewUser = false;

      if (existingRes.rows.length > 0) {
        // Returning user — link Google ID if not already set, update avatar
        const existing = existingRes.rows[0];
        const newAuthMethod = existing.password_hash ? 'both' : 'google';
        await pool.query(
          `UPDATE users SET
             google_id   = COALESCE(google_id, $1),
             auth_method = $2,
             name        = COALESCE(NULLIF(name, ''), $3),
             avatar_url  = COALESCE(avatar_url, $5)
           WHERE id = $4`,
          [googleId, newAuthMethod, name, existing.id, avatarUrl]
        );
        user = { id: existing.id, email, name: existing.name || name };
        // Seed defaults for returning One Tap users who have no values (fire-and-forget)
        seedDefaultValues(pool, user.id);
      seedStarterRoutine(pool, user.id).catch(() => {});
      } else {
        // New user
        isNewUser = true;
        const result = await pool.query(
          `INSERT INTO users (email, name, google_id, auth_method, avatar_url)
           VALUES ($1, $2, $3, 'google', $4)
           RETURNING id, email, name`,
          [email, name, googleId, avatarUrl]
        );
        user = result.rows[0];

        // Seed required account records (budget + subscription)
        await Promise.all([
          pool.query('INSERT INTO budgets (weekly_amount, is_active, user_id) VALUES (500.00, true, $1)', [user.id]),
          pool.query(`INSERT INTO app_subscription (plan, status, user_id) VALUES ('free', 'active', $1)`, [user.id])
        ]).catch(err => console.error('[auth/google/one-tap] Setup error:', err));

        // Onboarding flag — buddy.html checks /api/onboarding/status and redirects new users
        // to Buddy-led onboarding conversation before showing the main app.

        // Welcome email — fire-and-forget
        const { subject: ws, html: wh } = welcomeTemplate({ name: user.name });
        sendEmail(pool, { to: user.email, subject: ws, html: wh, templateType: 'welcome', userId: user.id })
          .catch(err => console.error('[auth/google/one-tap] Welcome email failed:', err.message));

        // Save UTM attribution for new users (fire-and-forget)
        if (attribution) {
          saveAttribution(user.id, attribution).catch(() => {});
        }
      }

      // Analytics — track which path brought them in (server-side because One Tap
      // may fire from the landing page where the client-side FLA lib isn't guaranteed loaded)
      pool.query(
        `INSERT INTO analytics_events (visitor_hash, user_id, event_name, event_data, occurred_at)
         VALUES ($1, $2, $3, '{}', NOW())`,
        [`user-${user.id}`, user.id, isNewUser ? 'signup_google_one_tap' : 'login_google_one_tap']
      ).catch(() => {});

      // Phase 2: Establish HttpOnly session cookie alongside JWT
      establishSession(req, user);
      res.json({ success: true, token: generateToken(user), isNewUser });
    } catch (err) {
      console.error('[auth/google/one-tap] Error:', err);
      res.status(500).json({ success: false, message: 'Sign-in failed. Please try again.' });
    }
  });

  // PATCH /api/auth/attribution — save UTM attribution after Google OAuth redirect.
  // Called client-side after the OAuth callback delivers a token via query param.
  // UTMs survived the redirect in localStorage; this endpoint writes them to the DB.
  // Idempotent: COALESCE ensures only the first write wins (first-touch attribution).
  router.patch('/attribution', authenticateToken, async (req, res) => {
    try {
      await saveAttribution(req.user.id, req.body);
      res.json({ success: true });
    } catch (err) {
      // Non-critical — log but don't surface to client
      console.error('[auth/attribution] Error:', err.message);
      res.json({ success: false });
    }
  });

  // POST /api/auth/migrate-demo-session
  // Hydrates a new account with data from an anonymous Buddy demo session.
  // Called client-side immediately after signup/login when fl_demo_session_token
  // is present in localStorage. Idempotent — safe to call more than once.
  router.post('/migrate-demo-session', authenticateToken, async (req, res) => {
    const { session_token } = req.body;
    if (!session_token || typeof session_token !== 'string' || session_token.length < 10) {
      return res.status(400).json({ success: false, message: 'session_token required' });
    }

    try {
      const data = await getSessionData(pool, session_token);

      // Session not found — expired or never existed. Silent pass.
      if (!data) {
        return res.json({ success: true, migrated: false, reason: 'session_not_found' });
      }

      const session = data.session;

      // Guard: session older than 7 days — skip silently.
      const ageMs = Date.now() - new Date(session.created_at).getTime();
      if (ageMs > 7 * 24 * 60 * 60 * 1000) {
        return res.json({ success: true, migrated: false, reason: 'session_expired' });
      }

      // Guard: already migrated — return existing import summary.
      const alreadyMigrated = await isSessionMigrated(pool, session_token);
      if (alreadyMigrated) {
        return res.json({ success: true, migrated: false, alreadyMigrated: true });
      }

      const userId = req.user.id;
      const imported = { tasks: [], values: [] };

      // ── Import tasks ───────────────────────────────────────────────────────
      // extracted_tasks is a JSONB array of strings from the demo session.
      const extractedTasks = Array.isArray(session.extracted_tasks)
        ? session.extracted_tasks
        : [];

      for (const title of extractedTasks) {
        if (!title || typeof title !== 'string') continue;
        const cleanTitle = title.trim().slice(0, 255);
        if (!cleanTitle) continue;
        try {
          const taskResult = await pool.query(
            `INSERT INTO tasks (user_id, title, priority, source)
             VALUES ($1, $2, 'medium', 'buddy_demo')
             RETURNING id, title`,
            [userId, cleanTitle]
          );
          if (taskResult.rows[0]) imported.tasks.push(taskResult.rows[0]);
        } catch (insertErr) {
          // Non-fatal — log but continue importing remaining tasks.
          console.error('[migrate-demo-session] Task insert error:', insertErr.message);
        }
      }

      // ── Import values ──────────────────────────────────────────────────────
      const surfacedValues = Array.isArray(session.surfaced_values)
        ? session.surfaced_values
        : [];

      for (const val of surfacedValues) {
        if (!val || typeof val !== 'string') continue;
        const cleanVal = val.trim().slice(0, 100);
        if (!cleanVal) continue;
        try {
          // Upsert: skip if user already has this value_name (case-insensitive check).
          const existingVal = await pool.query(
            `SELECT id FROM user_values WHERE user_id = $1 AND LOWER(value_name) = LOWER($2)`,
            [userId, cleanVal]
          );
          if (existingVal.rows.length === 0) {
            await pool.query(
              `INSERT INTO user_values (user_id, value_name) VALUES ($1, $2)`,
              [userId, cleanVal]
            );
            imported.values.push(cleanVal);
          }
        } catch (_valErr) {
          // Non-fatal.
        }
      }

      // ── Import conversation as first Buddy record ──────────────────────────
      // Write the demo conversation turns into buddy_conversations so the day-2
      // hook has context and the user can see their conversation in the app.
      const userTzForDemo = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(userTzForDemo);
      if (data.turns && data.turns.length > 0) {
        try {
          // Check whether user already has a buddy conversation for today.
          const existingConvo = await pool.query(
            `SELECT id FROM buddy_conversations WHERE user_id = $1 AND session_date = $2 LIMIT 1`,
            [userId, today]
          );

          if (existingConvo.rows.length === 0) {
            // Insert turns preserving order. Re-number from 1 to avoid collisions.
            let turnNum = 1;
            for (const turn of data.turns) {
              await pool.query(
                `INSERT INTO buddy_conversations (user_id, session_date, role, message, turn)
                 VALUES ($1, $2, $3, $4, $5)`,
                [userId, today, turn.role, turn.message, turnNum++]
              );
            }
          }
        } catch (convoErr) {
          // Non-fatal — conversation import is a nice-to-have.
          console.error('[migrate-demo-session] Conversation import error:', convoErr.message);
        }
      }

      // ── Store conversation summary for day-2 hook ──────────────────────────
      if (session.conversation_summary) {
        pool.query(
          `UPDATE users SET previous_checkin_summary = $1 WHERE id = $2 AND previous_checkin_summary IS NULL`,
          [session.conversation_summary.slice(0, 1000), userId]
        ).catch(() => {});
      }

      // ── Mark migrated ──────────────────────────────────────────────────────
      await markSessionMigrated(pool, session_token, userId);

      // Analytics — track conversion event
      pool.query(
        `INSERT INTO analytics_events (visitor_hash, user_id, event_name, event_data, occurred_at)
         VALUES ($1, $2, 'demo_session_migrated', $3, NOW())`,
        [
          `user-${userId}`,
          userId,
          JSON.stringify({ task_count: imported.tasks.length, value_count: imported.values.length })
        ]
      ).catch(() => {});

      res.json({
        success: true,
        migrated: true,
        imported: {
          taskCount: imported.tasks.length,
          valueCount: imported.values.length,
          tasks: imported.tasks
        }
      });
    } catch (err) {
      console.error('[migrate-demo-session] Error:', err.message);
      res.status(500).json({ success: false, message: 'Migration failed' });
    }
  });

  // PATCH /api/auth/hourly-rate — save user's hourly rate for spending-in-work-hours context
  router.patch('/hourly-rate', authenticateToken, async (req, res) => {
    try {
      const raw = req.body.hourly_rate;
      const rate = raw === null || raw === '' ? null : parseFloat(raw);
      if (rate !== null && (isNaN(rate) || rate < 0 || rate > 10000)) {
        return res.status(400).json({ success: false, message: 'Hourly rate must be between 0 and 10000' });
      }
      await pool.query('UPDATE users SET hourly_rate = $1 WHERE id = $2', [rate, req.user.id]);
      res.json({ success: true, hourly_rate: rate });
    } catch (err) {
      console.error('[auth/hourly-rate]', err.message);
      res.status(500).json({ success: false, message: 'Failed to update hourly rate' });
    }
  });

  // PATCH /api/auth/profile — update display name
  router.patch('/profile', authenticateToken, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'Name is required' });
      }
      const cleanName = name.trim().slice(0, 100);
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [cleanName, req.user.id]);
      res.json({ success: true, name: cleanName });
    } catch (err) {
      console.error('[auth/profile] Error:', err);
      res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
  });

  return router;
};