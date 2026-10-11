'use strict';
/**
 * bill_preferences.kept_at: when the user reviewed a subscription and chose to
 * keep it. Weightless stops offering the cancel/keep review for 90 days after,
 * then asks again (forgotten subscriptions are the ADHD tax). NULL = never kept.
 */
module.exports = {
  name: 'bill_preferences_kept_at',

  up: async (client) => {
    await client.query('ALTER TABLE bill_preferences ADD COLUMN IF NOT EXISTS kept_at TIMESTAMPTZ');
  },

  down: async (client) => {
    await client.query('ALTER TABLE bill_preferences DROP COLUMN IF EXISTS kept_at');
  },
};
