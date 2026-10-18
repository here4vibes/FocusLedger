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

/** QA/synthetic accounts are skipped by every metric and lifecycle push. */
async function isQaUser(pool, userId) {
  const { rows } = await pool.query('SELECT is_qa_user FROM users WHERE id = $1', [userId]);
  return !!(rows[0] && rows[0].is_qa_user);
}

/**
 * First-touch ad attribution, written once at signup. `attr` is already
 * sanitized (lib/attribution.sanitizeAttribution). Every column is COALESCEd so
 * the first write wins. With `maxAgeHours`, only an account created that
 * recently is updated (the post-OAuth PATCH path), so an old account can't be
 * re-attributed later. Returns true when a row was updated.
 */
async function saveSignupAttribution(pool, userId, attr, { maxAgeHours = null } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE users SET
       utm_source      = COALESCE(utm_source, $2),
       utm_medium      = COALESCE(utm_medium, $3),
       utm_campaign    = COALESCE(utm_campaign, $4),
       utm_content     = COALESCE(utm_content, $5),
       utm_term        = COALESCE(utm_term, $6),
       signup_referrer = COALESCE(signup_referrer, $7),
       first_touch     = COALESCE(first_touch, $8::jsonb)
     WHERE id = $1
       AND ($9::int IS NULL OR created_at >= NOW() - make_interval(hours => $9::int))`,
    [userId, attr.utm_source || null, attr.utm_medium || null, attr.utm_campaign || null,
      attr.utm_content || null, attr.utm_term || null, attr.referrer_domain || null,
      JSON.stringify(attr), maxAgeHours]
  );
  return rowCount > 0;
}

module.exports = { markQaUser, getUserAdminInfo, isQaUser, saveSignupAttribution };
