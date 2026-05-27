// db/promo-codes.js
// Owns: promo_codes, promo_redemptions tables, autopilot_expires_at on users.
// Does NOT own: subscription gating logic (see middleware/proUtils.js), admin auth.

const { queryWithRetry } = require('../lib/queryWithRetry');

const q = (pool, sql, params) => queryWithRetry(pool, sql, params);

// ── Admin queries ──────────────────────────────────────────────────────────

async function createPromoCode(pool, { code, type, value, max_redemptions, expires_at, created_by }) {
  const result = await q(pool, `
    INSERT INTO promo_codes (code, type, value, max_redemptions, expires_at, created_by)
    VALUES (UPPER($1), $2, $3, $4, $5, $6)
    RETURNING *
  `, [code, type, value, max_redemptions || null, expires_at || null, created_by]);
  return result.rows[0];
}

async function listPromoCodes(pool) {
  const result = await q(pool, `
    SELECT
      pc.*,
      u.email AS created_by_email
    FROM promo_codes pc
    LEFT JOIN users u ON u.id = pc.created_by
    ORDER BY pc.created_at DESC
  `, []);
  return result.rows;
}

async function updatePromoCode(pool, id, { is_active, max_redemptions, expires_at }) {
  // Build SET clause only for provided fields
  const sets = [];
  const params = [];

  if (is_active !== undefined) {
    params.push(is_active);
    sets.push(`is_active = $${params.length}`);
  }
  if (max_redemptions !== undefined) {
    params.push(max_redemptions);
    sets.push(`max_redemptions = $${params.length}`);
  }
  if (expires_at !== undefined) {
    params.push(expires_at || null);
    sets.push(`expires_at = $${params.length}`);
  }

  if (sets.length === 0) return null;

  params.push(id);
  const result = await q(pool, `
    UPDATE promo_codes
    SET ${sets.join(', ')}
    WHERE id = $${params.length}
    RETURNING *
  `, params);
  return result.rows[0];
}

// ── Redemption queries ─────────────────────────────────────────────────────

/**
 * Look up a promo code by code string (case-insensitive).
 * Returns null if not found.
 */
async function findPromoCode(pool, code) {
  const result = await q(pool, `
    SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1)
  `, [code]);
  return result.rows[0] || null;
}

/**
 * Check if a user has already redeemed a code.
 */
async function hasUserRedeemed(pool, promoCodeId, userId) {
  const result = await q(pool, `
    SELECT id FROM promo_redemptions
    WHERE promo_code_id = $1 AND user_id = $2
  `, [promoCodeId, userId]);
  return result.rows.length > 0;
}

/**
 * Record a redemption and extend autopilot_expires_at atomically.
 * Returns { days_granted, autopilot_expires_at }.
 */
async function redeemPromoCode(pool, promoCodeId, userId, days) {
  // Record redemption + increment counter
  await q(pool, `
    INSERT INTO promo_redemptions (promo_code_id, user_id)
    VALUES ($1, $2)
  `, [promoCodeId, userId]);

  await q(pool, `
    UPDATE promo_codes
    SET redemption_count = redemption_count + 1
    WHERE id = $1
  `, [promoCodeId]);

  // Extend autopilot_expires_at:
  // - If null or in the past: start from NOW()
  // - If still in the future: extend from current expiry
  const result = await q(pool, `
    UPDATE users
    SET autopilot_expires_at = GREATEST(NOW(), COALESCE(autopilot_expires_at, NOW())) + ($1 || ' days')::INTERVAL
    WHERE id = $2
    RETURNING autopilot_expires_at
  `, [days, userId]);

  return {
    days_granted: days,
    autopilot_expires_at: result.rows[0]?.autopilot_expires_at
  };
}

/**
 * Get current autopilot_expires_at for a user (for status display).
 */
async function getAutopilotExpiry(pool, userId) {
  const result = await q(pool, `
    SELECT autopilot_expires_at FROM users WHERE id = $1
  `, [userId]);
  return result.rows[0]?.autopilot_expires_at || null;
}

module.exports = {
  createPromoCode,
  listPromoCodes,
  updatePromoCode,
  findPromoCode,
  hasUserRedeemed,
  redeemPromoCode,
  getAutopilotExpiry
};
