'use strict';
/**
 * Queries for the bill guardian (lib/bill-guardian.js).
 * Plaid convention: amount > 0 is money out.
 */

/** Settled outflows from the last ~2 years: two charges of an annual bill (lib/bill-guardian.js). */
async function getRecentOutflows(pool, userId) {
  const { rows } = await pool.query(`
    SELECT merchant_name, description, amount, transaction_date, plaid_category
    FROM plaid_transactions
    WHERE user_id = $1
      AND amount > 0
      AND COALESCE(is_pending, false) = false
      AND transaction_date >= CURRENT_DATE - INTERVAL '800 days'`, [userId]);
  return rows;
}

async function getBillPreferences(pool, userId) {
  const { rows } = await pool.query(
    `SELECT merchant_key, merchant_display_name, bill_type, is_disabled, bucket, kept_at,
            cancel_requested_at, cancel_expected_by::text AS cancel_expected_by, cancel_amount,
            cancel_frequency, cancel_status, cancel_resolved_at, updated_at
     FROM bill_preferences WHERE user_id = $1`,
    [userId]);
  return rows;
}

/** Available cash across checking/savings, or null when unknown. */
async function getAvailableCash(pool, userId) {
  const { rows } = await pool.query(`
    SELECT SUM(COALESCE(a.available_balance, a.current_balance)) AS available
    FROM plaid_accounts a
    JOIN plaid_items i ON i.id = a.plaid_item_id AND i.is_active IS DISTINCT FROM false
    WHERE a.user_id = $1 AND a.type = 'depository'`, [userId]);
  const v = rows[0] && rows[0].available;
  return v == null ? null : Number(v);
}

/**
 * Create the pre-due reminder unless one already exists for this merchant and
 * date (done or not, so finishing it doesn't make it come back). Reminders made
 * before merchant-name normalization carry the raw-name key, so the check also
 * covers the stream's legacy keys.
 * @returns {Promise<boolean>} true when a task was created
 */
async function createBillReminder(pool, userId, stream, task) {
  const keys = [stream.merchant_key, ...(stream.legacy_keys || [])];
  const { rows } = await pool.query(`
    INSERT INTO tasks (user_id, title, description, priority, due_date, source, bill_merchant_key, bill_type)
    SELECT $1, $2, $3, 'medium', $4::date, 'auto_bill', $5, 'obligation'
    WHERE NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE user_id = $1 AND source = 'auto_bill' AND bill_merchant_key = ANY($6::text[]) AND due_date = $4::date)
    RETURNING id`,
    [userId, task.title, task.description, task.due_date, stream.merchant_key, keys]);
  return rows.length > 0;
}

/** Make sure the merchant shows up in the user's bill list (doesn't override answers). */
async function trackRecurringMerchant(pool, userId, stream) {
  await pool.query(`
    INSERT INTO bill_preferences (user_id, merchant_key, merchant_display_name, bill_type, is_disabled, created_at, updated_at)
    VALUES ($1, $2, $3, 'obligation', false, NOW(), NOW())
    ON CONFLICT (user_id, merchant_key) DO UPDATE
      SET merchant_display_name = COALESCE(bill_preferences.merchant_display_name, EXCLUDED.merchant_display_name)`,
    [userId, stream.merchant_key, stream.name]);
}

/** Remember the user's one-tap answer for a merchant. */
async function setBucket(pool, userId, merchantKey, displayName, bucket) {
  await pool.query(`
    INSERT INTO bill_preferences (user_id, merchant_key, merchant_display_name, bucket, is_disabled, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (user_id, merchant_key) DO UPDATE
      SET bucket = EXCLUDED.bucket, is_disabled = EXCLUDED.is_disabled, updated_at = NOW(),
          merchant_display_name = COALESCE(bill_preferences.merchant_display_name, EXCLUDED.merchant_display_name)`,
    [userId, merchantKey, displayName || null, bucket, bucket !== 'obligation']);
}

