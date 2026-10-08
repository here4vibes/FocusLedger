'use strict';
/**
 * Give _migrations.applied_at a DEFAULT of NOW().
 *
 * Prod's _migrations table was created before migrate.js's
 * `CREATE TABLE IF NOT EXISTS _migrations (... applied_at ... DEFAULT ...)`,
 * so that statement never ran and the column had no default. migrate.js
 * inserted only (name), so every migration it applied was recorded with
 * applied_at = NULL. That was 56 rows by Oct 2026, and it's why the old
 * /health ("newest applied", NULLS LAST) looked stuck at May 27 when the
 * schema was actually current.
 *
 * migrate.js now inserts NOW() explicitly. This default covers any other
 * writer. Existing NULL rows are deliberately left NULL: their real dates are
 * unknown, and inventing them would be worse than an honest gap.
 */
module.exports = {
  name: 'migrations_applied_at_default',

  up: async (client) => {
    await client.query('ALTER TABLE _migrations ALTER COLUMN applied_at SET DEFAULT NOW()');
  },

  down: async (client) => {
    await client.query('ALTER TABLE _migrations ALTER COLUMN applied_at DROP DEFAULT');
  },
};
