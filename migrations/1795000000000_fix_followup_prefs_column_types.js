'use strict';
/**
 * Fix column TYPES on user_followup_prefs.
 *
 * Production has the right column names but Prisma-era TEXT types — the
 * followup-email-check cron dies on `COALESCE(p.task_reminder, true)` with
 * "COALESCE types text and boolean cannot be matched" (stack trace from
 * Render logs, 2026-07-12). Migration 1794's ADD COLUMN IF NOT EXISTS
 * skipped them because the columns exist.
 *
 * Per column, under its own SAVEPOINT:
 *   1. Skip if the type is already correct.
 *   2. ALTER TYPE with a USING cast ('true'/'false' → boolean, '9' → int).
 *   3. If the cast fails (garbage values), DROP + re-ADD with the default —
 *      these are per-user preferences with sane defaults; losing a corrupt
 *      value beats a permanently crashing cron.
 */

const COLUMNS = [
  { name: 'task_reminder',       type: 'boolean', def: 'true', cast: 'boolean' },
  { name: 'routine_streak',      type: 'boolean', def: 'true', cast: 'boolean' },
  { name: 'weekly_summary',      type: 'boolean', def: 'true', cast: 'boolean' },
  { name: 'follow_through',      type: 'boolean', def: 'true', cast: 'boolean' },
  { name: 'task_reminder_hour',  type: 'integer', def: '9',    cast: 'integer' },
  { name: 'routine_streak_hour', type: 'integer', def: '9',    cast: 'integer' },
  { name: 'weekly_summary_hour', type: 'integer', def: '9',    cast: 'integer' },
  { name: 'follow_through_hour', type: 'integer', def: '9',    cast: 'integer' },
];

module.exports = {
  name: 'fix_followup_prefs_column_types',

  up: async (client) => {
    for (const col of COLUMNS) {
      await client.query('SAVEPOINT col_sp');
      try {
        const { rows } = await client.query(
          `SELECT data_type FROM information_schema.columns
           WHERE table_name = 'user_followup_prefs' AND column_name = $1`,
          [col.name]
        );
        if (!rows.length) {
          // Column missing entirely — add it with the correct type.
          await client.query(
            `ALTER TABLE user_followup_prefs
             ADD COLUMN ${col.name} ${col.type} NOT NULL DEFAULT ${col.def}`
          );
          await client.query('RELEASE SAVEPOINT col_sp');
          console.log(`[migration] added ${col.name} ${col.type}`);
          continue;
        }
        if (rows[0].data_type === col.type) {
          await client.query('RELEASE SAVEPOINT col_sp');
          continue; // already correct
        }
        // Convert in place. NULLIF guards empty strings; DROP DEFAULT first
        // because the old text default can't survive the type change.
        await client.query(
          `ALTER TABLE user_followup_prefs ALTER COLUMN ${col.name} DROP DEFAULT`
        );
        await client.query(
          `ALTER TABLE user_followup_prefs
           ALTER COLUMN ${col.name} TYPE ${col.type}
           USING NULLIF(${col.name}::text, '')::${col.cast}`
        );
        await client.query(
          `UPDATE user_followup_prefs SET ${col.name} = ${col.def} WHERE ${col.name} IS NULL`
        );
        await client.query(
          `ALTER TABLE user_followup_prefs
           ALTER COLUMN ${col.name} SET DEFAULT ${col.def}`
        );
        await client.query('RELEASE SAVEPOINT col_sp');
        console.log(`[migration] converted ${col.name} → ${col.type}`);
      } catch (e) {
        // Cast failed (garbage values) — rebuild the column with the default.
        // The rebuild gets its OWN savepoint so a failure here can't poison
        // the transaction for the remaining columns.
        await client.query('ROLLBACK TO SAVEPOINT col_sp');
        await client.query('SAVEPOINT col_rebuild_sp');
        try {
          await client.query(`ALTER TABLE user_followup_prefs DROP COLUMN IF EXISTS ${col.name}`);
          await client.query(
            `ALTER TABLE user_followup_prefs
             ADD COLUMN ${col.name} ${col.type} NOT NULL DEFAULT ${col.def}`
          );
          await client.query('RELEASE SAVEPOINT col_rebuild_sp');
          console.warn(`[migration] rebuilt ${col.name} (cast failed: ${e.message})`);
        } catch (e2) {
          await client.query('ROLLBACK TO SAVEPOINT col_rebuild_sp');
          console.warn(`[migration] ${col.name} skipped entirely: ${e2.message}`);
        }
      }
    }
  },
};
