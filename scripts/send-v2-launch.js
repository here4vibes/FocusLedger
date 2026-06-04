'use strict';
/**
 * One-shot script: send v2 launch re-engagement email to all real (non-QA) users.
 *
 * Run with: node scripts/send-v2-launch.js
 *
 * Idempotent — skips users who already have a 'v2_launch' email_log entry.
 * Sends via existing emailService (Resend) with 300ms delay between sends.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { sendEmail } = require('../lib/emailService');
const { v2LaunchTemplate } = require('../lib/emailTemplates');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : false,
  max: 3,
  idleTimeoutMillis: 10000
});

async function main() {
  console.log('[v2-launch] Starting v2 launch email campaign...');

  if (!process.env.RESEND_API_KEY) {
    console.error('[v2-launch] RESEND_API_KEY not set — aborting');
    process.exit(1);
  }

  const usersResult = await pool.query(`
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
  console.log(`[v2-launch] Found ${users.length} user(s) to email`);

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
      console.log(`[v2-launch] ✓ Sent to ${user.email} (id=${user.id})`);
    } else {
      failed++;
      console.error(`[v2-launch] ✗ Failed for ${user.email} (id=${user.id})`);
    }

    // 300ms between sends — respect Resend rate limits
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  console.log(`[v2-launch] Campaign complete: ${sent} sent, ${failed} failed`);
  await pool.end();
}

main().catch(err => {
  console.error('[v2-launch] Fatal error:', err.message);
  pool.end();
  process.exit(1);
});
