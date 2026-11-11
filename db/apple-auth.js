'use strict';
/**
 * db/apple-auth.js
 * Owns: user rows for Sign in with Apple — lookup by Apple `sub`, link to an
 *       existing account by verified email, create a new account, and the
 *       encrypted refresh token kept for revocation at account deletion.
 * Does NOT own: token verification (lib/apple-signin.js), HTTP (routes/auth-apple.js).
 *
 * users.apple_sub is unique where set (migration `users_apple_sub`).
 */

const USER_COLS = 'id, email, name, password_hash, auth_method, apple_sub';

async function findByAppleSub(db, sub) {
  const r = await db.query(`SELECT ${USER_COLS} FROM users WHERE apple_sub = $1`, [sub]);
  return r.rows[0] || null;
}

async function findByEmail(db, email) {
  const r = await db.query(
    `SELECT ${USER_COLS} FROM users WHERE LOWER(email) = LOWER($1) ORDER BY id LIMIT 1`,
    [email]
  );
  return r.rows[0] || null;
}

/** Attach an Apple id to an existing account that has none. @returns {boolean} whether a row changed */
async function linkAppleSub(db, userId, sub, name) {
  const r = await db.query(
    `UPDATE users
        SET apple_sub = $1,
            name      = COALESCE(NULLIF(name, ''), $3)
      WHERE id = $2 AND apple_sub IS NULL`,
    [sub, userId, name || null]
  );
  return r.rowCount === 1;
}

/** New account with the same starting rows as the other signup paths (budget, free subscription). */
async function createAppleUser(pool, { email, name, sub }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO users (email, name, apple_sub, auth_method)
       VALUES ($1, $2, $3, 'apple')
       RETURNING id, email, name`,
      [email, name || null, sub]
    );
    const user = r.rows[0];
    await client.query('INSERT INTO budgets (weekly_amount, is_active, user_id) VALUES (500.00, true, $1)', [user.id]);
    await client.query(`INSERT INTO app_subscription (plan, status, user_id) VALUES ('free', 'active', $1)`, [user.id]);
    await client.query('COMMIT');
    return user;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Find, link or create the account for a verified Apple identity.
 *
 * Order: (1) the account already holding this Apple `sub`; (2) an account with
 * the same email, when Apple says the email is verified — a "Hide My Email"
 * relay address simply never matches, so it becomes its own account; (3) a new
 * account. The email is needed only to link or create, never to sign in again.
 *
 * @param {object} pool
 * @param {{ sub: string, email: string|null, emailVerified: boolean }} identity from verifyIdToken
 * @param {string|null} name display name from Apple's first-authorization `user` field
 * @returns {Promise<{ user?: {id, email, name}, isNewUser?: boolean, linked?: boolean, error?: string }>}
 *          error is one of 'no_email' | 'email_unverified' | 'email_taken'
 */
async function resolveAppleUser(pool, identity, name) {
  const bySub = await findByAppleSub(pool, identity.sub);
  if (bySub) return { user: bySub, isNewUser: false, linked: false };

  if (!identity.email) return { error: 'no_email' };
  if (!identity.emailVerified) return { error: 'email_unverified' };

  const byEmail = await findByEmail(pool, identity.email);
  if (byEmail) {
    // The address already belongs to an account tied to a different Apple ID.
    if (byEmail.apple_sub) return { error: 'email_taken' };
    const changed = await linkAppleSub(pool, byEmail.id, identity.sub, name);
    if (!changed) return { error: 'email_taken' };
    return { user: byEmail, isNewUser: false, linked: true };
  }

  try {
    const user = await createAppleUser(pool, { email: identity.email, name, sub: identity.sub });
    return { user, isNewUser: true, linked: false };
  } catch (e) {
    // Two callbacks for the same Apple ID raced; the unique index kept one row.
    if (e.code === '23505') {
      const winner = await findByAppleSub(pool, identity.sub);
      if (winner) return { user: winner, isNewUser: false, linked: false };
    }
    throw e;
  }
}

async function saveAppleRefreshToken(db, userId, encryptedToken) {
  await db.query('UPDATE users SET apple_refresh_token = $1 WHERE id = $2', [encryptedToken, userId]);
}

/** @returns {Promise<string|null>} the encrypted refresh token, or null when the user has none */
async function getAppleRefreshToken(db, userId) {
  const r = await db.query('SELECT apple_refresh_token FROM users WHERE id = $1', [userId]);
  return (r.rows[0] && r.rows[0].apple_refresh_token) || null;
}

module.exports = {
  findByAppleSub,
  findByEmail,
  linkAppleSub,
  createAppleUser,
  resolveAppleUser,
  saveAppleRefreshToken,
  getAppleRefreshToken
};
