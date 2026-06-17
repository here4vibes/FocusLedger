'use strict';
/**
 * Email Cron Scheduler
 *
 * Runs three recurring email jobs:
 *  1. Weekly nudge       — Mondays at 8am (per user's local time)
 *  2. Re-engagement     — Sent at 8am local time to users inactive 3+ days
 *  3. Pro expiry        — Sent at 8am local time 7 days before admin-granted Pro expires
 *
 * All scheduling respects user timezone via lib/timezone.js.
 * Checks every 10 minutes. Idempotent per run — email_log prevents duplicate sends.
 */

const { getLocalDateParts } = require('./lib/timezone');
const { sendEmail } = require('./lib/emailService');
const { weeklyNudgeTemplate, reEngagementTemplate, proExpiryReminderTemplate } = require('./lib/emailTemplates');

// Stripe checkout links — same as routes/subscription.js
const STRIPE_LINKS = {
  monthly: 'https://buy.stripe.com/8x200i6m784y4bS0KZcs800',
  annual: 'https://buy.stripe.com/4gM14m7qb0C60ZGbpDcs801'
};

// ── Weekly Nudge ───────────────────────────────────────────────────────────────

async function sendWeeklyNudges(pool) {
  const now = new Date();

  try {
    // Get all Pro users with their timezone; exclude QA/test accounts
    const usersResult = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.name,
        COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone
      FROM users u
      JOIN app_subscription s ON s.user_id = u.id
      WHERE s.plan = 'pro' AND s.status = 'active'
        AND COALESCE(u.is_qa_user, false) = false
    `);

    for (const user of usersResult.rows) {
      const { date: localDate, hour, weekday } = getLocalDateParts(user.timezone, now);

      // Only send on Monday between 8:00–8:59am local time
      if (weekday !== 'Mon' || hour !== 8) continue;

      // Check if already sent today
      const alreadySent = await pool.query(
        `SELECT id FROM email_log
         WHERE user_id = $1 AND template_type = 'weekly_nudge'
           AND DATE(created_at AT TIME ZONE $2) = $3`,
        [user.id, user.timezone, localDate]
      );
      if (alreadySent.rows.length > 0) continue;

      // Check preferences
      const prefs = await pool.query(
        'SELECT weekly_nudge FROM user_email_preferences WHERE user_id = $1',
        [user.id]
      );
      if (prefs.rows.length > 0 && !prefs.rows[0].weekly_nudge) continue;

      // Get tasks due this week and completed last week
      const [dueResult, completedResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FROM tasks
           WHERE user_id = $1 AND completed = false
             AND due_date >= CURRENT_DATE AND due_date < CURRENT_DATE + INTERVAL '7 days'`,
          [user.id]
        ),
        pool.query(
          `SELECT COUNT(*) FROM tasks
           WHERE user_id = $1 AND completed = true
             AND updated_at >= NOW() - INTERVAL '7 days'`,
          [user.id]
        )
      ]);

      const tasksDueThisWeek = parseInt(dueResult.rows[0].count, 10) || 0;
      const tasksCompletedLastWeek = parseInt(completedResult.rows[0].count, 10) || 0;

      const { subject, html } = weeklyNudgeTemplate({
        name: user.name,
        tasksDueThisWeek,
        tasksCompletedLastWeek
      });

      // Fire and forget
      sendEmail(pool, {
        to: user.email,
        subject,
        html,
        templateType: 'weekly_nudge',
        userId: user.id
      }).catch((err) => {
        console.error('[emailCron] Weekly nudge send failed:', user.id, err.message);
      });
    }
  } catch (err) {
    console.error('[emailCron] Weekly nudge error:', err.message);
  }
}

// ── Re-Engagement ──────────────────────────────────────────────────────────────

