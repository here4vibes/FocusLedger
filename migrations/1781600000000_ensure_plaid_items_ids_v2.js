'use strict';
/**
 * Definitive fix for plaid_items.id being NULL.
 *
 * Replaces fix_plaid_items_id_sequence which kept failing (likely at
 * ALTER SEQUENCE OWNED BY or ALTER COLUMN SET NOT NULL) and blocked
 * fix_expenses_column_types from ever running.
 *
 * Strategy: pure DML backfill first (never fails), then minimal safe DDL.
 * Skips SET NOT NULL, ADD PRIMARY KEY, and OWNED BY — those are nice-to-have
 * but are not needed for buttons / Reconnect to work. What matters is that
 * existing null-id rows get real integer ids and future INSERTs get a DEFAULT.
 */
module.exports = {
  name: 'ensure_plaid_items_ids_v2',

  up: async (client) => {
    // 1. Backfill null ids — pure DML, no DDL, nothing to fail
    await client.query(`
      WITH max_id AS (
        SELECT COALESCE(MAX(id), 0) AS m FROM plaid_items WHERE id IS NOT NULL
      ),
      nulls AS (
        SELECT ctid,
               ROW_NUMBER() OVER (ORDER BY created_at NULLS LAST, ctid) AS rn
        FROM plaid_items
        WHERE id IS NULL
      )
      UPDATE plaid_items p
      SET id = mx.m + ns.rn
      FROM max_id mx
      JOIN nulls ns ON true
      WHERE p.ctid = ns.ctid
    `);

    // 2. Create the sequence if it does not already exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_sequences
          WHERE schemaname = current_schema()
            AND sequencename = 'plaid_items_id_seq'
        ) THEN
          EXECUTE 'CREATE SEQUENCE plaid_items_id_seq';
        END IF;
      END $$
    `);

    // 3. Advance sequence above current max (JS-computed → no GREATEST/COALESCE/0 trap)
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM plaid_items`
    );
    const nextVal = Math.max(parseInt(rows[0].max_id, 10) || 0, 0) + 1;
    await client.query(`SELECT setval('plaid_items_id_seq', $1, false)`, [nextVal]);

    // 4. Attach sequence as DEFAULT if column has no default yet
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name  = 'plaid_items'
            AND column_name = 'id'
            AND column_default IS NOT NULL
        ) THEN
          ALTER TABLE plaid_items
            ALTER COLUMN id SET DEFAULT nextval('plaid_items_id_seq');
        END IF;
      END $$
    `);
  },

  down: async (client) => {
    await client.query(`ALTER TABLE plaid_items ALTER COLUMN id DROP DEFAULT`);
    await client.query(`DROP SEQUENCE IF EXISTS plaid_items_id_seq`);
  },
};
