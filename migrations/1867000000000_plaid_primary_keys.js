'use strict';
/**
 * plaid_items / plaid_accounts: primary keys, with sequences re-synced first.
 *
 * Both tables got an id sequence from earlier repairs (1781600000000,
 * 1787000000000), so table_id_integrity skipped them, but neither had a
 * primary key. db/money-prisma.js also inserted with an explicit
 * `(SELECT COALESCE(MAX(id), 0) + 1 ...)`, which bypasses the sequence and can
 * hand two concurrent bank connections the same id. That code now uses the
 * column default, so each sequence must sit past MAX(id) first or its next
 * value could collide with an existing row.
 *
 * Idempotent. Fails loudly (aborting the deploy) if a NULL or duplicate id
 * exists: in Oct 2026 both tables had none.
 */
const TABLES = ['plaid_items', 'plaid_accounts'];

module.exports = {
  name: 'plaid_primary_keys',

  up: async (client) => {
    for (const table of TABLES) {
      const seq = `${table}_id_seq`;
      await client.query(`CREATE SEQUENCE IF NOT EXISTS ${seq}`);
      await client.query(
        `SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), (SELECT last_value FROM ${seq}), 1))`);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${seq}')`);
      await client.query(`ALTER SEQUENCE ${seq} OWNED BY ${table}.id`);

      const { rows: [bad] } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE id IS NULL)::int AS nulls,
                (COUNT(id) - COUNT(DISTINCT id))::int AS dups
         FROM ${table}`);
      if (bad.nulls || bad.dups) {
        throw new Error(`${table} has ${bad.nulls} NULL and ${bad.dups} duplicate ids — repair before adding a primary key`);
      }
      const { rows: pk } = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'p'`);
      if (!pk.length) {
        await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (id)`);
        console.log(`[migrate] plaid_primary_keys: ${table} primary key added`);
      }
    }
  },

  down: async (client) => {
    for (const table of TABLES) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
    }
  },
};
