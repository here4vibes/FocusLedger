'use strict';
/**
 * users table writes that don't belong to a feature module.
 */

/** Flag an account as QA/synthetic so every metric and lifecycle email skips it. */
async function markQaUser(pool, userId) {
  await pool.query('UPDATE users SET is_qa_user = true WHERE id = $1', [userId]);
}

/** Fields needed to decide admin access (lib/admin-access.js). Null if no such user. */
async function getUserAdminInfo(pool, userId) {
  const { rows } = await pool.query('SELECT id, email, is_admin FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

module.exports = { markQaUser, getUserAdminInfo };
