'use strict';
/**
 * users table writes that don't belong to a feature module.
 */

/** Flag an account as QA/synthetic so every metric and lifecycle email skips it. */
async function markQaUser(pool, userId) {
  await pool.query('UPDATE users SET is_qa_user = true WHERE id = $1', [userId]);
}

module.exports = { markQaUser };
