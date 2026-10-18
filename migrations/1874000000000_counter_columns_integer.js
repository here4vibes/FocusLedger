'use strict';
/**
 * Counter and ordinal columns that production stores with the wrong type
 * (Prisma-era schema; genesis CREATE TABLE IF NOT EXISTS reproduces it on a
 * fresh database). Code treats every one of these as an integer, so it fails:
 *
 *   routine_streaks.current_streak / best_streak   text         -> "text = integer"
 *     (NODE-EXPRESS-A, GET /api/buddy-widget/context; also home-context, and
 *      `current_streak + 1` in db/routineNudges.js concatenates strings)
 *   routine_suggestions.presented_count            timestamptz  -> "timestamptz >= integer"
 *     (NODE-EXPRESS-8, pattern-detection cron)
 *   routines.day_of_week                           text         (written as 0-6)
 *   task_substeps.step_order                       text         (written as 1..n)
 *   weekly_stats.tasks_completed / tasks_created /
 *     evening_sessions_completed / routines_completed  boolean / timestamptz
 *   weekly_stats.streak_days                       text         (db/insights.js writes counts)
 *
 * Checked against production on 2026-10-14: all five tables were empty, so no
 * value is lost. Idempotent: each column is converted only while it still has the
 * wrong type. Values that can't be read as an integer become NULL.
 */

// [table, column, default or null]
const COLUMNS = [
  ['routine_streaks', 'current_streak', 0],
  ['routine_streaks', 'best_streak', 0],
  ['routine_suggestions', 'presented_count', 0],
  ['routines', 'day_of_week', null],
  ['task_substeps', 'step_order', null],
  ['weekly_stats', 'tasks_completed', 0],
  ['weekly_stats', 'tasks_created', 0],
  ['weekly_stats', 'evening_sessions_completed', 0],
  ['weekly_stats', 'routines_completed', 0],
  ['weekly_stats', 'streak_days', 0],
];

function usingExpr(column, dataType) {
  if (dataType === 'text' || dataType === 'character varying') {
    return `CASE WHEN btrim(${column}) ~ '^-?[0-9]+$' THEN btrim(${column})::integer END`;
  }
  if (dataType === 'boolean') return `${column}::integer`;
  // timestamps and anything else carry no meaningful count
  return 'NULL::integer';
}

module.exports = {
  name: 'counter_columns_integer',

  up: async (client) => {
    for (const [table, column, dflt] of COLUMNS) {
      const { rows } = await client.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      if (!rows[0] || rows[0].data_type === 'integer') continue;
      await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
      await client.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE INTEGER USING ${usingExpr(column, rows[0].data_type)}`
      );
      if (dflt !== null) {
        await client.query(`UPDATE ${table} SET ${column} = ${dflt} WHERE ${column} IS NULL`);
        await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${dflt}`);
      }
      console.log(`[migrate] ${table}.${column}: ${rows[0].data_type} -> integer`);
    }
  },

  down: async () => {
    // Not reverted: the old types break every reader and writer of these columns.
  },
};
