'use strict';
/**
 * Migration status for /health — answers the question that actually matters
 * ("is every migration this code expects recorded as applied?") instead of
 * showing the newest applied_at, which reads like staleness whenever no NEW
 * migration has been added for a while.
 */
const { expectedMigrationNames } = require('../lib/migration-manifest');

/**
 * @returns {Promise<{
 *   up_to_date: boolean, expected: number, applied: number,
 *   pending: string[], recorded_total: number, last_recorded_at: string|null
 * }>}
 * Throws on unexpected DB errors (caller decides how to report).
 */
async function getMigrationStatus(pool) {
  const expected = expectedMigrationNames();
  let rows;
  try {
    ({ rows } = await pool.query('SELECT name, applied_at FROM _migrations'));
  } catch (err) {
    if (err.code === '42P01') { // undefined_table: fresh DB, migrate.js never ran
      return {
        up_to_date: false, expected: expected.length, applied: 0,
        pending: expected, recorded_total: 0, last_recorded_at: null,
      };
    }
    throw err;
  }

  const recorded = new Set(rows.map(r => r.name));
  const pending = expected.filter(n => !recorded.has(n));
  let last = null;
  for (const r of rows) {
    if (r.applied_at && (!last || r.applied_at > last)) last = r.applied_at;
  }

  return {
    up_to_date: pending.length === 0,
    expected: expected.length,
    applied: expected.length - pending.length,
    pending,
    // Includes legacy names from before the migrations/ folder was renumbered,
    // so it's expected to exceed `expected`.
    recorded_total: rows.length,
    last_recorded_at: last ? new Date(last).toISOString() : null,
  };
}

module.exports = { getMigrationStatus };
