#!/usr/bin/env node
'use strict';
/**
 * jobs/betaReengagementBlast.js — ONE-TIME beta re-engagement email.
 *
 * Sends every user (except QA) a founder note: FocusLedger is still in
 * beta/prelaunch, and Autopilot can be turned on FREE by request during beta.
 *
 * Safety rails:
 *   - Idempotent: one_off_email_log UNIQUE(user_id, campaign) — re-running
 *     the job (or the annual cron tick) is a no-op for anyone already sent.
 *   - QA user excluded (is_qa_user).
 *   - Throttled ~600ms between sends (Resend rate limits).
 *   - DRY_RUN=1 env prints the recipient list without sending.
 *
 * Trigger manually from the Render dashboard (Trigger Run). The render.yaml
 * schedule is Feb 29 — effectively manual-only; the log makes even that
 * accidental tick harmless.
 */

const CAMPAIGN = 'beta_autopilot_2026_07';

function esc(s) {
  return String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function buildEmail(name) {
  const first = esc((name || '').split(' ')[0] || 'there');
  const subject = 'You got in early — here’s what that gets you';
  const html = `
  <div style="max-width:560px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141416;line-height:1.6;padding:24px;">
    <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#f0b429;font-weight:700;margin-bottom:16px;">FocusLedger &middot; Beta</div>
    <p style="font-size:16px;margin:0 0 14px;">Hey ${first},</p>
    <p style="font-size:16px;margin:0 0 14px;">
      Quick note from the person building FocusLedger: we’re still in beta &mdash; prelaunch, honestly &mdash;
      and you’re one of the first people inside. That comes with a perk I want to make sure you know about.
    </p>
    <div style="background:#faf7ef;border:1px solid #f0b429;border-radius:12px;padding:16px 18px;margin:0 0 14px;">
      <p style="font-size:16px;margin:0;font-weight:600;color:#011e5c;">
        Autopilot (the paid tier) is free during beta &mdash; just ask.
      </p>
      <p style="font-size:14px;margin:8px 0 0;color:#444;">
        Reply to this email with &ldquo;turn it on&rdquo; and we’ll flip it for your account. No card, no catch.
      </p>
    </div>
    <p style="font-size:16px;margin:0 0 14px;">
      A lot has shipped lately: a Daily Reveal waiting for you every morning, notifications that
      actually arrive, streaks that forgive a missed day, and much smoother bank syncing.
    </p>
    <div style="margin:22px 0;">
      <a href="https://focusledger.net/app"
         style="display:inline-block;background:#011e5c;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;">
        Open FocusLedger
      </a>
    </div>
    <p style="font-size:16px;margin:0 0 4px;">&mdash; Sean</p>
    <p style="font-size:13px;color:#888;margin:0 0 18px;">Building FocusLedger &mdash; an ADHD-native command center</p>
    <p style="font-size:12px;color:#aaa;border-top:1px solid #eee;padding-top:12px;margin:0;">
      You’re getting this because you created a FocusLedger account during beta.
      Reply &ldquo;no more&rdquo; and we’ll never email you again.
    </p>
  </div>`;
  const text = `Hey ${(name || '').split(' ')[0] || 'there'},

Quick note from the person building FocusLedger: we're still in beta - prelaunch, honestly - and you're one of the first people inside.

The perk: Autopilot (the paid tier) is free during beta - just ask. Reply to this email with "turn it on" and we'll flip it for your account. No card, no catch.

A lot has shipped lately: a Daily Reveal waiting for you every morning, notifications that actually arrive, streaks that forgive a missed day, and much smoother bank syncing.

Open FocusLedger: https://focusledger.net/app

- Sean

You're getting this because you created a FocusLedger account during beta. Reply "no more" and we'll never email you again.`;
  return { subject, html, text };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  if (!process.env.RESEND_API_KEY) {
    console.error('[beta-blast] RESEND_API_KEY not set — aborting');
    process.exitCode = 1;
    return;
  }

  // Lazy requires — keeps the module loadable (tests) without pg/resend installed
  const { sendEmail } = require('../lib/emailService');
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });

  const dryRun = process.env.DRY_RUN === '1';

  try {
    const { rows: recipients } = await pool.query(
      `SELECT u.id, u.email, u.name
       FROM users u
       WHERE u.is_qa_user IS NOT TRUE
         AND u.email IS NOT NULL
         AND u.email <> ''
         AND NOT EXISTS (
           SELECT 1 FROM one_off_email_log l
           WHERE l.user_id = u.id AND l.campaign = $1
         )
         AND NOT EXISTS (
           SELECT 1 FROM email_suppression es WHERE LOWER(es.email) = LOWER(u.email)
         )
       ORDER BY u.id`,
      [CAMPAIGN]
    );

    console.log(`[beta-blast] campaign=${CAMPAIGN} recipients=${recipients.length} dry_run=${dryRun}`);
    if (dryRun) {
      recipients.forEach(r => console.log(`[beta-blast] DRY would send → user=${r.id} ${r.email}`));
      return;
    }

    let sent = 0, failed = 0;
    for (const user of recipients) {
      const { subject, html, text } = buildEmail(user.name);
      // sendEmail never throws — it returns { success, error? } and logs to email_log
      const result = await sendEmail(pool, {
        to: user.email, subject, html, text,
        templateType: CAMPAIGN, userId: user.id,
      });
      if (result.success) {
        await pool.query(
          `INSERT INTO one_off_email_log (user_id, campaign, email)
           VALUES ($1, $2, $3) ON CONFLICT (user_id, campaign) DO NOTHING`,
          [user.id, CAMPAIGN, user.email]
        ).catch(e => console.error('[beta-blast] log insert failed:', e.message));
        sent++;
        console.log(`[beta-blast] sent → user=${user.id} ${user.email}`);
      } else {
        failed++;
        console.error(`[beta-blast] FAILED user=${user.id} ${user.email}:`, result.error);
      }
      await sleep(600); // Resend rate-limit headroom
    }

    console.log(`[beta-blast] Done. sent=${sent} failed=${failed} total=${recipients.length}`);
  } catch (err) {
    console.error('[beta-blast] Fatal:', err.message, '\n', err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

module.exports = { buildEmail, CAMPAIGN };
if (require.main === module) run();
