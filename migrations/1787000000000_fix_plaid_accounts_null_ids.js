'use strict';
/**
 * Fix plaid_accounts.id — backfill null rows and attach a sequence.
 *
 * Root cause: the Prisma-generated plaid_accounts table has id as a plain
 * INTEGER with no DEFAULT and no sequence. Any INSERT that omits id produces
 * a null id. getAccountMap then stores null as the map value, every
 * accountMap lookup returns falsy, and all transactions are silently skipped.
 *
 * Confirmed in production via information_schema.columns:
 *   column_default: null, is_nullable: YES (no SERIAL, no sequence)
 *
 * Mirrors the pattern in 1781600000000_ensure_plaid_items_ids_v2.js.
 */
module.exports = {
  name: 'fix_plaid_accounts_null_ids',

  up: async (client) => {
    // Step 1: backfill existing null-id rows
    await client.query(`
      WITH max_id AS (
        SELECT COALESCE(MAX(id), 0) AS m FROM plaid_accounts WHERE id IS NOT NULL
      ),
      nulls AS (
        SELECT ctid,
               ROW_NUMBER() OVER (ORDER BY created_at NULLS LAST, ctid) AS rn
        FROM plaid_accounts
        WHERE id IS NULL
      )
      UPDATE plaid_accounts pa
      SET id = mx.m + ns.rn
      FROM max_id mx
      JOIN nulls ns ON true
      WHERE pa.ctid = ns.ctid
    `);

    // Step 2: create sequence if missing
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_sequences
          WHERE schemaname = current_schema()
            AND sequencename = 'plaid_accounts_id_seq'
        ) THEN
          EXECUTE 'CREATE SEQUENCE plaid_accounts_id_seq';
        END IF;
      END $$
    `);

    // Step 3: set sequence value to MAX(id) + 1
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM plaid_accounts`
    );
    const nextVal = (parseInt(rows[0].max_id, 10) || 0) + 1;
    await client.query(`SELECT setval('plaid_accounts_id_seq', $1, false)`, [nextVal]);

    // Step 4: attach as column DEFAULT so future INSERTs auto-generate
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name  = 'plaid_accounts'
            AND column_name = 'id'
            AND column_default IS NOT NULL
        ) THEN
          ALTER TABLE plaid_accounts
            ALTER COLUMN id SET DEFAULT nextval('plaid_accounts_id_seq');
        END IF;
      END $$
    `);
  },

  down: async (_client) => {
    // Intentionally not reverting — restoring null ids would break sync again.
  },
};
