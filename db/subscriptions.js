'use strict';
/**
 * db/subscriptions.js — entitlement grants driven by store webhooks (RevenueCat).
 *
 * Autopilot access is read by middleware/proUtils.checkProStatus, which honours
 * users.autopilot_expires_at (a future timestamp = active). Granting an iOS
 * purchase here means the buyer is Autopilot on web too — one entitlement,
 * every surface.
 */

/**
 * Grant/extend Autopilot to a user until `expiresAt` (a Date).
 * Idempotent — safe to call on every renewal webhook.
 */
async function grantAutopilot(pool, userId, expiresAt) {
  await pool.query(
    `UPDATE users SET autopilot_expires_at = $2 WHERE id = $1`,
    [userId, expiresAt]
  );
}

/** Revoke Autopilot (subscription expired). */
async function revokeAutopilot(pool, userId) {
  await pool.query(
    `UPDATE users SET autopilot_expires_at = NULL WHERE id = $1`,
    [userId]
  );
}

module.exports = { grantAutopilot, revokeAutopilot };