async function sendReEngagementEmails(pool) {
  const now = new Date();

  try {
    // Fetch eligible users with their timezone
    const usersResult = await pool.query(`
      SELECT DISTINCT
        u.id,
        u.email,
        u.name,
        COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone
      FROM users u
      WHERE
        COALESCE(u.is_qa_user, false) = false
        AND (u.last_active_at IS NULL OR u.last_active_at < NOW() - INTERVAL '3 days')
        AND u.created_at < NOW() - INTERVAL '3 days'
        AND NOT EXISTS (
          SELECT 1 FROM email_log el
          WHERE el.user_id = u.id
            AND el.template_type = 're_engagement'
            AND el.created_at >= COALESCE(u.last_active_at, u.created_at)
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_email_preferences uep
          WHERE uep.user_id = u.id AND uep.re_engagement = false
        )
      LIMIT 200
    `);

    for (const user of usersResult.rows) {
      // Only send at 8am in the user's local time
      const { date: localDate, hour } = getLocalDateParts(user.timezone, now);
      if (hour !== 8) continue;

      // Already sent today in this timezone
      const alreadySent = await pool.query(
        `SELECT id FROM email_log
         WHERE user_id = $1 AND template_type = 're_engagement'
           AND DATE(created_at AT TIME ZONE $2) = $3`,
        [user.id, user.timezone, localDate]
      );
      if (alreadySent.rows.length > 0) continue;

      const { subject, html } = reEngagementTemplate({ name: user.name });

      sendEmail(pool, {
        to: user.email,
        subject,
        html,
        templateType: 're_engagement',
        userId: user.id
      }).catch((err) => {
        console.error('[emailCron] Re-engagement send failed:', user.id, err.message);
      });
    }

    if (usersResult.rows.length > 0) {
      console.log(`[emailCron] Re-engagement candidates: ${usersResult.rows.length}`);
    }
  } catch (err) {
    console.error('[emailCron] Re-engagement error:', err.message);
  }
}

// ── Pro Expiry Reminders ───────────────────────────────────────────────────────

/**
 * Sends a one-time reminder at 8am local time, 7 days before admin-granted Pro expires.
 * WHY: admin grants (e.g. apology credits) have no Stripe subscription, so there's no
 * automatic billing resumption — user needs advance notice to re-subscribe voluntarily.
 * Idempotent: email_log prevents duplicate sends.
 */
async function sendProExpiryReminders(pool) {
  const now = new Date();

  try {
    // Fetch eligible users with their timezone
    const usersResult = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.name,
        u.pro_granted_until,
        COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS timezone
      FROM users u
      WHERE u.admin_pro_override = true
        AND u.pro_granted_until IS NOT NULL
        AND u.pro_granted_until > NOW() + INTERVAL '6 days'
        AND u.pro_granted_until < NOW() + INTERVAL '8 days'
        AND COALESCE(u.is_qa_user, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM email_log el
          WHERE el.user_id = u.id AND el.template_type = 'pro_expiry_reminder'
        )
    `);

    for (const user of usersResult.rows) {
      // Only send at 8am in the user's local time
      const { date: localDate, hour } = getLocalDateParts(user.timezone, now);
      if (hour !== 8) continue;

      const expiryDate = new Date(user.pro_granted_until).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
      });
      const { subject, html } = proExpiryReminderTemplate({
        name: user.name,
        expiryDate,
        monthlyLink: STRIPE_LINKS.monthly,
        annualLink: STRIPE_LINKS.annual
      });

      sendEmail(pool, {
        to: user.email,
        subject,
        html,
        templateType: 'pro_expiry_reminder',
        userId: user.id
      }).catch((err) => {
        console.error('[emailCron] Pro expiry reminder failed:', user.id, err.message);
      });
    }

    if (usersResult.rows.length > 0) {
      console.log(`[emailCron] Pro-expiry candidates: ${usersResult.rows.length}`);
    }
  } catch (err) {
    console.error('[emailCron] Pro expiry reminder error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function scheduleEmailCrons(pool) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[emailCron] RESEND_API_KEY not set — email crons disabled');
    return;
  }

  console.log('[emailCron] Email cron scheduler started (10-min interval)');

  // Run immediately on startup, then every 10 minutes
  async function tick() {
    await sendWeeklyNudges(pool);
    await sendReEngagementEmails(pool);
    await sendProExpiryReminders(pool);
  }

  // Initial run after 2 minutes (let server fully start)
  setTimeout(() => {
    tick().catch((err) => console.error('[emailCron] Tick error:', err.message));
  }, 2 * 60 * 1000);

  // Then every 10 minutes
  setInterval(() => {
    tick().catch((err) => console.error('[emailCron] Tick error:', err.message));
  }, 10 * 60 * 1000);
}

module.exports = { scheduleEmailCrons, runEmailCrons };

async function runEmailCrons(pool) {
  await sendWeeklyNudges(pool);
  await sendReEngagementEmails(pool);
  await sendProExpiryReminders(pool);
}
