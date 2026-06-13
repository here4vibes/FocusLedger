'use strict';
/**
 * plaid_items.id has no sequence and is nullable in production.
 *
 * Root cause: the original CREATE TABLE IF NOT EXISTS ran on a DB where the
 * table already existed (created via Prisma or an earlier migration) with `id`
 * as a plain integer column — no SERIAL sequence, no PK, no NOT NULL.
 * Because of IF NOT EXISTS the whole CREATE TABLE was skipped, so the SERIAL
 * PRIMARY KEY definition was never applied.
 *
 * Result: every INSERT without an explicit id gets id = NULL, making every
 * WHERE id = $1 query return no rows, and the frontend itemId = null so all
 * Refresh / Reconnect / Disconnect buttons fire "Account not found".
 *
 * Fix:
 *   1. Create the sequence (IF NOT EXISTS — idempotent).
 *   2. Backfill any NULL ids with the next sequence value.
 *   3. Set the column default to the sequence.
 *   4. Set the column NOT NULL.
 *   5. Add PRIMARY KEY constraint (IF NOT EXISTS check via pg_constraint).
 *   6. Own the sequence by the column so it drops with the table.
 */
module.exports = {
  name: 'fix_plaid_items_id_sequence',

  up: async (client) => {
    // 1. Create sequence
    await client.query(`CREATE SEQUENCE IF NOT EXISTS plaid_items_id_seq`);

    // 2. Advance sequence past any existing ids so backfill values don't collide
    await client.query(`
      SELECT setval('plaid_items_id_seq',
        GREATEST(COALESCE((SELECT MAX(id) FROM plaid_items WHERE id IS NOT NULL), 0), 0))
    `);

    // 3. Backfill rows whose id is NULL
    await client.query(`
      UPDATE plaid_items SET id = nextval('plaid_items_id_seq') WHERE id IS NULL
    `);

    // 4. Attach sequence as the column default
    await client.query(`
      ALTER TABLE plaid_items
        ALTER COLUMN id SET DEFAULT nextval('plaid_items_id_seq')
    `);

    // 5. Add NOT NULL constraint
    await client.query(`
      ALTER TABLE plaid_items ALTER COLUMN id SET NOT NULL
    `);

    // 6. Add PRIMARY KEY (guard: skip if already present)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'plaid_items'::regclass AND contype = 'p'
        ) THEN
          ALTER TABLE plaid_items ADD CONSTRAINT plaid_items_pkey PRIMARY KEY (id);
        END IF;
      END $$
    `);

    // 7. Own the sequence so it cascades on DROP TABLE
    await client.query(`
      ALTER SEQUENCE plaid_items_id_seq OWNED BY plaid_items.id
    `);
  },

  down: async (client) => {
    await client.query(`ALTER TABLE plaid_items DROP CONSTRAINT IF EXISTS plaid_items_pkey`);
    await client.query(`ALTER TABLE plaid_items ALTER COLUMN id DROP DEFAULT`);
    await client.query(`ALTER TABLE plaid_items ALTER COLUMN id DROP NOT NULL`);
    await client.query(`DROP SEQUENCE IF EXISTS plaid_items_id_seq`);
  },
};
