'use strict';
/**
 * Add gcal_event_id and source columns to time_blocks for Google Calendar sync.
 * gcal_event_id is used for deduplication ON CONFLICT.
 * source distinguishes 'manual' from 'gcal' blocks (manual is default).
 */
module.exports = {
  name: 'add_gcal_columns_to_time_blocks',

  up: async (client) => {
    await client.query(`
      ALTER TABLE time_blocks
        ADD COLUMN IF NOT EXISTS source        VARCHAR(20) NOT NULL DEFAULT 'manual',
        ADD COLUMN IF NOT EXISTS gcal_event_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS start_time    VARCHAR(10),
        ADD COLUMN IF NOT EXISTS end_time      VARCHAR(10)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS time_blocks_gcal_event_id_user_unique
        ON time_blocks (user_id, gcal_event_id)
        WHERE gcal_event_id IS NOT NULL
    `);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS time_blocks_gcal_event_id_user_unique`);
    await client.query(`
      ALTER TABLE time_blocks
        DROP COLUMN IF EXISTS source,
        DROP COLUMN IF EXISTS gcal_event_id,
        DROP COLUMN IF EXISTS start_time,
        DROP COLUMN IF EXISTS end_time
    `);
  },
};
