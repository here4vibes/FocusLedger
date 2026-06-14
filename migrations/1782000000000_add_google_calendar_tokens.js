'use strict';
/**
 * Add Google Calendar OAuth token columns to users table.
 * Separate from the login Google OAuth — this stores the calendar.readonly
 * refresh token obtained from the "Connect Google Calendar" flow.
 */
module.exports = {
  name: 'add_google_calendar_tokens',

  up: async (client) => {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS gcal_access_token  TEXT,
        ADD COLUMN IF NOT EXISTS gcal_refresh_token TEXT,
        ADD COLUMN IF NOT EXISTS gcal_token_expiry  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS gcal_synced_at     TIMESTAMPTZ
    `);
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS gcal_access_token,
        DROP COLUMN IF EXISTS gcal_refresh_token,
        DROP COLUMN IF EXISTS gcal_token_expiry,
        DROP COLUMN IF EXISTS gcal_synced_at
    `);
  },
};
