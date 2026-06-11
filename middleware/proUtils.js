/**
 * Pro Status Utility Module
 *
 * Single source of truth for Pro gating logic across FocusLedger.
 *
 * Ensures:
 * 1. Pro status checked at interaction time (not page load)
 * 2. admin_pro_override is always respected
 * 3. Graceful error handling (doesn't default to non-Pro on API failure)
 * 4. Consistent behavior across all gated features
 *
 * Features gated by Pro:
 * - AI task step suggestions
 * - Bank Sync (Plaid connection)
 * - Recurring tasks (unlimited)
 * - Recurring expenses (unlimited)
 * - Task count limit (10 for free, unlimited for Pro)
 */

async function queryRaw(db, text, params) {
  const result = await db.query(text, params);
  return result.rows;
}

/**
 * Check if user has Pro access.
 *
 * Returns true if:
 * - admin_pro_override = true, OR
 * - Stripe subscription plan = 'pro' AND status = 'active'
 *
 * Returns false if:
 * - Free plan, OR
 * - Cancelled Pro subscription
 *
 * Throws error only on database/network failures (logs, doesn't default).
 * Caller must decide: fail open (allow feature) or fail closed (deny feature).
 *
 * @param {object} pool - PostgreSQL connection pool
 * @param {string|number} userId - User ID to check
 * @returns {Promise<boolean>} true if user is Pro, false otherwise
 * @throws {Error} On database or query errors
 */
async function checkProStatus(pool, userId) {
  if (!pool || !userId) {
    throw new Error('checkProStatus requires pool and userId');
  }

  try {
    // Check admin override first (faster, avoids subscription query in most cases)
    const userResult = await queryRaw(
      pool,
      'SELECT admin_pro_override, pro_granted_until, autopilot_expires_at FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.length) {
      throw new Error(`User ${userId} not found`);
    }

    const user = userResult[0];
    if (user.admin_pro_override) {
      // WHY expiry check: admin-granted Pro can have a time limit (e.g. 3-month apology grant).
      // Null pro_granted_until = permanent override (backward compat with older grants).
      if (!user.pro_granted_until || new Date(user.pro_granted_until) > new Date()) {
        return true;
      }
    }

    // Promo code grant: autopilot_expires_at set by redeem endpoint
    if (user.autopilot_expires_at && new Date(user.autopilot_expires_at) > new Date()) {
      return true;
    }

    // Fall back to Stripe subscription
    const subResult = await queryRaw(
      pool,
      'SELECT plan, status FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [userId]
    );

    const sub = subResult[0];
    return !!(sub && sub.plan === 'pro' && sub.status === 'active');
  } catch (err) {
    throw new Error(`Pro status check failed for user ${userId}: ${err.message}`);
  }
}

/**
 * Check if user is at/exceeds the free task limit (10 tasks).
 * Returns true if free user with 10+ active tasks, false otherwise.
 *
 * @param {object} pool - PostgreSQL connection pool
 * @param {string|number} userId - User ID to check
 * @param {boolean} isPro - Whether user is Pro (already known)
 * @returns {Promise<boolean>} true if free user at/over limit
 */
async function isAtFreeTaskLimit(pool, userId, isPro) {
  if (isPro) return false; // Pro users have no limit

  const FREE_TASK_LIMIT = 10;
  try {
    const result = await queryRaw(
      pool,
      'SELECT COUNT(*) as count FROM tasks WHERE user_id = $1 AND is_completed = false',
      [userId]
    );
    const activeCount = parseInt(result[0].count, 10);
    return activeCount >= FREE_TASK_LIMIT;
  } catch (err) {
    throw new Error(`Task count check failed: ${err.message}`);
  }
}

/**
 * Get active task count for a user.
 *
 * @param {object} pool - PostgreSQL connection pool
 * @param {string|number} userId - User ID
 * @returns {Promise<number>} Number of active (non-completed) tasks
 */
async function getActiveTaskCount(pool, userId) {
  try {
    const result = await queryRaw(
      pool,
      'SELECT COUNT(*) as count FROM tasks WHERE user_id = $1 AND is_completed = false',
      [userId]
    );
    return parseInt(result[0].count, 10);
  } catch (err) {
    throw new Error(`Failed to count tasks: ${err.message}`);
  }
}

/**
 * Check if user is at/exceeds the free recurring task limit (2 tasks).
 * Returns true if free user with 2+ active recurring tasks, false otherwise.
 *
 * @param {object} pool - PostgreSQL connection pool
 * @param {string|number} userId - User ID
 * @param {boolean} isPro - Whether user is Pro (already known)
 * @returns {Promise<boolean>} true if free user at/over limit
 */
async function isAtFreeRecurringLimit(pool, userId, isPro) {
  if (isPro) return false; // Pro users have no limit

  const FREE_RECURRING_LIMIT = 2;
  try {
    const result = await queryRaw(
      pool,
      'SELECT COUNT(*) as count FROM recurring_templates WHERE user_id = $1 AND is_active = true',
      [userId]
    );
    const activeCount = parseInt(result[0].count, 10);
    return activeCount >= FREE_RECURRING_LIMIT;
  } catch (err) {
    throw new Error(`Recurring task count check failed: ${err.message}`);
  }
}

/**
 * Assertion helper: throw if user is not Pro.
 * Use in route handlers where Pro is mandatory.
 *
 * Example:
 *   await requirePro(pool, userId, 'Bank Sync');
 *
 * @param {object} pool - PostgreSQL connection pool
 * @param {string|number} userId - User ID
 * @param {string} featureName - Name of feature for error message
 * @throws {Error} If user is not Pro
 */
async function requirePro(pool, userId, featureName = 'Feature') {
  const isPro = await checkProStatus(pool, userId);
  if (!isPro) {
    const err = new Error(`${featureName} requires Autopilot subscription`);
    err.code = 'PRO_REQUIRED';
    err.status = 403;
    throw err;
  }
}

module.exports = {
  checkProStatus,
  isAtFreeTaskLimit,
  getActiveTaskCount,
  isAtFreeRecurringLimit,
  requirePro
};
