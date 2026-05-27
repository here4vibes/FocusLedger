'use strict';
/**
 * db/account-deletion.js
 * Owns: account_deletion_tokens table reads/writes, cascade delete across all user tables.
 * Does NOT own: user auth, Stripe API calls, email delivery.
 */

const crypto = require('crypto');

/**
 * Hash a raw token string for safe storage.
 * Same approach as password_reset_tokens.
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a secure random token string + store it hashed.
 * Returns { raw, expiresAt } — raw is sent to the user, never stored.
 */
async function createDeletionToken(pool, userId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  // Invalidate any existing unused tokens for this user first
  await pool.query(
    `UPDATE account_deletion_tokens SET used = true WHERE user_id = $1 AND used = false`,
    [userId]
  );

  await pool.query(
    `INSERT INTO account_deletion_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  return { raw, expiresAt };
}

/**
 * Look up a token by its raw value.
 * Returns the row if valid (not used, not expired), or null.
 */
async function findValidToken(pool, rawToken) {
  const tokenHash = hashToken(rawToken);
  const result = await pool.query(
    `SELECT id, user_id, expires_at, used
     FROM account_deletion_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );

  const row = result.rows[0];
  if (!row) return null;
  if (row.used) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  return row;
}

/**
 * Mark a token as used (one-time use enforcement).
 */
async function markTokenUsed(pool, tokenId) {
  await pool.query(
    `UPDATE account_deletion_tokens SET used = true WHERE id = $1`,
    [tokenId]
  );
}

/**
 * Cascade-delete all data for a user and remove the user record.
 * Order matters: child tables before parent. Tables lacking user_id are skipped gracefully.
 * Uses explicit parameterized DELETE statements — no dynamic table-name interpolation.
 */
async function deleteUserCascade(pool, userId) {
  async function del(sql, table) {
    try { await pool.query(sql, [userId]); }
    catch (e) {
      if (!e.message.includes('column "user_id" does not exist') &&
          !e.message.includes('does not exist')) {
        console.error(`[account-deletion] Error clearing ${table}:`, e.message);
      }
    }
  }

  // Task-related
  await del('DELETE FROM task_steps WHERE user_id = $1', 'task_steps');
  await del('DELETE FROM tasks WHERE user_id = $1', 'tasks');
  // Financial
  await del('DELETE FROM expenses WHERE user_id = $1', 'expenses');
  await del('DELETE FROM plaid_transactions WHERE user_id = $1', 'plaid_transactions');
  await del('DELETE FROM plaid_accounts WHERE user_id = $1', 'plaid_accounts');
  await del('DELETE FROM plaid_items WHERE user_id = $1', 'plaid_items');
  await del('DELETE FROM bill_preferences WHERE user_id = $1', 'bill_preferences');
  await del('DELETE FROM app_subscription WHERE user_id = $1', 'app_subscription');
  // Time / calendar
  await del('DELETE FROM time_blocks WHERE user_id = $1', 'time_blocks');
  await del('DELETE FROM work_hour_blocks WHERE user_id = $1', 'work_hour_blocks');
  // Values & scoring
  await del('DELETE FROM user_values WHERE user_id = $1', 'user_values');
  await del('DELETE FROM values_alignment_scores WHERE user_id = $1', 'values_alignment_scores');
  await del('DELETE FROM user_weekly_reports WHERE user_id = $1', 'user_weekly_reports');
  // Journal & ideas
  await del('DELETE FROM journal_entries WHERE user_id = $1', 'journal_entries');
  await del('DELETE FROM ideas WHERE user_id = $1', 'ideas');
  // Buddy system
  await del('DELETE FROM buddy_checkins WHERE user_id = $1', 'buddy_checkins');
  await del('DELETE FROM buddy_daily_plans WHERE user_id = $1', 'buddy_daily_plans');
  await del('DELETE FROM buddy_midday_checkins WHERE user_id = $1', 'buddy_midday_checkins');
  await del('DELETE FROM buddy_patterns WHERE user_id = $1', 'buddy_patterns');
  // Documents & nudges
  await del('DELETE FROM documents WHERE user_id = $1', 'documents');
  await del('DELETE FROM ai_extraction_usage WHERE user_id = $1', 'ai_extraction_usage');
  await del('DELETE FROM nudges WHERE user_id = $1', 'nudges');
  await del('DELETE FROM nudge_preferences WHERE user_id = $1', 'nudge_preferences');
  // Insurance
  await del('DELETE FROM insurance_policies WHERE user_id = $1', 'insurance_policies');
  await del('DELETE FROM coverage_gaps_log WHERE user_id = $1', 'coverage_gaps_log');
  // Email & notifications
  await del('DELETE FROM email_connections WHERE user_id = $1', 'email_connections');
  await del('DELETE FROM email_log WHERE user_id = $1', 'email_log');
  await del('DELETE FROM push_subscriptions WHERE user_id = $1', 'push_subscriptions');
  await del('DELETE FROM customer_emails WHERE user_id = $1', 'customer_emails');
  // Auth tokens
  await del('DELETE FROM password_reset_tokens WHERE user_id = $1', 'password_reset_tokens');
  await del('DELETE FROM account_deletion_tokens WHERE user_id = $1', 'account_deletion_tokens');
  // Analytics
  await del('DELETE FROM analytics_events WHERE user_id = $1', 'analytics_events');
  await del('DELETE FROM contact_submissions WHERE user_id = $1', 'contact_submissions');
  await del('DELETE FROM categories WHERE user_id = $1', 'categories');

  // Delete user record last
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  console.log(`[account-deletion] Cascade delete complete for user ${userId}`);
}

/** Look up a user by id — returns { id, email, name } or null. */
async function getUserById(pool, userId) {
  const result = await pool.query(
    'SELECT id, email, name FROM users WHERE id = $1', [userId]
  );
  return result.rows[0] || null;
}

/** Look up a user's admin status — returns { id, email, is_admin } or null. */
async function getUserAdminInfo(pool, userId) {
  const result = await pool.query(
    'SELECT id, email, is_admin FROM users WHERE id = $1', [userId]
  );
  return result.rows[0] || null;
}

/** Mark any active subscription cancelled before hard-deleting the user. */
async function cancelActiveSubscription(pool, userId) {
  await pool.query(
    `UPDATE app_subscription SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
}

module.exports = {
  createDeletionToken, findValidToken, markTokenUsed, hashToken,
  deleteUserCascade, getUserById, getUserAdminInfo, cancelActiveSubscription
};
