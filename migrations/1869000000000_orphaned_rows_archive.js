'use strict';
/**
 * Archive for rows that lost their owner.
 *
 * While signups were broken (~May 29 – Oct 8 2026, users.id had no default),
 * new accounts had id = NULL, so everything they created was saved with
 * user_id = NULL: 44 tasks, 10 Buddy messages, 3 expenses, 6 subscription
 * rows. No one can see them and they can't be attributed reliably, but they
 * still inflate global counts. They are moved here whole (row_data = the full
 * row as JSONB), not deleted, so any of them can be restored exactly.
 */
module.exports = {
  name: 'orphaned_rows_archive',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orphaned_rows_archive (
        id SERIAL PRIMARY KEY,
        source_table TEXT NOT NULL,
        row_data JSONB NOT NULL,
        reason TEXT,
        archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS orphaned_rows_archive_source_idx ON orphaned_rows_archive (source_table)');
  },

  down: async () => {
    // Kept: dropping it would destroy the archived rows.
  },
};
