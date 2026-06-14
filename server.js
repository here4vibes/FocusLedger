// =============================================================================
// SECURITY MEASURES — FocusLedger Production Server
// =============================================================================
//
// HTTP Headers (via Helmet):
//   - Content-Security-Policy: restricts scripts/styles/images to self + known CDNs
//   - Strict-Transport-Security: max-age=31536000, includeSubDomains
//   - X-Content-Type-Options: nosniff
//   - X-Frame-Options: DENY (prevents clickjacking)
//   - X-XSS-Protection: 1; mode=block
//   - Referrer-Policy: strict-origin-when-cross-origin
//   - Permissions-Policy: disables camera, microphone, geolocation, payment
//
// Authentication:
//   - JWT tokens: HMAC-SHA256, 30-day expiry, verified on every protected route
//   - Password hashing: PBKDF2-SHA512, 100k iterations, 32-byte random salt
//   - JWT stored in localStorage (migration to HttpOnly cookies is future work)
//   - Rate limiting on /api/auth/login and /api/auth/signup endpoints
//
// CORS: Restricted to app's own origin (ALLOWED_ORIGIN env var or production domain)
// Rate Limiting: /api/auth/login: 10/15min, /api/auth/signup: 5/hr, /api (global): 300/15min
// Request Limits: JSON body: 1MB max, URL-encoded body: 1MB max
// =============================================================================

// ── Sentry must initialize before any other requires ────────────────────────
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    release: process.env.RENDER_GIT_COMMIT || undefined,
  });
}

// ── Rule 19: Uncaught exception handlers (crash loudly, never silently) ─────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException — process will exit:', err.message, err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection at:', promise, 'reason:', reason);
  // Do not exit — unhandled rejections are recoverable in most cases, but must be logged.
});

const express = require('express');
const { Pool, types } = require('pg');

// WHY: pg's default DATE parser creates JS Date objects at midnight in the
// process timezone, then JSON.stringify calls .toISOString() which converts
// to UTC — shifting the calendar date ±1 day if the server isn't in UTC.
// Returning the raw string ("2026-05-11") avoids timezone-dependent drift.
types.setTypeParser(1082, (val) => val);   // DATE  → raw "YYYY-MM-DD"
const path = require('path');
const {
  helmetMiddleware,
  corsMiddleware,
  permissionsPolicyMiddleware,
  globalLimiter,
  loginLimiter,
  signupLimiter
} = require('./middleware/security');
const { scheduleMorningNudges } = require('./morningNudge');
const { scheduleEveningNudges } = require('./eveningNudge');
const { scheduleTaskDeadlineNudges } = require('./taskDeadlineNudge');
const { scheduleEmailCrons } = require('./emailCron');
const { schedulePlaidDailySync } = require('./plaidDailySync');
const { scheduleBuddyEngagementCron } = require('./buddyEngagementCron');
const { runV2LaunchCampaign } = require('./lib/v2LaunchCampaign');
const { verifyToken } = require('./middleware/auth');
const { buildSessionMiddleware } = require('./lib/session');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000
});

// WHY: Neon suspend/wake cycles leave dead idle connections in the pool.
// Without this handler, dead connections propagate as user-facing 500s.
pool.on('error', (err) => {
  console.error('[Pool] Idle client error (connection recycled):', err.message);
});

// =============================================================================
// 1. SECURITY MIDDLEWARE
// =============================================================================
app.use(helmetMiddleware);
app.use(permissionsPolicyMiddleware);
app.use(corsMiddleware);

// =============================================================================
// 2. REQUEST PARSING
// =============================================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// =============================================================================
// 3. RATE LIMITING + last_active_at tracking
// =============================================================================
app.use('/api', globalLimiter);

// Fire-and-forget: track last active time for re-engagement cron.
// Throttled to once per hour per user — avoids a write on every API call
// while still giving the cron accurate inactivity data.
const lastActiveCache = new Map(); // userId → last DB write time (ms)
const LAST_ACTIVE_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

app.use('/api', (req, res, next) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (token) {
    try {
      const decoded = verifyToken(token);
      if (decoded?.id) {
        const userId = decoded.id;
        const now = Date.now();
        const lastWrite = lastActiveCache.get(userId) || 0;
        if (now - lastWrite >= LAST_ACTIVE_THROTTLE_MS) {
          lastActiveCache.set(userId, now);
          pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [userId])
            .catch(() => {});
        }
      }
    } catch {
      // Invalid token — auth middleware handles rejection downstream
    }
  }
  next();
});

// 4a. SESSION
app.use(buildSessionMiddleware(pool));

// 4b. HEALTH CHECK — must respond even when DB is slow (Neon cold-start)
app.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 4000)),
    ]);
    res.json({ status: 'ok', db: 'ok', latency_ms: Date.now() - start, commit: process.env.RENDER_GIT_COMMIT || 'unknown' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'error', error: err.message, latency_ms: Date.now() - start });
  }
});

