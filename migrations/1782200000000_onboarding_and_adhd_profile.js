'use strict';
module.exports = {
  name: 'onboarding_and_adhd_profile',
  up: async (client) => {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS adhd_profile JSONB NOT NULL DEFAULT '{}'
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS onboarding_completed_at,
        DROP COLUMN IF EXISTS adhd_profile
    `);
  },
};
