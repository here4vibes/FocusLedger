/**
 * Analytics Route
 *
 * Provides lightweight, privacy-friendly analytics endpoints:
 *   POST /api/analytics/visit  — record a page view (with referrer + UTM + device)
 *   POST /api/analytics/event  — record a named event (button click, funnel step, feature use)
 *   GET  /api/analytics/summary — admin-only aggregated report
 *
 * Privacy principles:
 *   - No PII stored in analytics tables
 *   - visitor_hash is a daily-salted SHA256 of an anonymous client UUID
 *   - user_id stored only for logged-in events (FK to users table)
 *   - Referrers truncated + stripped of query params to prevent PII leakage
 *   - UTM params captured as-is (set by marketer, not user-generated)
 *   - All endpoints return 204/200 silently on bot detection or validation failure
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');

// ── Bot UA patterns to reject ──────────────────────────────────────────────
const BOT_PATTERNS = [
  /bot/i, /crawl/i, /spider/i, /slurp/i, /fetch/i, /scan/i,
  /headless/i, /phantom/i, /puppeteer/i, /playwright/i, /selenium/i,
  /python-requests/i, /go-http/i, /curl/i, /wget/i, /libwww/i,
  /googlebot/i, /bingbot/i, /yandex/i, /duckduck/i, /baidu/i,
  /semrush/i, /ahrefs/i, /mj12bot/i, /rogerbot/i, /dotbot/i,
  /ia_archiver/i, /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i,
  /whatsapp/i, /telegrambot/i, /applebot/i, /dataprovider/i,
  /screaming.frog/i, /sistrix/i, /archive.org/i,
  // HTTP clients + uptime monitors + AI crawlers (UA-declared)
  /axios/i, /node-fetch/i, /okhttp/i, /scrapy/i, /java\//i, /httpclient/i,
  /pingdom/i, /uptimerobot/i, /statuscake/i, /site24x7/i,
  /lighthouse/i, /pagespeed/i, /gtmetrix/i,
  /gptbot/i, /claudebot/i, /ccbot/i, /bytespider/i, /petalbot/i, /amazonbot/i,
  /anthropic/i, /perplexity/i,
];

function isBot(userAgent) {
  if (!userAgent) return true;
  return BOT_PATTERNS.some(p => p.test(userAgent));
}

// ── Daily-salted hash: same visitor_id, different day → different hash ─────
function dailyHash(visitorId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return crypto.createHash('sha256').update(`${today}:${visitorId}`).digest('hex');
}

// ── Validate visitor ID (must look like a UUID or short hex string) ────────
function isValidVisitorId(id) {
  if (!id || typeof id !== 'string' || id.length > 64) return false;
  return /^[a-f0-9-]{8,64}$/i.test(id);
}

// ── Sanitize page slug ─────────────────────────────────────────────────────
const ALLOWED_PAGES = new Set([
  'landing', 'app', 'pricing', 'adhd-tax', 'login', 'signup',
  'settings', 'ideas', 'values', 'calendar', 'email',
  'privacy', 'terms', 'share', 'other'
]);

function sanitizePage(page) {
  if (!page || typeof page !== 'string') return 'other';
  const slug = page.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
  return ALLOWED_PAGES.has(slug) ? slug : 'other';
}

// ── Sanitize event name ────────────────────────────────────────────────────
const ALLOWED_EVENTS = new Set([
  // Signup funnel
  'funnel_landing_visit',
  'funnel_pricing_visit',
  'funnel_signup_visit',
  'funnel_signup_start',       // first field interaction on signup form
  'funnel_signup_complete',    // successful signup
  'funnel_login_visit',
  'funnel_demo_interact',      // user typed/sent first message in Buddy demo
  'funnel_lead_magnet_click',  // clicked Science Cheat Sheet or Daily Three download
  'funnel_scroll_25',
  'funnel_scroll_50',
  'funnel_scroll_75',
  'funnel_scroll_100',

  // CTA / button clicks
  'cta_signup_free',           // "Sign Up Free" / "Get Started" on landing
  'cta_go_pro',                // "Go Pro" click
  'cta_pricing_free',          // free plan selected on pricing
  'cta_pricing_pro',           // pro plan selected on pricing

  // Feature activation signals
  'feature_first_task',        // user created their first task
  'feature_first_expense',     // user logged first expense
  'feature_connect_bank',      // Plaid connect initiated
  'feature_connect_gmail',     // Gmail connect initiated
  'feature_time_block',        // first time block created
  'feature_first_value',       // first value added
  'feature_first_idea',        // first idea submitted
  'feature_email_task',        // first email → task
  'feature_ai_suggestion',     // accepted an AI suggestion
  'feature_recurring_task',    // created first recurring task

  // Upgrade interactions
  'upgrade_prompt_seen',       // upgrade modal shown
  'upgrade_prompt_click',      // clicked upgrade in modal

  // Session
  'session_duration',          // fires on page unload with duration (seconds)

  // DAU / feature usage (fires when dashboard opens)
  'dau_active',                // user opened the dashboard today
  'feature_use_tasks',
  'feature_use_expenses',
  'feature_use_calendar',
  'feature_use_values',
  'feature_use_email',
  'feature_use_bank',
  'feature_use_ideas',
  'feature_use_recurring',
  'feature_use_ai_suggestions',

  // Landing-page demo funnel
  'demo_breakdown_used',         // no-account Break It Down demo ran

  // Add to Home Screen prompt (post-signup PWA install flow)
  'add_to_homescreen_shown',     // modal shown after signup
  'add_to_homescreen_completed', // user tapped "Done / I added it"
  'add_to_homescreen_skipped',   // user tapped "Maybe later"
]);

function sanitizeEventName(name) {
  if (!name || typeof name !== 'string') return null;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 100);
  return ALLOWED_EVENTS.has(slug) ? slug : null;
}

// ── Sanitize referrer (strip query params, limit length, no PII) ───────────
function sanitizeReferrer(ref) {
  if (!ref || typeof ref !== 'string') return null;
  try {
    const url = new URL(ref);
    // Keep only origin + pathname (strip query + hash to avoid PII in referrers)
    const clean = `${url.origin}${url.pathname}`.slice(0, 500);
    return clean;
  } catch {
    return null;
  }
}

// ── Sanitize UTM params ────────────────────────────────────────────────────
function sanitizeUtm(val) {
  if (!val || typeof val !== 'string') return null;
  return val.replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 100) || null;
}

// ── Detect device type from User-Agent ────────────────────────────────────
function detectDevice(ua) {
  if (!ua) return 'unknown';
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

// ── Admin gate helper (mirrors admin.js logic) ─────────────────────────────
function isAdminUser(user) {
  if (user.is_admin) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',')
    .map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((user.email || '').toLowerCase());
}

// =============================================================================
module.exports = function(pool) {

  // ── POST /api/analytics/visit ─────────────────────────────────────────────
  // Record a page view. Captures referrer, UTM params, device type.
  // Always returns 204 — fire-and-forget from client.
  router.post('/visit', async (req, res) => {
    res.status(204).end();

    try {
      const ua = req.headers['user-agent'] || '';
      if (isBot(ua)) return;

      const { visitor_id, page, referrer, utm_source, utm_medium, utm_campaign } = req.body || {};

      if (!isValidVisitorId(visitor_id)) return;

      const hash        = dailyHash(visitor_id);
      const cleanPage   = sanitizePage(page);
      const cleanRef    = sanitizeReferrer(referrer);
      const cleanSource = sanitizeUtm(utm_source);
      const cleanMedium = sanitizeUtm(utm_medium);
      const cleanCampaign = sanitizeUtm(utm_campaign);
      const device      = detectDevice(ua);

      await pool.query(
        `INSERT INTO visitor_sessions
           (visitor_hash, page, visited_at, referrer, utm_source, utm_medium, utm_campaign, device_type)
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)`,
        [hash, cleanPage, cleanRef, cleanSource, cleanMedium, cleanCampaign, device]
      );
    } catch (err) {
      console.error('[Analytics] Visit recording error:', err.message);
    }
  });

  // ── POST /api/analytics/event ─────────────────────────────────────────────
  // Record a named event. Optionally includes user_id for logged-in users.
  // Always returns 204.
  router.post('/event', async (req, res) => {
    res.status(204).end();

    try {
      const ua = req.headers['user-agent'] || '';
      if (isBot(ua)) return;

      const { visitor_id, event_name, event_data, user_id } = req.body || {};

      if (!isValidVisitorId(visitor_id)) return;

      const cleanEvent = sanitizeEventName(event_name);
      if (!cleanEvent) return;

      const hash = dailyHash(visitor_id);

      // Sanitize event_data: must be a plain object, max 1KB
      let safeData = {};
      if (event_data && typeof event_data === 'object' && !Array.isArray(event_data)) {
        const serialized = JSON.stringify(event_data);
        if (serialized.length <= 1024) {
          safeData = event_data;
        }
      }

      // user_id: only store if it's a valid integer
      const safeUserId = (user_id && Number.isInteger(Number(user_id)) && Number(user_id) > 0)
        ? Number(user_id) : null;

      await pool.query(
        `INSERT INTO analytics_events
           (visitor_hash, user_id, event_name, event_data, occurred_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [hash, safeUserId, cleanEvent, JSON.stringify(safeData)]
      );
    } catch (err) {
      console.error('[Analytics] Event recording error:', err.message);
    }
  });

  // ── GET /api/analytics/funnel ─────────────────────────────────────────────
  // Public endpoint — returns count at each funnel step + drop-off %
  // for the last 7 or 30 days. No auth required (funnel data is aggregate).
  router.get('/funnel', async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days) || 7, 30);
      const since = `NOW() - INTERVAL '${days} days'`;

      const funnelSteps = [
        { step: 'landing_visit',     event: 'funnel_landing_visit' },
        { step: 'demo_interact',     event: 'funnel_demo_interact' },
        { step: 'pricing_visit',     event: 'funnel_pricing_visit' },
        { step: 'signup_visit',      event: 'funnel_signup_visit' },
        { step: 'signup_started',    event: 'funnel_signup_start' },
        { step: 'signup_completed',  event: 'funnel_signup_complete' },
      ];

      const eventNames = funnelSteps.map(s => s.event);

      const result = await pool.query(`
        SELECT
          event_name,
          COUNT(DISTINCT visitor_hash)::int AS unique_visitors,
          COUNT(*)::int AS total_events,
          MIN(occurred_at)::text AS first_seen,
          MAX(occurred_at)::text AS last_seen
        FROM analytics_events
        WHERE event_name = ANY($1)
          AND occurred_at >= ${since}
        GROUP BY event_name
      `, [eventNames]);

      const countMap = {};
      result.rows.forEach(r => { countMap[r.event_name] = r; });

      const funnel = funnelSteps.map((s, i) => {
        const row = countMap[s.event] || {};
        const count = row.unique_visitors || 0;
        const prev = i === 0 ? null : (funnelSteps[i - 1] && (countMap[funnelSteps[i - 1].event] || {}).unique_visitors) || 0;
        const dropoffPct = (prev === 0 || prev === null)
          ? null
          : parseFloat((100 - (count / prev * 100)).toFixed(1));
        return {
          step: s.step,
          event: s.event,
          count,
          total_events: row.total_events || 0,
          dropoff_pct: dropoffPct,
          first_seen: row.first_seen || null,
          last_seen: row.last_seen || null,
        };
      });

      // Lead magnet events (separate slice)
      const leadMagnetResult = await pool.query(`
        SELECT event_name, COUNT(DISTINCT visitor_hash)::int AS unique_visitors
        FROM analytics_events
        WHERE event_name IN ('funnel_lead_magnet_click')
          AND occurred_at >= ${since}
        GROUP BY event_name
      `);

      // Device split for funnel visitors
      const deviceResult = await pool.query(`
        SELECT
          COALESCE(device_type, 'unknown') AS device,
          COUNT(DISTINCT vs.visitor_hash)::int AS visitors
        FROM visitor_sessions vs
        WHERE visited_at >= ${since}
          AND page = 'landing'
        GROUP BY device
        ORDER BY visitors DESC
      `);

      // Daily conversion trend (landing → signup_complete by day)
      const trendResult = await pool.query(`
        SELECT
          DATE(ae.occurred_at)::text AS day,
          COUNT(DISTINCT ae.visitor_hash)::int AS landing_visitors,
          COUNT(DISTINCT CASE WHEN ae.event_name = 'funnel_signup_complete'
            THEN ae.visitor_hash END)::int AS signups
        FROM analytics_events ae
        WHERE ae.occurred_at >= NOW() - INTERVAL '${days + 1} days'
        GROUP BY DATE(ae.occurred_at)
        ORDER BY day ASC
      `);

      res.json({
        success: true,
        period_days: days,
        funnel,
        lead_magnet_events: leadMagnetResult.rows,
        device_split: deviceResult.rows,
        daily_trend: trendResult.rows,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[Analytics] Funnel endpoint error:', err);
      res.status(500).json({ success: false, message: 'Failed to load funnel data' });
    }
  });

  // ── GET /api/analytics/summary ────────────────────────────────────────────
  // Admin-only aggregated analytics report.
  // Returns: funnel, top sources, device split, DAU, feature usage, top events.
  router.get('/summary', authenticateToken, async (req, res) => {
    try {
      // Admin gate
      const userRow = await pool.query(
        'SELECT is_admin, email FROM users WHERE id = $1',
        [req.user.id]
      );
      const user = userRow.rows[0] || {};
      if (!isAdminUser(user)) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const days = parseInt(req.query.days) || 30;
      const since = `NOW() - INTERVAL '${days} days'`;

      const [
        funnelResult,
        topSourcesResult,
        deviceSplitResult,
        dauResult,
        featureUsageResult,
        topEventsResult,
        pageviewsResult,
        signupIntentResult,
        sessionDurationResult,
        dailySignupsResult,
        utmBreakdownResult,
      ] = await Promise.all([

        // ── Signup funnel (event counts for each funnel step) ─────────────
        pool.query(`
          SELECT event_name, COUNT(DISTINCT visitor_hash)::int AS unique_visitors
          FROM analytics_events
          WHERE event_name IN (
            'funnel_landing_visit', 'funnel_pricing_visit',
            'funnel_signup_visit', 'funnel_signup_start', 'funnel_signup_complete'
          )
            AND occurred_at >= ${since}
          GROUP BY event_name
        `),

        // ── Top referrers ─────────────────────────────────────────────────
        pool.query(`
          SELECT
            COALESCE(referrer, '(direct)') AS source,
            COUNT(DISTINCT visitor_hash)::int AS visitors,
            COUNT(*)::int AS pageviews
          FROM visitor_sessions
          WHERE visited_at >= ${since}
            AND (referrer IS NULL OR (referrer NOT LIKE '%focusledger.net%' AND referrer NOT LIKE '%focusledger.net%'))
          GROUP BY source
          ORDER BY visitors DESC
          LIMIT 15
        `),

        // ── Device split ─────────────────────────────────────────────────
        pool.query(`
          SELECT
            COALESCE(device_type, 'unknown') AS device,
            COUNT(DISTINCT visitor_hash)::int AS visitors
          FROM visitor_sessions
          WHERE visited_at >= ${since}
          GROUP BY device
          ORDER BY visitors DESC
        `),

        // ── DAU — daily active users for past 30 days ─────────────────────
        pool.query(`
          SELECT
            DATE(occurred_at)::text AS day,
            COUNT(DISTINCT user_id)::int AS active_users
          FROM analytics_events
          WHERE event_name = 'dau_active'
            AND user_id IS NOT NULL
            AND occurred_at >= NOW() - INTERVAL '30 days'
          GROUP BY DATE(occurred_at)
          ORDER BY day ASC
        `),

        // ── Feature usage — unique users per feature (last N days) ────────
        pool.query(`
          SELECT
            event_name,
            COUNT(DISTINCT COALESCE(user_id::text, visitor_hash))::int AS unique_users,
            COUNT(*)::int AS total_events
          FROM analytics_events
          WHERE event_name LIKE 'feature_%'
            AND occurred_at >= ${since}
          GROUP BY event_name
          ORDER BY unique_users DESC
        `),

        // ── Top events overall ────────────────────────────────────────────
        pool.query(`
          SELECT
            event_name,
            COUNT(*)::int AS total_events,
            COUNT(DISTINCT visitor_hash)::int AS unique_visitors
          FROM analytics_events
          WHERE occurred_at >= ${since}
          GROUP BY event_name
          ORDER BY total_events DESC
          LIMIT 25
        `),

        // ── Pageviews by page ────────────────────────────────────────────
        pool.query(`
          SELECT
            page,
            COUNT(DISTINCT visitor_hash)::int AS unique_visitors,
            COUNT(*)::int AS pageviews
          FROM visitor_sessions
          WHERE visited_at >= ${since}
          GROUP BY page
          ORDER BY pageviews DESC
        `),

        // ── Signup intent (free vs pro) ───────────────────────────────────
        pool.query(`
          SELECT
            event_name,
            COUNT(*)::int AS total,
            COUNT(DISTINCT visitor_hash)::int AS unique_visitors
          FROM analytics_events
          WHERE event_name IN ('cta_signup_free', 'cta_go_pro', 'cta_pricing_free', 'cta_pricing_pro')
            AND occurred_at >= ${since}
          GROUP BY event_name
        `),

        // ── Median session duration ────────────────────────────────────────
        pool.query(`
          SELECT
            ROUND(AVG((event_data->>'duration')::numeric))::int AS avg_seconds,
            PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY (event_data->>'duration')::numeric
            )::int AS median_seconds,
            COUNT(*)::int AS session_count
          FROM analytics_events
          WHERE event_name = 'session_duration'
            AND occurred_at >= ${since}
            AND (event_data->>'duration')::numeric BETWEEN 5 AND 3600
        `),

        // ── Daily signups (last 30 days) for trend ────────────────────────
        pool.query(`
          SELECT
            DATE(created_at)::text AS day,
            COUNT(*)::int AS signups
          FROM users
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY DATE(created_at)
          ORDER BY day ASC
        `),

        // ── UTM breakdown ──────────────────────────────────────────────────
        pool.query(`
          SELECT
            COALESCE(utm_source, '(none)') AS utm_source,
            COALESCE(utm_medium, '(none)') AS utm_medium,
            COALESCE(utm_campaign, '(none)') AS utm_campaign,
            COUNT(DISTINCT visitor_hash)::int AS visitors,
            COUNT(*)::int AS pageviews
          FROM visitor_sessions
          WHERE visited_at >= ${since}
            AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
          GROUP BY utm_source, utm_medium, utm_campaign
          ORDER BY visitors DESC
          LIMIT 20
        `)
      ]);

      // ── Build funnel object ──────────────────────────────────────────────
      const funnelMap = {};
      funnelResult.rows.forEach(r => { funnelMap[r.event_name] = r.unique_visitors; });

      const funnelSteps = [
        { step: 'Landing visit',    event: 'funnel_landing_visit',   count: funnelMap['funnel_landing_visit'] || 0 },
        { step: 'Pricing visit',    event: 'funnel_pricing_visit',   count: funnelMap['funnel_pricing_visit'] || 0 },
        { step: 'Signup page visit',event: 'funnel_signup_visit',    count: funnelMap['funnel_signup_visit'] || 0 },
        { step: 'Signup started',   event: 'funnel_signup_start',    count: funnelMap['funnel_signup_start'] || 0 },
        { step: 'Signup completed', event: 'funnel_signup_complete', count: funnelMap['funnel_signup_complete'] || 0 },
      ];
      // Add drop-off rates
      funnelSteps.forEach((step, i) => {
        if (i === 0 || funnelSteps[i - 1].count === 0) {
          step.dropoff_pct = null;
        } else {
          step.dropoff_pct = parseFloat((100 - (step.count / funnelSteps[i - 1].count * 100)).toFixed(1));
        }
      });

      // ── Fill DAU gaps ────────────────────────────────────────────────────
      const dauMap = {};
      dauResult.rows.forEach(r => { dauMap[r.day] = r.active_users; });
      const dauTrend = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        dauTrend.push({ day: dayStr, active_users: dauMap[dayStr] || 0 });
      }

      // ── Fill signup gaps ─────────────────────────────────────────────────
      const signupMap = {};
      dailySignupsResult.rows.forEach(r => { signupMap[r.day] = r.signups; });
      const signupTrend = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        signupTrend.push({ day: dayStr, signups: signupMap[dayStr] || 0 });
      }

      res.json({
        success: true,
        period_days: days,
        funnel: funnelSteps,
        top_sources: topSourcesResult.rows,
        device_split: deviceSplitResult.rows,
        dau_trend: dauTrend,
        feature_usage: featureUsageResult.rows,
        top_events: topEventsResult.rows,
        pageviews_by_page: pageviewsResult.rows,
        signup_intent: signupIntentResult.rows,
        session_duration: sessionDurationResult.rows[0] || { avg_seconds: null, median_seconds: null, session_count: 0 },
        signup_trend: signupTrend,
        utm_breakdown: utmBreakdownResult.rows,
        generatedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[Analytics] Summary error:', err);
      res.status(500).json({ success: false, message: 'Failed to load analytics' });
    }
  });

  return router;
};