// Temporary diagnostic — shows tasks.id column state and migration history
app.get('/api/debug/tasks-schema', async (req, res) => {
  try {
    const [colRes, trigRes, migRes, nullRes, seqRes] = await Promise.all([
      pool.query(`SELECT column_default, is_nullable, identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='id'`),
      pool.query(`SELECT trigger_name FROM information_schema.triggers WHERE event_object_table='tasks' AND trigger_name='tasks_auto_id'`),
      pool.query(`SELECT name, applied_at FROM _migrations ORDER BY applied_at DESC LIMIT 10`),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM tasks WHERE id IS NULL`),
      pool.query(`SELECT sequencename, last_value FROM pg_sequences WHERE sequencename='tasks_id_seq'`),
    ]);
    res.json({
      id_column: colRes.rows[0],
      trigger_installed: trigRes.rows.length > 0,
      null_id_tasks: nullRes.rows[0].cnt,
      sequence: seqRes.rows[0] || null,
      recent_migrations: migRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// 5. API ROUTES
// =============================================================================
const newsRouteFactory = require('./routes/news');

app.use('/api/auth',            require('./routes/auth')(pool, loginLimiter, signupLimiter));
app.use('/api/contact',         require('./routes/contact')(pool));
app.use('/api/comeback',        require('./routes/comeback')(pool));
app.use('/api/tasks',           require('./routes/tasks-prisma')(pool));
app.use('/api/expenses',        require('./routes/expenses')(pool));
app.use('/api/subscription',    require('./routes/subscription')(pool));
app.use('/api/plaid',           require('./routes/plaid')(pool));
app.use('/api/money',           require('./routes/money-prisma')(pool));
app.use('/api/ideas',           require('./routes/ideas')(pool));
app.use('/api/recurring',       require('./routes/recurring')(pool));
app.use('/api/values',          require('./routes/values')(pool));
app.use('/api/time-blocks',     require('./routes/time-blocks')(pool));
app.use('/api/nudges',          require('./routes/alignment-nudges')(pool));
app.use('/api/admin',           require('./routes/admin')(pool));
app.use('/api/email',           require('./routes/email')(pool));
app.use('/api/ai-suggestions',  require('./routes/ai-suggestions')(pool));
app.use('/api/ai',               require('./routes/ai')(pool));
app.use('/api/capture',          require('./routes/capture')());
app.use('/api/notifications',   require('./routes/notifications')(pool));
app.use('/api/v1/notifications', require('./routes/notifications-v1'));
app.use('/api/v1/spending-sessions', require('./routes/spending-sessions')(pool));
app.use('/api/adhd-tax',        require('./routes/adhd-tax')(pool));
app.use('/api/analytics',       require('./routes/analytics')(pool));
app.use('/api/news',            newsRouteFactory(pool));
app.use('/api/alignment-score', require('./routes/alignment-score')(pool));
app.use('/api/momentum-score',  require('./routes/momentum-score')(pool));
app.use('/api/outbound-email',  require('./routes/outbound-email')(pool));
app.use('/api/journal',         require('./routes/journal')(pool));
app.use('/api/buddy',           require('./routes/buddy')(pool));
app.use('/api/buddy-widget',    require('./routes/buddy-widget')(pool));
app.use('/api/documents',       require('./routes/documents')(pool));
app.use('/api/nudge-system',    require('./routes/nudge-system')(pool));
app.use('/api/insurance',       require('./routes/insurance')(pool));
app.use('/api/work-hours',      require('./routes/work-hours')(pool));
app.use('/api/account-deletion', require('./routes/account-deletion')(pool));
app.use('/api/email-to-tasks',  require('./routes/email-to-tasks')(pool));
app.use('/api/buddy-demo',      require('./routes/buddy-demo')(pool));
app.use('/api/daily-brief',     require('./routes/daily-brief')(pool));
app.use('/api/weekly-recap',    require('./routes/weekly-recap')(pool));
app.use('/api/evening',         require('./routes/evening-checkin')(pool));
app.use('/api/partnerships',    require('./routes/partnerships')(pool));
app.use('/api/siri',            require('./routes/siri')(pool));
app.use('/api/waitlist',        require('./routes/waitlist')(pool));
app.use('/api/leads',           require('./routes/lead-magnets')(pool).publicRouter);
app.use('/api/admin/leads',      require('./routes/lead-magnets')(pool).adminRouter);
app.use('/api/routines',        require('./routes/routineNudges')(pool));
app.use('/api/auto-routines',    require('./routes/autoRoutines')(pool));
app.use('/api/followup-emails',   require('./routes/followupEmails')(pool));
app.use('/api/push',             require('./routes/push-tokens')(pool));
app.use('/api/health-score',     require('./routes/health-score')(pool));
app.use('/api/gcal',             require('./routes/google-calendar')(pool));
// v1 API: Plaid connect/disconnect + Transaction endpoints
app.use('/api/v1',                 require('./routes/v1')(pool));
app.use('/api/v1/insights',       require('./routes/insights')(pool));
app.use('/api/v1/check-in',       require('./routes/check-in')(pool));

app.use('/api/v1/focus-sessions', require('./routes/focus-sessions')(pool));
app.use('/api/v1/focus-preferences', require('./routes/focus-prefs')(pool));
app.use('/api/v1',                require('./routes/time-estimations')(pool));

// Promo codes: admin CRUD + user redemption
const promoRoutes = require('./routes/promo-codes')(pool);
app.use('/api/admin/promo-codes', promoRoutes.adminRouter);
app.use('/api/promo',             promoRoutes.promoRouter);

// Inbound email webhook — no auth (/api/inbox/* sub-routes enforce admin auth separately).
const inboundEmailRouter = require('./routes/inbound-email')(pool);
app.use('/api/webhooks/resend-inbound', (req, res, next) => { req.url = '/webhook'; inboundEmailRouter(req, res, next); });
app.use('/api/inbox',           inboundEmailRouter);
app.use('/api/webhooks/plaid',  require('./routes/plaid-webhook')(pool));

// =============================================================================
// 5b. API 404 CATCH-ALL — return JSON, not Express's default HTML error page
// =============================================================================
// WHY: Express's built-in finalhandler returns <!DOCTYPE html> for unmatched
// routes. When API clients receive HTML instead of JSON, .json() parsing throws
// "Unexpected token '<'" — making the real problem (wrong path or missing route)
// invisible behind a generic parse error. This handler ensures every /api/*
// miss returns a JSON 404 the frontend can handle cleanly.
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

// =============================================================================
// 6. STATIC FILES + PAGE ROUTES
// =============================================================================
require('./routes/static-cache')(app, __dirname);
app.use(express.static(path.join(__dirname, 'public')));
app.use(require('./routes/pages'));

// =============================================================================
// 7. GLOBAL ERROR HANDLER — never leak stack traces or internal details
// =============================================================================
if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  console.error('[Global Error Handler]', err.message || err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: status < 500 ? err.message : 'An unexpected error occurred'
  });
});

const { purgeExpiredStash } = require('./db/email-to-tasks');

// Inline tasks.id schema repair — runs on every start until schema is correct.
// Bypasses migrate.js entirely; uses the live pool that we know is working.
// Non-blocking: server starts regardless of whether repair succeeds.
(async () => {
  let client;
  try {
    client = await pool.connect();
    await client.query('SET statement_timeout = 0'); // DDL may wait for locks
    await client.query('BEGIN');

    // 1. Ensure sequence exists and is synced
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'tasks_id_seq') THEN
          CREATE SEQUENCE tasks_id_seq;
        END IF;
      END $$
    `);
    await client.query(`
      SELECT setval('tasks_id_seq',
        COALESCE((SELECT MAX(id) FROM tasks WHERE id IS NOT NULL), 0) + 1, false)
    `);

    // 2. Wire DEFAULT on id if not already set
    const { rows: [col] } = await client.query(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tasks' AND column_name='id'`
    );
    if (!col?.column_default?.startsWith('nextval')) {
      await client.query(
        `ALTER TABLE tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq')`
      );
      console.log('[startup] tasks.id DEFAULT set');
    }

    // 3. Install BEFORE INSERT trigger (belt-and-suspenders)
    await client.query(`
      CREATE OR REPLACE FUNCTION tasks_assign_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS NULL THEN NEW.id := nextval('tasks_id_seq'); END IF;
        RETURN NEW;
      END; $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS tasks_auto_id ON tasks`);
    await client.query(`
      CREATE TRIGGER tasks_auto_id
        BEFORE INSERT ON tasks
        FOR EACH ROW EXECUTE FUNCTION tasks_assign_id()
    `);

    // 4. Delete null-ID tasks
    const { rows: [{ cnt }] } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM tasks WHERE id IS NULL`
    );
    if (cnt > 0) {
      await client.query(`DELETE FROM task_steps WHERE task_id IS NULL`);
      await client.query(`DELETE FROM tasks WHERE id IS NULL`);
      console.log(`[startup] purged ${cnt} null-ID tasks`);
    }

    await client.query('COMMIT');
    console.log('[startup] tasks.id repair done');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[startup] tasks.id repair failed:', e.message);
  } finally {
    if (client) client.release();
  }
})();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  newsRouteFactory.startRssCron(pool);
  scheduleMorningNudges(pool);
  scheduleEveningNudges(pool);
  scheduleTaskDeadlineNudges(pool);
  scheduleEmailCrons(pool);
  schedulePlaidDailySync(pool);
  scheduleBuddyEngagementCron(pool);

  // WHY: email_tasks_stash rows expire after 72h. Clean up once a day so the
  // table doesn't grow indefinitely from unclaimed magic links.
  const runStashPurge = () => purgeExpiredStash(pool)
    .then(n => n > 0 && console.log(`[email-to-tasks] Purged ${n} expired stash entries`))
    .catch(err => console.error('[email-to-tasks] Stash cleanup error:', err.message));
  setTimeout(() => { runStashPurge(); setInterval(runStashPurge, 24 * 60 * 60 * 1000); }, 60 * 1000);
  // One-shot: fires v2 launch campaign on startup if not already sent.
  // Self-disabling — once all users have a v2_launch email_log entry, this is a no-op.
  setTimeout(() => runV2LaunchCampaign(pool), 30 * 1000);
});