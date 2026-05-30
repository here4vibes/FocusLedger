#!/usr/bin/env node
/**
 * Reset the canonical QA user to a clean slate.
 *
 * Run: node scripts/reset-qa-user.js
 *
 * Clears all user-generated data without deleting the account itself.
 * The QA user record is preserved (email, password, created_at).
 * Designed to run at the start of a full smoke suite run.
 *
 * Tables cleared: tasks, task_steps, expenses, time_blocks, ideas,
 * journal_entries, user_values, values_alignment_scores, email_connections,
 * buddy_checkins, buddy_daily_plans, buddy_patterns, buddy_midday_checkins,
 * documents, nudges, nudge_preferences, insurance_policies, coverage_gaps_log,
 * plaid_items, plaid_accounts, plaid_transactions, bill_preferences,
 * customer_emails, buddy_conversations, checkin_mode_preferences,
 * notification_send_log, linked_emails, email_tasks_stash, push_tokens,
 * promo_redemptions, partner_concerns, buddy_demo_sessions, buddy_demo_turns
 *
 * Subscription state reset to free tier (autopilot_expires_at cleared, plan unchanged).
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL env var not set — cannot connect to database.');
  console.error('Run with: DATABASE_URL=postgres://... node scripts/reset-qa-user.js');
  process.exit(1);
}

const { QA_USER } = require('../config/test-users');
const pool = new Pool();

async function reset() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Look up the QA user
    const userResult = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [QA_USER.email]
    );

    if (userResult.rows.length === 0) {
      console.error(`QA user ${QA_USER.email} not found — create it first via signup or reset script.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }

    const userId = userResult.rows[0].id;
    console.log(`Resetting QA user: ${QA_USER.email} (id=${userId})`);

    // Clear all user-generated tables in dependency order (children first)
    const tablesToClear = [
      'task_steps',
      'tasks',
      'plaid_transactions',
      'plaid_accounts',
      'plaid_items',
      'expenses',
      'time_blocks',
      'ideas',
      'journal_entries',
      'user_values',
      'values_alignment_scores',
      'email_connections',
      'buddy_checkins',
      'buddy_daily_plans',
      'buddy_patterns',
      'buddy_midday_checkins',
      'documents',
      'nudges',
      'nudge_preferences',
      'insurance_policies',
      'coverage_gaps_log',
      'bill_preferences',
      'customer_emails',
      'buddy_conversations',
      'checkin_mode_preferences',
      'notification_send_log',
      'linked_emails',
      'email_tasks_stash',
      'push_tokens',
      'promo_redemptions',
      'partner_concerns',
      'buddy_demo_sessions',
      'buddy_demo_turns',
    ];

    // Reset subscription state (keep plan, clear trial/autopilot dates)
    await client.query(
      `UPDATE users SET
         subscription_plan = 'free',
         subscription_status = 'active',
         autopilot_expires_at = NULL,
         pro_granted_until = NULL,
         is_qa_user = true,
         login_checkin_done_date = NULL,
         login_last_mood = NULL,
         previous_checkin_summary = NULL,
         first_session_insights_done = false,
         session_count = 0
       WHERE id = $1`,
      [userId]
    );
    console.log('  Subscription state reset to free tier');

    let cleared = 0;
    for (const table of tablesToClear) {
      const r = await client.query(
        `DELETE FROM ${table} WHERE user_id = $1`,
        [userId]
      );
      if (r.rowCount > 0) {
        console.log(`  Cleared ${table}: ${r.rowCount} row(s)`);
        cleared += r.rowCount;
      }
    }

    await client.query('COMMIT');
    console.log(`\nQA user reset complete. ${cleared} data rows cleared, account preserved.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

reset().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});