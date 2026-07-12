const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { queryWithRetry } = require('../lib/queryWithRetry');
const { sendEmail } = require('../lib/emailService');
const { v2LaunchTemplate } = require('../lib/emailTemplates');

// ============================================
// Admin Access Control
// ============================================
// Dual-layer gating protects all /api/admin/* routes:
//
// Layer 1 — DB flag: users.is_admin (boolean, default false).
//           Set via PATCH /api/admin/users/:id/role by an existing admin.
//
// Layer 2 — Env var: ADMIN_EMAILS (comma-separated, case-insensitive).
//           Parsed at startup; requires service restart after changes.
//
// A user is considered admin if EITHER layer matches.
// All admin endpoints verify the requesting user through authenticateToken
// (JWT) first, then check isAdminUser(). Non-admins receive 403.
//
// The /admin/stats HTML page is served to anyone (static file), but all
// API data endpoints return 403 for non-admins, rendering the page empty.
// ============================================

function isAdminUser(user) {
  if (user.is_admin) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((user.email || '').toLowerCase());
}

module.exports = function(pool) {

  // Shorthand: resilient query with retry + timeout for Neon wake cycles
  const q = (sql, params) => queryWithRetry(pool, sql, params);

  // Shared admin gate for new routes (older routes inline the same check)
  async function requireAdmin(req, res) {
    const row = await q('SELECT is_admin, email FROM users WHERE id = $1', [req.user.id]);
    const user = row.rows[0] || {};
    if (!isAdminUser({ ...user, id: req.user.id })) {
      res.status(403).json({ success: false, message: 'Admin access required' });
      return null;
    }
    return { id: req.user.id, email: user.email };
  }

  // GET /api/admin/stats — aggregate user + subscription metrics
  router.get('/stats', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      // Admin gate
      const userRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [userId]);
      const user = userRow.rows[0] || {};
      const adminCheck = isAdminUser({ ...user, id: userId });
      console.log('[Admin] Gate check:', {
        userId,
        isAdminFlag: user.is_admin,
        result: adminCheck
        // Note: ADMIN_EMAILS env var intentionally omitted from logs
      });
      if (!adminCheck) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Run all metric queries in parallel
      const [
        totalUsersResult,
        proMonthlyResult,
        proAnnualResult,
        newThisWeekResult,
        newThisMonthResult,
        churnThisMonthResult,
        visitorsTodayResult,
        visitors7dResult,
        visitors30dResult
      ] = await Promise.all([
        // Total registered users
        q('SELECT COUNT(*)::int AS count FROM users'),

        // Active Pro subscribers — monthly
        q(`
          SELECT COUNT(*)::int AS count
          FROM app_subscription
          WHERE plan = 'pro'
            AND status = 'active'
            AND billing_cycle = 'monthly'
        `),

        // Active Pro subscribers — annual
        q(`
          SELECT COUNT(*)::int AS count
          FROM app_subscription
          WHERE plan = 'pro'
            AND status = 'active'
            AND billing_cycle = 'annual'
        `),

        // New signups this week (last 7 days)
        q(`
          SELECT COUNT(*)::int AS count
          FROM users
          WHERE created_at >= NOW() - INTERVAL '7 days'
        `),

        // New signups this month (calendar month)
        q(`
          SELECT COUNT(*)::int AS count
          FROM users
          WHERE created_at >= date_trunc('month', NOW())
        `),

        // Cancelled subscriptions this month
        q(`
          SELECT COUNT(*)::int AS count
          FROM app_subscription
          WHERE status IN ('canceled', 'cancelled')
            AND cancelled_at >= date_trunc('month', NOW())
        `),

        // Visitors today — ENGAGED vs raw.
        // Production data showed ~95% of raw "visitors" are one-shot crawlers
        // with clean browser UAs (1 page, 1 view, no events, never return).
        // Engaged = ≥2 pageviews that day OR produced any analytics event —
        // a bar automated sweeps essentially never clear.
        q(`
          SELECT
            COUNT(*) FILTER (WHERE engaged)::int  AS engaged,
            COUNT(*)::int                          AS raw
          FROM (
            SELECT vs.visitor_hash,
                   (COUNT(*) >= 2 OR EXISTS (
                      SELECT 1 FROM analytics_events ae
                      WHERE ae.visitor_hash = vs.visitor_hash
                        AND DATE(ae.occurred_at) = CURRENT_DATE
                   )) AS engaged
            FROM visitor_sessions vs
            WHERE DATE(vs.visited_at) = CURRENT_DATE
            GROUP BY vs.visitor_hash
          ) x
        `),

        // Last 7 days: daily engaged + raw visitors + pageviews (sparkline)
        q(`
          SELECT
            day,
            COUNT(*) FILTER (WHERE engaged)::int AS unique_visitors,
            COUNT(*)::int                        AS raw_visitors,
            SUM(views)::int                      AS total_pageviews
          FROM (
            SELECT DATE(vs.visited_at)::text AS day,
                   vs.visitor_hash,
                   COUNT(*) AS views,
                   (COUNT(*) >= 2 OR EXISTS (
                      SELECT 1 FROM analytics_events ae
                      WHERE ae.visitor_hash = vs.visitor_hash
                        AND DATE(ae.occurred_at) = DATE(vs.visited_at)
                   )) AS engaged
            FROM visitor_sessions vs
            WHERE vs.visited_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(vs.visited_at), vs.visitor_hash
          ) x
          GROUP BY day
          ORDER BY day ASC
        `),

        // Last 30 days: engaged visit-days + raw. NOTE: visitor hashes are
        // daily-salted (privacy), so cross-day dedup is impossible — this is
        // a sum of daily uniques ("visit-days"), not distinct people, and the
        // UI labels it accordingly.
        q(`
          SELECT
            COUNT(*) FILTER (WHERE engaged)::int AS engaged,
            COUNT(*)::int                        AS raw
          FROM (
            SELECT DATE(vs.visited_at) AS day,
                   vs.visitor_hash,
                   (COUNT(*) >= 2 OR EXISTS (
                      SELECT 1 FROM analytics_events ae
                      WHERE ae.visitor_hash = vs.visitor_hash
                        AND DATE(ae.occurred_at) = DATE(vs.visited_at)
                   )) AS engaged
            FROM visitor_sessions vs
            WHERE vs.visited_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(vs.visited_at), vs.visitor_hash
          ) x
        `)
      ]);

      const totalUsers    = totalUsersResult.rows[0]?.count ?? 0;
      const proMonthly    = proMonthlyResult.rows[0]?.count ?? 0;
      const proAnnual     = proAnnualResult.rows[0]?.count ?? 0;
      const proTotal      = proMonthly + proAnnual;
      const freeUsers     = Math.max(0, totalUsers - proTotal);
      const conversionPct = totalUsers > 0 ? ((proTotal / totalUsers) * 100).toFixed(1) : '0.0';
      const newThisWeek   = newThisWeekResult.rows[0]?.count ?? 0;
      const newThisMonth  = newThisMonthResult.rows[0]?.count ?? 0;
      const churnCount    = churnThisMonthResult.rows[0]?.count ?? 0;

      // MRR: monthly subscribers x $9.99 + annual subscribers x $8.33/mo
      const MONTHLY_PRICE = 9.99;
      const ANNUAL_MONTHLY_PRICE = 8.33; // $100/yr / 12
      const mrr = (proMonthly * MONTHLY_PRICE) + (proAnnual * ANNUAL_MONTHLY_PRICE);

      // Visitor stats — engaged is the headline; raw kept for the bot-share line
      const visitorsToday    = visitorsTodayResult.rows[0]?.engaged ?? 0;
      const visitorsTodayRaw = visitorsTodayResult.rows[0]?.raw ?? 0;
      const visitors7dTotal  = visitors7dResult.rows.reduce((sum, r) => sum + (r.unique_visitors || 0), 0);
      const visitors30d      = visitors30dResult.rows[0]?.engaged ?? 0;
      const visitors30dRaw   = visitors30dResult.rows[0]?.raw ?? 0;

      // Build 7-day trend array (fill gaps with 0 for missing days)
      const trend7d = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        const found = visitors7dResult.rows.find(r => r.day === dayStr);
        trend7d.push({
          day: dayStr,
          unique_visitors: found ? found.unique_visitors : 0,
          raw_visitors: found ? found.raw_visitors : 0,
          total_pageviews: found ? found.total_pageviews : 0
        });
      }

      res.json({
        success: true,
        stats: {
          totalUsers,
          proTotal,
          proMonthly,
          proAnnual,
          freeUsers,
          conversionPct: parseFloat(conversionPct),
          newThisWeek,
          newThisMonth,
          churnCount,
          mrr: parseFloat(mrr.toFixed(2)),
          visitorsToday,
          visitorsTodayRaw,
          visitors7dTotal,
          visitors30d,
          visitors30dRaw,
          trend7d
        },
        generatedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[Admin] Error fetching stats:', err);
      res.status(500).json({ success: false, message: 'Failed to load stats' });
    }
  });

  // GET /api/admin/users — list all users with subscription, admin, task, and login data
  router.get('/users', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      // Admin gate (same as stats)
      const userRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [userId]);
      const user = userRow.rows[0] || {};
      if (!isAdminUser({ ...user, id: userId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const result = await q(`
        SELECT
          u.id,
          u.email,
          u.created_at,
          u.is_admin,
          u.admin_pro_override,
          u.pro_granted_by,
          u.pro_granted_until,
          u.utm_source,
          u.signup_referrer,
          COALESCE(u.is_qa_user, false) AS is_qa_user,
          COALESCE(u.login_count, 0)::int AS login_count,
          u.last_login_at,
          COALESCE(u.timezone, 'America/New_York') AS timezone,
          s.plan,
          s.status,
          s.billing_cycle,
          s.current_period_end,
          s.activated_at,
          s.cancelled_at,
          COALESCE(t.active_task_count, 0)::int AS active_task_count
        FROM users u
        LEFT JOIN LATERAL (
          SELECT plan, status, billing_cycle, current_period_end, activated_at, cancelled_at
          FROM app_subscription
          WHERE user_id = u.id
          ORDER BY id DESC
          LIMIT 1
        ) s ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS active_task_count
          FROM tasks
          WHERE user_id = u.id
            AND is_completed = false
        ) t ON true
        ORDER BY u.created_at DESC
      `);

      // Plan taxonomy (ported from the retired Subscriptions tab so the merged
      // Users table carries the full revenue picture)
      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const users = result.rows.map(row => {
        const adminActive = row.admin_pro_override &&
          (!row.pro_granted_until || new Date(row.pro_granted_until) > now);
        const stripePro = row.plan === 'pro' && row.status === 'active';

        let planLabel;
        if (stripePro) planLabel = 'pro_active';
        else if (adminActive) planLabel = 'pro_trial';
        else if (row.admin_pro_override && row.pro_granted_until && new Date(row.pro_granted_until) <= now) planLabel = 'trial_expired';
        else if (row.status === 'cancelled' || row.status === 'canceled') planLabel = 'cancelled';
        else if (row.status === 'past_due') planLabel = 'past_due';
        else planLabel = 'free';

        let trialExpiryUrgency = null;
        if (planLabel === 'pro_trial' && row.pro_granted_until) {
          if (new Date(row.pro_granted_until) <= sevenDaysFromNow) trialExpiryUrgency = 'soon';
        } else if (planLabel === 'trial_expired') {
          trialExpiryUrgency = 'expired';
        }

        let signupSource = 'direct';
        if (row.utm_source) signupSource = row.utm_source;
        else if (row.signup_referrer) {
          try { signupSource = new URL(row.signup_referrer).hostname.replace(/^www\./, '') || 'direct'; }
          catch { signupSource = 'direct'; }
        }

        return {
          id: row.id,
          email: row.email,
          created_at: row.created_at,
          is_admin: !!row.is_admin,
          admin_pro_override: !!row.admin_pro_override,
          is_qa_user: !!row.is_qa_user,
          login_count: row.login_count,
          last_login_at: row.last_login_at || null,
          active_task_count: row.active_task_count,
          timezone: row.timezone,
          has_stripe_sub: stripePro,
          stripe_plan: row.plan || 'free',
          stripe_status: row.status || 'none',
          stripe_billing_cycle: row.billing_cycle || null,
          stripe_period_end: row.current_period_end || null,
          stripe_activated_at: row.activated_at || null,
          is_pro: stripePro || !!row.admin_pro_override,
          pro_source: row.admin_pro_override ? 'admin' : (stripePro ? 'stripe' : 'none'),
          plan_label: planLabel,
          trial_expiry_urgency: trialExpiryUrgency,
          pro_granted_until: row.pro_granted_until || null,
          signup_source: signupSource,
        };
      });

      res.json({ success: true, users, currentUserId: userId });
    } catch (err) {
      console.error('[Admin] Error fetching users:', err);
      res.status(500).json({ success: false, message: 'Failed to load users' });
    }
  });

  // PATCH /api/admin/users/:id/pro — grant or revoke admin Pro override
  router.patch('/users/:id/pro', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;
      const { id } = req.params;
      const { grant } = req.body; // true = grant Pro, false = revoke

      if (typeof grant !== 'boolean') {
        return res.status(400).json({ success: false, message: '"grant" must be a boolean' });
      }

      // Admin gate
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [adminId]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: adminId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Prevent admin from modifying themselves
      if (parseInt(id) === adminId) {
        return res.status(400).json({ success: false, message: 'Cannot modify your own admin Pro access' });
      }

      // Verify target user exists
      const targetRow = await q('SELECT id, email, admin_pro_override FROM users WHERE id = $1', [id]);
      if (targetRow.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      await q(
        'UPDATE users SET admin_pro_override = $1 WHERE id = $2',
        [grant, id]
      );

      const newOverride = grant;
      const target = targetRow.rows[0];

      console.log(`[Admin] Pro override ${grant ? 'granted' : 'revoked'} for user ${target.email} (id=${id}) by admin ${admin.email}`);

      res.json({
        success: true,
        user_id: parseInt(id),
        email: target.email,
        admin_pro_override: newOverride,
        message: grant
          ? `Autopilot access granted to ${target.email}. All Autopilot features are now unlocked.`
          : `Autopilot access revoked for ${target.email}. Stripe subscription still active if applicable.`
      });
    } catch (err) {
      console.error('[Admin] Error toggling user Pro:', err);
      res.status(500).json({ success: false, message: 'Failed to update user Pro access' });
    }
  });

  // GET /api/admin/users/:id/detail — tasks and expenses for a specific user
  router.get('/users/:id/detail', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;
      const { id } = req.params;

      // Admin gate
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [adminId]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: adminId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Verify target user exists
      const userRow = await q('SELECT id, email, created_at, COALESCE(timezone, $1) AS timezone FROM users WHERE id = $2', ['America/New_York', id]);
      if (userRow.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      const targetUser = userRow.rows[0];

      // Fetch tasks and expenses in parallel
      const [tasksResult, expensesResult] = await Promise.all([
        q(`
          SELECT id, title, is_completed, priority, due_date, created_at, completed_at
          FROM tasks
          WHERE user_id = $1
          ORDER BY created_at DESC
        `, [id]),
        q(`
          SELECT e.id, e.amount, e.description, e.expense_date, e.created_at,
                 c.name AS category_name
          FROM expenses e
          LEFT JOIN categories c ON e.category_id = c.id
          WHERE e.user_id = $1
          ORDER BY e.expense_date DESC, e.created_at DESC
        `, [id])
      ]);

      const tasks = tasksResult.rows;
      const expenses = expensesResult.rows;

      const totalTasks = tasks.length;
      const completedTasks = tasks.filter(t => t.is_completed).length;
      const activeTasks = totalTasks - completedTasks;

      const totalExpenses = expenses.length;
      const totalAmount = expenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);

      res.json({
        success: true,
        user: targetUser,
        tasks,
        expenses,
        summary: {
          tasks: { total: totalTasks, completed: completedTasks, active: activeTasks },
          expenses: { total: totalExpenses, totalAmount: parseFloat(totalAmount.toFixed(2)) }
        }
      });
    } catch (err) {
      console.error('[Admin] Error fetching user detail:', err);
      res.status(500).json({ success: false, message: 'Failed to load user detail' });
    }
  });

  // POST /api/admin/query — run a read-only SELECT query
  router.post('/query', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;

      // Admin gate
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [adminId]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: adminId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const { sql: rawSql } = req.body;
      if (!rawSql || typeof rawSql !== 'string') {
        return res.status(400).json({ success: false, message: 'SQL query is required' });
      }

      // Normalize and validate — SELECT only
      const normalized = rawSql.trim().replace(/\s+/g, ' ');
      const upper = normalized.toUpperCase();

      // Block dangerous statements
      const blocked = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'EXECUTE', 'EXEC', 'CALL', '--', '/*'];
      for (const keyword of blocked) {
        const re = new RegExp('(^|\\s|;)' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|;|$)', 'i');
        if (re.test(rawSql) || rawSql.includes('--') || rawSql.includes('/*')) {
          return res.status(400).json({
            success: false,
            message: `Blocked: query contains "${keyword}". Only SELECT statements are allowed.`
          });
        }
      }

      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        return res.status(400).json({
          success: false,
          message: 'Only SELECT (or WITH ... SELECT) queries are allowed.'
        });
      }

      // Enforce timeout via statement_timeout
      const client = await pool.connect();
      let result;
      try {
        await client.query('SET statement_timeout = 10000'); // 10 seconds
        result = await client.query(normalized);
      } finally {
        client.release();
      }

      const rows = result.rows;
      const columns = result.fields ? result.fields.map(f => f.name) : (rows.length > 0 ? Object.keys(rows[0]) : []);

      console.log(`[Admin] Data Explorer query by ${admin.email}: ${normalized.slice(0, 120)}`);

      res.json({
        success: true,
        columns,
        rows,
        rowCount: rows.length
      });
    } catch (err) {
      console.error('[Admin] Data Explorer query error:', err);
      // Return a clean error message (no stack traces)
      const message = err.message || 'Query failed';
      res.status(400).json({ success: false, message });
    }
  });

  // PATCH /api/admin/users/:id/role — grant or revoke admin access
  router.patch('/users/:id/role', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;
      const { id } = req.params;
      const { is_admin: grantAdmin } = req.body; // true = grant admin, false = revoke

      if (typeof grantAdmin !== 'boolean') {
        return res.status(400).json({ success: false, message: '"is_admin" must be a boolean' });
      }

      // Admin gate
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [adminId]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: adminId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Prevent admin from revoking their own admin access (lockout protection)
      if (parseInt(id) === adminId && !grantAdmin) {
        return res.status(400).json({ success: false, message: 'Cannot revoke your own admin access' });
      }

      // Verify target user exists
      const targetRow = await q('SELECT id, email, is_admin FROM users WHERE id = $1', [id]);
      if (targetRow.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const target = targetRow.rows[0];

      await q(
        'UPDATE users SET is_admin = $1 WHERE id = $2',
        [grantAdmin, id]
      );

      console.log(`[Admin] Admin access ${grantAdmin ? 'granted to' : 'revoked from'} ${target.email} (id=${id}) by admin ${admin.email}`);

      res.json({
        success: true,
        user_id: parseInt(id),
        email: target.email,
        is_admin: grantAdmin,
        message: grantAdmin
          ? `Admin access granted to ${target.email}.`
          : `Admin access revoked for ${target.email}.`
      });
    } catch (err) {
      console.error('[Admin] Error toggling admin role:', err);
      res.status(500).json({ success: false, message: 'Failed to update admin access' });
    }
  });

  // POST /api/admin/send-v2-launch — one-shot v2 launch email to all real (non-QA) users.
  // Idempotent: skips users who already have a 'v2_launch' entry in email_log.
  // Admin-gated, async sequential with 300ms delay between sends to respect Resend limits.
  router.post('/send-v2-launch', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;

      // Admin gate
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [adminId]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: adminId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Fetch all non-QA users who haven't received the v2 launch email yet
      const usersResult = await q(`
        SELECT u.id, u.email, u.name
        FROM users u
        WHERE COALESCE(u.is_qa_user, false) = false
          AND NOT EXISTS (
            SELECT 1 FROM email_log el
            WHERE el.user_id = u.id AND el.template_type = 'v2_launch'
          )
        ORDER BY u.created_at
      `);

      const users = usersResult.rows;

      // Respond immediately — fire sends in background to avoid gateway timeout
      res.json({
        success: true,
        queued: users.length,
        message: `Sending v2 launch email to ${users.length} user(s). Check server logs for status.`
      });

      // Send sequentially with a small delay to be Resend-friendly
      (async () => {
        let sent = 0;
        let failed = 0;
        for (const user of users) {
          const { subject, html } = v2LaunchTemplate({ name: user.name });
          const result = await sendEmail(pool, {
            to: user.email,
            subject,
            html,
            templateType: 'v2_launch',
            userId: user.id
          });
          if (result.success) {
            sent++;
            console.log(`[Admin] v2 launch email sent to ${user.email} (id=${user.id})`);
          } else {
            failed++;
            console.error(`[Admin] v2 launch email FAILED for ${user.email} (id=${user.id})`);
          }
          // 300ms between sends
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        console.log(`[Admin] v2 launch campaign complete: ${sent} sent, ${failed} failed`);
      })().catch(err => console.error('[Admin] v2 launch campaign error:', err.message));

    } catch (err) {
      console.error('[Admin] Error initiating v2 launch send:', err);
      res.status(500).json({ success: false, message: 'Failed to initiate v2 launch email campaign' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Email Campaigns — self-service draft/test/send (admin.html Campaigns tab)
  // Dedup: email_log.template_type = 'campaign_<id>' — a re-send can never
  // double-deliver to the same user.
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/admin/campaigns — list, newest first
  router.get('/campaigns', authenticateToken, async (req, res) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const { rows } = await q(
        `SELECT id, subject, body, audience, status, recipient_count,
                sent_count, failed_count, created_at, sent_at
         FROM email_campaigns ORDER BY id DESC LIMIT 50`
      );
      res.json({ success: true, campaigns: rows });
    } catch (err) {
      console.error('[Admin] campaigns list error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to list campaigns' });
    }
  });

  // POST /api/admin/campaigns — create or update a draft
  router.post('/campaigns', authenticateToken, async (req, res) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { id, subject, body, audience } = req.body || {};
      if (!subject || !body) {
        return res.status(400).json({ success: false, message: 'subject and body are required' });
      }
      const { AUDIENCES } = require('../lib/campaignEmail');
      const aud = AUDIENCES[audience] !== undefined ? audience : 'all';

      let row;
      if (id) {
        const { rows } = await q(
          `UPDATE email_campaigns
           SET subject = $1, body = $2, audience = $3, updated_at = NOW()
           WHERE id = $4 AND status = 'draft' RETURNING *`,
          [subject, body, aud, parseInt(id, 10)]
        );
        if (!rows.length) return res.status(409).json({ success: false, message: 'Campaign not found or already sent' });
        row = rows[0];
      } else {
        const { rows } = await q(
          `INSERT INTO email_campaigns (subject, body, audience, created_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [subject, body, aud, admin.id]
        );
        row = rows[0];
      }
      res.json({ success: true, campaign: row });
    } catch (err) {
      console.error('[Admin] campaign save error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save campaign' });
    }
  });

  // POST /api/admin/campaigns/:id/test — send the draft to the ADMIN only
  router.post('/campaigns/:id/test', authenticateToken, async (req, res) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { rows } = await q('SELECT * FROM email_campaigns WHERE id = $1', [parseInt(req.params.id, 10)]);
      if (!rows.length) return res.status(404).json({ success: false, message: 'Campaign not found' });
      const c = rows[0];

      const { renderCampaign } = require('../lib/campaignEmail');
      const nameRow = await q('SELECT name FROM users WHERE id = $1', [admin.id]);
      const { subject, html, text } = renderCampaign({
        firstName: nameRow.rows[0]?.name, subject: `[TEST] ${c.subject}`, body: c.body,
      });
      const result = await sendEmail(pool, {
        to: admin.email, subject, html, text,
        templateType: `campaign_${c.id}_test`, userId: admin.id,
      });
      if (!result.success) return res.status(502).json({ success: false, message: `Send failed: ${result.error}` });
      res.json({ success: true, message: `Test sent to ${admin.email}` });
    } catch (err) {
      console.error('[Admin] campaign test error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to send test' });
    }
  });

  // GET /api/admin/campaigns/:id/recipients — count who WOULD receive it
  router.get('/campaigns/:id/recipients', authenticateToken, async (req, res) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const cid = parseInt(req.params.id, 10);
      const { rows } = await q('SELECT audience FROM email_campaigns WHERE id = $1', [cid]);
      if (!rows.length) return res.status(404).json({ success: false, message: 'Campaign not found' });
      const { AUDIENCES } = require('../lib/campaignEmail');
      const audienceSql = AUDIENCES[rows[0].audience] || '';
      const { rows: cnt } = await q(
        `SELECT COUNT(*)::int AS n FROM users u
         WHERE COALESCE(u.is_qa_user, false) = false
           AND u.email IS NOT NULL AND u.email <> ''
           ${audienceSql}
           AND NOT EXISTS (
             SELECT 1 FROM email_log el
             WHERE el.user_id = u.id AND el.template_type = $1 AND el.success = true
           )
           AND NOT EXISTS (
             SELECT 1 FROM email_suppression es WHERE LOWER(es.email) = LOWER(u.email)
           )`,
        [`campaign_${cid}`]
      );
      res.json({ success: true, count: cnt[0].n });
    } catch (err) {
      console.error('[Admin] campaign recipients error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to count recipients' });
    }
  });

  // POST /api/admin/campaigns/:id/send — fire the campaign (background, throttled)
  router.post('/campaigns/:id/send', authenticateToken, async (req, res) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const cid = parseInt(req.params.id, 10);
      const { rows } = await q('SELECT * FROM email_campaigns WHERE id = $1', [cid]);
      if (!rows.length) return res.status(404).json({ success: false, message: 'Campaign not found' });
      const c = rows[0];
      if (c.status === 'sending') return res.status(409).json({ success: false, message: 'Already sending' });

      const { renderCampaign, AUDIENCES } = require('../lib/campaignEmail');
      const audienceSql = AUDIENCES[c.audience] || '';
      const { rows: recipients } = await q(
        `SELECT u.id, u.email, u.name FROM users u
         WHERE COALESCE(u.is_qa_user, false) = false
           AND u.email IS NOT NULL AND u.email <> ''
           ${audienceSql}
           AND NOT EXISTS (
             SELECT 1 FROM email_log el
             WHERE el.user_id = u.id AND el.template_type = $1 AND el.success = true
           )
           AND NOT EXISTS (
             SELECT 1 FROM email_suppression es WHERE LOWER(es.email) = LOWER(u.email)
           )
         ORDER BY u.id`,
        [`campaign_${cid}`]
      );

      await q(
        `UPDATE email_campaigns SET status = 'sending', recipient_count = $1, updated_at = NOW() WHERE id = $2`,
        [recipients.length, cid]
      );
      res.json({ success: true, queued: recipients.length, message: `Sending to ${recipients.length} user(s)` });

      // Background send — same pattern as send-v2-launch, Resend-friendly throttle
      (async () => {
        let sent = 0, failed = 0;
        for (const user of recipients) {
          const { subject, html, text } = renderCampaign({ firstName: user.name, subject: c.subject, body: c.body });
          const result = await sendEmail(pool, {
            to: user.email, subject, html, text,
            templateType: `campaign_${cid}`, userId: user.id,
          });
          if (result.success) sent++; else failed++;
          await new Promise(r => setTimeout(r, 600));
        }
        await q(
          `UPDATE email_campaigns
           SET status = 'sent', sent_count = sent_count + $1, failed_count = failed_count + $2,
               sent_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [sent, failed, cid]
        ).catch(e => console.error('[Admin] campaign finalize failed:', e.message));
        console.log(`[Admin] campaign ${cid} complete: ${sent} sent, ${failed} failed`);
      })().catch(err => console.error(`[Admin] campaign ${cid} error:`, err.message));
    } catch (err) {
      console.error('[Admin] campaign send error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to send campaign' });
    }
  });

  // GET /api/admin/subscriptions — all users with subscription data for Subscriptions tab
  // Read-only. Pulls from users + app_subscription; no Stripe API calls.
  router.get('/subscriptions', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;

      // Admin gate
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [adminId]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: adminId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const result = await q(`
        SELECT
          u.id,
          u.email,
          u.created_at AS joined_at,
          u.admin_pro_override,
          u.pro_granted_by,
          u.pro_granted_until,
          u.utm_source,
          u.signup_referrer,
          COALESCE(u.timezone, 'America/New_York') AS timezone,
          s.plan,
          s.status AS sub_status,
          s.billing_cycle,
          s.stripe_subscription_id,
          s.stripe_customer_id,
          s.current_period_end,
          s.activated_at,
          s.cancelled_at
        FROM users u
        LEFT JOIN LATERAL (
          SELECT plan, status, billing_cycle, stripe_subscription_id, stripe_customer_id,
                 current_period_end, activated_at, cancelled_at
          FROM app_subscription
          WHERE user_id = u.id
          ORDER BY id DESC
          LIMIT 1
        ) s ON true
        ORDER BY u.created_at DESC
      `);

      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const rows = result.rows.map(row => {
        // Determine effective Pro status and plan label
        const adminActive = row.admin_pro_override &&
          (!row.pro_granted_until || new Date(row.pro_granted_until) > now);
        const stripePro = row.plan === 'pro' && row.sub_status === 'active';

        let planLabel;
        if (stripePro) {
          planLabel = 'pro_active';
        } else if (adminActive) {
          planLabel = 'pro_trial';
        } else if (row.admin_pro_override && row.pro_granted_until && new Date(row.pro_granted_until) <= now) {
          planLabel = 'trial_expired';
        } else if (row.sub_status === 'cancelled' || row.sub_status === 'canceled') {
          planLabel = 'cancelled';
        } else if (row.sub_status === 'past_due') {
          planLabel = 'past_due';
        } else {
          planLabel = 'free';
        }

        // Trial expiry urgency
        let trialExpiryUrgency = null;
        if (planLabel === 'pro_trial' && row.pro_granted_until) {
          const expiry = new Date(row.pro_granted_until);
          if (expiry <= sevenDaysFromNow) trialExpiryUrgency = 'soon'; // ≤7 days
        } else if (planLabel === 'trial_expired') {
          trialExpiryUrgency = 'expired';
        }

        // Signup source: UTM source takes precedence; fall back to referrer domain; then "direct"
        let signupSource = null;
        if (row.utm_source) {
          signupSource = row.utm_source;
        } else if (row.signup_referrer) {
          try {
            const refDomain = new URL(row.signup_referrer).hostname.replace(/^www\./, '');
            signupSource = refDomain || 'direct';
          } catch {
            signupSource = 'direct';
          }
        } else {
          signupSource = 'direct';
        }

        return {
          id: row.id,
          email: row.email,
          joined_at: row.joined_at,
          timezone: row.timezone,
          plan_label: planLabel,
          source: row.pro_granted_by || (stripePro ? 'stripe' : null),
          signup_source: signupSource,
          billing_cycle: row.billing_cycle || null,
          stripe_subscription_id: row.stripe_subscription_id || null,
          stripe_customer_id: row.stripe_customer_id || null,
          current_period_end: row.current_period_end || null,
          activated_at: row.activated_at || null,
          cancelled_at: row.cancelled_at || null,
          pro_granted_until: row.pro_granted_until || null,
          trial_expiry_urgency: trialExpiryUrgency
        };
      });

      res.json({ success: true, subscriptions: rows });
    } catch (err) {
      console.error('[Admin] Error fetching subscriptions:', err);
      res.status(500).json({ success: false, message: 'Failed to load subscriptions' });
    }
  });

  // PATCH /api/admin/users/:id/qa — mark or unmark user as QA/test account
  // QA-flagged users are excluded from all automated retention emails.
  router.patch('/users/:id/qa', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;
      const { id } = req.params;
      const { is_qa } = req.body; // true = mark as QA, false = unmark

      if (typeof is_qa !== 'boolean') {
        return res.status(400).json({ success: false, message: '"is_qa" must be a boolean' });
      }

      // Admin gate
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [adminId]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: adminId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Verify target user exists
      const targetRow = await q('SELECT id, email, is_qa_user FROM users WHERE id = $1', [id]);
      if (targetRow.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const target = targetRow.rows[0];

      await q(
        'UPDATE users SET is_qa_user = $1 WHERE id = $2',
        [is_qa, id]
      );

      console.log(`[Admin] QA flag ${is_qa ? 'set on' : 'cleared from'} user ${target.email} (id=${id}) by admin ${admin.email}`);

      res.json({
        success: true,
        user_id: parseInt(id),
        email: target.email,
        is_qa_user: is_qa,
        message: is_qa
          ? `${target.email} flagged as QA/test. Excluded from all automated emails.`
          : `${target.email} QA flag removed. Normal email delivery restored.`
      });
    } catch (err) {
      console.error('[Admin] Error toggling QA flag:', err);
      res.status(500).json({ success: false, message: 'Failed to update QA flag' });
    }
  });

  // POST /api/admin/stripe-rename-product — one-shot: rename Stripe products from Pro → Autopilot
  // Admin-only. Uses STRIPE_SECRET_KEY from env. Safe to call multiple times (idempotent label update).
  router.post('/stripe-rename-product', authenticateToken, async (req, res) => {
    try {
      const adminRow = await q('SELECT is_admin, email FROM users WHERE id = $1', [req.user.id]);
      const admin = adminRow.rows[0] || {};
      if (!isAdminUser({ ...admin, id: req.user.id })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        return res.status(500).json({ success: false, message: 'STRIPE_SECRET_KEY not configured' });
      }

      const https = require('https');
      const querystring = require('querystring');

      function stripePost(path, body) {
        return new Promise((resolve, reject) => {
          const data = querystring.stringify(body);
          const opts = {
            hostname: 'api.stripe.com',
            path,
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + stripeKey,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(data)
            }
          };
          const req2 = https.request(opts, (r) => {
            let body2 = '';
            r.on('data', d => { body2 += d; });
            r.on('end', () => { try { resolve(JSON.parse(body2)); } catch(e) { reject(e); } });
          });
          req2.on('error', reject);
          req2.write(data);
          req2.end();
        });
      }

      function stripeGet(path) {
        return new Promise((resolve, reject) => {
          const opts = {
            hostname: 'api.stripe.com',
            path,
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + stripeKey }
          };
          const req2 = https.request(opts, (r) => {
            let body2 = '';
            r.on('data', d => { body2 += d; });
            r.on('end', () => { try { resolve(JSON.parse(body2)); } catch(e) { reject(e); } });
          });
          req2.on('error', reject);
          req2.end();
        });
      }

      // List all products and rename ones named "Pro" or "FocusLedger Pro"
      const products = await stripeGet('/v1/products?limit=20&active=true');
      const results = [];

      for (const product of (products.data || [])) {
        const name = product.name || '';
        if (name.toLowerCase().includes('pro') && !name.toLowerCase().includes('autopilot')) {
          const newName = name.replace(/\bPro\b/gi, 'Autopilot');
          const updated = await stripePost('/v1/products/' + product.id, {
            name: newName,
            description: 'Autopilot — the full FocusLedger cognitive environment. Unlimited tasks, bank sync, AI task breakdown, and everything we ship next.'
          });
          results.push({ id: product.id, old: name, new: updated.name });
        }
      }

      res.json({ success: true, renamed: results });
    } catch (err) {
      console.error('[Admin] Stripe rename error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
};