/** The user reviewed a subscription and is keeping it: remember when, so the review rests for a while. */
async function keepSubscription(pool, userId, merchantKey, displayName) {
  await pool.query(`
    INSERT INTO bill_preferences (user_id, merchant_key, merchant_display_name, bucket, is_disabled, kept_at, created_at, updated_at)
    VALUES ($1, $2, $3, 'subscription', true, NOW(), NOW(), NOW())
    ON CONFLICT (user_id, merchant_key) DO UPDATE
      SET bucket = 'subscription', is_disabled = true, kept_at = NOW(), updated_at = NOW(),
          cancel_requested_at = NULL, cancel_expected_by = NULL, cancel_amount = NULL,
          cancel_frequency = NULL, cancel_status = NULL, cancel_resolved_at = NULL,
          merchant_display_name = COALESCE(bill_preferences.merchant_display_name, EXCLUDED.merchant_display_name)`,
    [userId, merchantKey, displayName || null]);
}

/**
 * The user asked to cancel a subscription. Pending until bank data says whether
 * it worked (lib/bill-guardian.js verifyCancellations).
 */
async function requestCancellation(pool, userId, merchantKey, displayName, { expectedBy, amount, frequency }) {
  await pool.query(`
    INSERT INTO bill_preferences (user_id, merchant_key, merchant_display_name, bucket, is_disabled,
      cancel_requested_at, cancel_expected_by, cancel_amount, cancel_frequency, cancel_status, created_at, updated_at)
    VALUES ($1, $2, $3, 'subscription', true, NOW(), $4::date, $5, $6, 'pending', NOW(), NOW())
    ON CONFLICT (user_id, merchant_key) DO UPDATE
      SET bucket = 'subscription', is_disabled = true, kept_at = NULL,
          cancel_requested_at = NOW(), cancel_expected_by = EXCLUDED.cancel_expected_by,
          cancel_amount = EXCLUDED.cancel_amount, cancel_frequency = EXCLUDED.cancel_frequency,
          cancel_status = 'pending', cancel_resolved_at = NULL, updated_at = NOW(),
          merchant_display_name = COALESCE(bill_preferences.merchant_display_name, EXCLUDED.merchant_display_name)`,
    [userId, merchantKey, displayName || null, expectedBy, amount, frequency]);
}

/** Undo a cancel request that is still pending. */
async function clearCancellation(pool, userId, merchantKey) {
  await pool.query(`
    UPDATE bill_preferences
    SET cancel_requested_at = NULL, cancel_expected_by = NULL, cancel_amount = NULL,
        cancel_frequency = NULL, cancel_status = NULL, cancel_resolved_at = NULL, updated_at = NOW()
    WHERE user_id = $1 AND merchant_key = $2 AND cancel_status = 'pending'`,
    [userId, merchantKey]);
}

/**
 * Settle a pending cancellation from bank evidence.
 * @returns {Promise<boolean>} true when a pending row was updated
 */
async function resolveCancellation(pool, userId, merchantKey, status) {
  const { rowCount } = await pool.query(`
    UPDATE bill_preferences SET cancel_status = $3, cancel_resolved_at = NOW(), updated_at = NOW()
    WHERE user_id = $1 AND merchant_key = $2 AND cancel_status = 'pending'`,
    [userId, merchantKey, status]);
  return rowCount > 0;
}

/** Users with an active bank connection (for the daily run). */
async function usersWithActivePlaid(pool) {
  const { rows } = await pool.query(
    'SELECT DISTINCT user_id FROM plaid_items WHERE is_active IS DISTINCT FROM false AND user_id IS NOT NULL');
  return rows.map(r => r.user_id);
}

module.exports = {
  getRecentOutflows,
  getBillPreferences,
  getAvailableCash,
  createBillReminder,
  trackRecurringMerchant,
  setBucket,
  keepSubscription,
  requestCancellation,
  clearCancellation,
  resolveCancellation,
  usersWithActivePlaid,
};
