'use strict';
/**
 * bill_preferences.bucket: the user's remembered answer for a recurring
 * merchant: 'obligation' (remind me), 'subscription' or 'habit' (don't).
 * See lib/bill-guardian.js. NULL = not asked yet.
 */
module.exports = {
  name: 'bill_preferences_bucket',

  up: async (client) => {
    await client.query('ALTER TABLE bill_preferences ADD COLUMN IF NOT EXISTS bucket TEXT');
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bill_preferences_bucket_check') THEN
          ALTER TABLE bill_preferences ADD CONSTRAINT bill_preferences_bucket_check
            CHECK (bucket IS NULL OR bucket IN ('obligation', 'subscription', 'habit'));
        END IF;
      END $$`);
  },

  down: async (client) => {
    await client.query('ALTER TABLE bill_preferences DROP CONSTRAINT IF EXISTS bill_preferences_bucket_check');
    await client.query('ALTER TABLE bill_preferences DROP COLUMN IF EXISTS bucket');
  },
};
