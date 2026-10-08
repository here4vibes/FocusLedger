'use strict';
/**
 * users.id integrity: sequence default, repair NULL and duplicate ids, primary key.
 *
 * Production's users table was created without SERIAL/PRIMARY KEY (the
 * genesis `CREATE TABLE IF NOT EXISTS ... id SERIAL PRIMARY KEY` never ran
 * because the table already existed). Signup inserts (email, name, ...) and
 * relies on a default that didn't exist, so:
 *  - every account created since ~2026-05-29 was stored with id = NULL
 *    (and created_at = NULL): those users can't use the app, and anything
 *    they created was saved with user_id = NULL;
 *  - two ids were assigned twice (23, 25), so two people shared one id.
 *
 * Repair (idempotent):
 *  1. users_id_seq, positioned past MAX(id), as the column default.
 *  2. NULL ids get fresh ids.
 *  3. Duplicate ids: the row that owns the id keeps it — the one with a real
 *     created_at (earliest first); the QA user always keeps its id. Every
 *     other row gets a fresh id. All existing data under the id predates the
 *     re-keyed rows, so it stays with the owner.
 *  4. created_at DEFAULT NOW() for future signups (unknown past dates stay NULL).
 *  5. PRIMARY KEY (id), which also enforces NOT NULL and uniqueness.
 * Re-keys are logged as old -> new user ids (no personal data).
 */
module.exports = {
  name: 'users_id_integrity',

  up: async (client) => {
    await client.query('CREATE SEQUENCE IF NOT EXISTS users_id_seq');
    await client.query(`
      SELECT setval('users_id_seq',
        GREATEST((SELECT COALESCE(MAX(id), 0) FROM users), (SELECT last_value FROM users_id_seq), 1))`);
    await client.query(`ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('users_id_seq')`);
    await client.query('ALTER SEQUENCE users_id_seq OWNED BY users.id');

    const nulls = await client.query(
      `UPDATE users SET id = nextval('users_id_seq') WHERE id IS NULL RETURNING id`);
    for (const r of nulls.rows) console.log('[migrate] users_id_integrity: NULL id ->', r.id);

    const dups = await client.query(`
      WITH ranked AS (
        SELECT ctid AS row_ref, id AS old_id,
               ROW_NUMBER() OVER (
                 PARTITION BY id
                 ORDER BY (is_qa_user IS TRUE) DESC, created_at ASC NULLS LAST
               ) AS rn
        FROM users
      )
      UPDATE users u SET id = nextval('users_id_seq')
      FROM ranked r
      WHERE u.ctid = r.row_ref AND r.rn > 1
      RETURNING r.old_id, u.id AS new_id`);
    for (const r of dups.rows) console.log('[migrate] users_id_integrity: duplicate id', r.old_id, '->', r.new_id);

    await client.query('ALTER TABLE users ALTER COLUMN created_at SET DEFAULT NOW()');

    const pk = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'p'`);
    if (!pk.rows.length) {
      await client.query('ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id)');
    }
  },

  down: async (client) => {
    // Ids handed out by the repair are kept: reverting them would re-break those accounts.
    await client.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey');
    await client.query('ALTER TABLE users ALTER COLUMN id DROP DEFAULT');
    await client.query('ALTER TABLE users ALTER COLUMN created_at DROP DEFAULT');
  },
};
