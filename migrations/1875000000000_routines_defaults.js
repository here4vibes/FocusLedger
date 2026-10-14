'use strict';
/**
 * routines / routine_task_links: the defaults and the unique key the code assumes.
 *
 * Production (Prisma-era schema) has no default on routines.is_active or the
 * timestamp columns, and createRoutine() doesn't set them, so every routine was
 * saved with is_active = NULL and created_at = NULL. Every reader filters on
 * `is_active = true`, so a new routine counted as inactive everywhere:
 *   - seedStarterRoutine's "already has an AM routine" guard never matched,
 *     so each login re-created the starter routine and its tasks;
 *   - routine nudges and the Buddy widget's missed-routine check
 *     (`created_at < CURRENT_DATE`) never saw it.
 * addTaskToRoutine() uses ON CONFLICT DO NOTHING, but no unique key backed it,
 * so links could be duplicated.
 *
 * Checked against production on 2026-10-14: routines and routine_task_links
 * were empty. Idempotent.
 */
module.exports = {
  name: 'routines_defaults',

  up: async (client) => {
    await client.query(`ALTER TABLE routines ALTER COLUMN is_active SET DEFAULT true`);
    await client.query(`UPDATE routines SET is_active = true WHERE is_active IS NULL`);
    await client.query(`ALTER TABLE routines ALTER COLUMN created_at SET DEFAULT NOW()`);
    await client.query(`ALTER TABLE routines ALTER COLUMN updated_at SET DEFAULT NOW()`);
    await client.query(`UPDATE routines SET created_at = COALESCE(updated_at, NOW()) WHERE created_at IS NULL`);
    await client.query(`ALTER TABLE routine_task_links ALTER COLUMN created_at SET DEFAULT NOW()`);

    // Drop duplicate links (keep the lowest id) so the unique index can build.
    await client.query(`
      DELETE FROM routine_task_links a
      USING routine_task_links b
      WHERE a.routine_id = b.routine_id AND a.task_id = b.task_id AND a.id > b.id`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS routine_task_links_routine_task_uidx
      ON routine_task_links (routine_id, task_id)`);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS routine_task_links_routine_task_uidx`);
  },
};
