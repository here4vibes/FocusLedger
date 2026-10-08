'use strict';
/**
 * Give every table's `id` column a default and a primary key; repair NULL and
 * duplicate ids.
 *
 * Same root cause as users_id_integrity: production tables were created
 * without SERIAL/PRIMARY KEY (the genesis CREATE TABLE IF NOT EXISTS was a
 * no-op on tables that already existed), and inserts rely on an id default
 * that didn't exist. In Oct 2026, 88 tables had no id default and none had a
 * primary key:
 *  - ~13,500 rows had id = NULL (e.g. 5 app_subscription rows, 37 email_log,
 *    244 buddy_conversations, 557 events). Anything that updates or deletes
 *    "the row with id X" silently skipped them — including billing's
 *    cancel/undo for a first-time subscriber, whose row is inserted NULL.
 *  - 6 tables had historical duplicate ids (analytics_events,
 *    visitor_sessions, ai_task_suggestions, adhd_tax_leads,
 *    account_deletion_tokens, _migrations). No current code supplies ids,
 *    so these came from old copies/imports.
 *
 * Tables are discovered from the live schema: an `id` column with no default
 * and not an identity. Fresh databases (genesis SERIAL PRIMARY KEY) have none,
 * so this is a no-op there. For each table:
 *   integer id → <table>_id_seq positioned past MAX(id) as the default
 *   text id    → gen_random_uuid()::text as the default
 *   NULL ids get fresh values; for duplicates the first physical row keeps the
 *   id and the others get fresh values (no table references these by id);
 *   PRIMARY KEY (id) unless the table already has a primary key.
 * Nothing is deleted. Runs in migrate.js's transaction: all or nothing — on
 * any failure the deploy fails and the running version keeps serving.
 */

function ident(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function repairTable(client, table, dataType) {
  const t = ident(table);
  const isText = dataType === 'text' || dataType === 'character varying';
  let fresh;

  if (isText) {
    await client.query(`ALTER TABLE ${t} ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`);
    fresh = 'gen_random_uuid()::text';
  } else {
    const seqName = `${table}_id_seq`;
    const seq = ident(seqName);
    await client.query(`CREATE SEQUENCE IF NOT EXISTS ${seq}`);
    await client.query(
      `SELECT setval($1::regclass, GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), (SELECT last_value FROM ${seq}), 1))`,
      [seqName]
    );
    await client.query(`ALTER TABLE ${t} ALTER COLUMN id SET DEFAULT nextval('${seqName.replace(/'/g, "''")}'::regclass)`);
    await client.query(`ALTER SEQUENCE ${seq} OWNED BY ${t}.id`);
    fresh = `nextval('${seqName.replace(/'/g, "''")}'::regclass)`;
  }

  const nulls = await client.query(`UPDATE ${t} SET id = ${fresh} WHERE id IS NULL`);
  const dups = await client.query(`
    WITH ranked AS (
      SELECT ctid AS row_ref, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ctid) AS rn
      FROM ${t}
    )
    UPDATE ${t} x SET id = ${fresh}
    FROM ranked r
    WHERE x.ctid = r.row_ref AND r.rn > 1`);

  const pk = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`, [table]);
  let addedPk = false;
  if (!pk.rows.length) {
    await client.query(`ALTER TABLE ${t} ADD CONSTRAINT ${ident(table + '_pkey')} PRIMARY KEY (id)`);
    addedPk = true;
  }
  return { nulls: nulls.rowCount, dups: dups.rowCount, addedPk };
}

module.exports = {
  name: 'table_id_integrity',

  up: async (client) => {
    const { rows: tables } = await client.query(`
      SELECT c.table_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.column_name = 'id'
        AND c.column_default IS NULL
        AND c.is_identity = 'NO'
        AND c.data_type IN ('integer', 'bigint', 'smallint', 'text', 'character varying')
      ORDER BY c.table_name`);

    let repairedRows = 0;
    for (const { table_name: table, data_type: dataType } of tables) {
      const r = await repairTable(client, table, dataType);
      repairedRows += r.nulls + r.dups;
      if (r.nulls || r.dups || r.addedPk) {
        console.log(`[migrate] table_id_integrity: ${table} | null ids: ${r.nulls} | duplicate ids: ${r.dups} | primary key added: ${r.addedPk}`);
      }
    }
    console.log(`[migrate] table_id_integrity: ${tables.length} tables repaired, ${repairedRows} rows given new ids`);
  },

  down: async () => {
    // Defaults and keys are left in place: removing them would let NULL and
    // duplicate ids back in, and the ids handed out can't be un-assigned.
  },
};
