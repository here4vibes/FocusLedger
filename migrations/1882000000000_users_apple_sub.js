'use strict';
/**
 * Sign in with Apple: users.apple_sub + users.apple_refresh_token.
 *
 * apple_sub is Apple's stable user id (the id_token `sub`). It is the sign-in
 * key, because the email can be a "Hide My Email" relay address and only the
 * first authorization carries a name. Unique where set: db/apple-auth.js relies
 * on that index to settle two callbacks racing to create the same account.
 *
 * apple_refresh_token is AES-256-GCM ciphertext (lib/apple-signin.js), kept
 * only so account deletion can revoke the token, which Apple requires.
 *
 * Both are nullable with no default: every existing INSERT INTO users omits
 * them, and NULL ("no Apple ID") is the right value for those rows.
 */
module.exports = {
  name: 'users_apple_sub',

  up: async (client) => {
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub TEXT');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_refresh_token TEXT');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_apple_sub_key
        ON users (apple_sub) WHERE apple_sub IS NOT NULL`);
  },

  down: async (client) => {
    await client.query('DROP INDEX IF EXISTS users_apple_sub_key');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS apple_refresh_token');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS apple_sub');
  }
};
