'use strict';
/**
 * Subscription review state on bill_preferences (Weightless bills card):
 *   kept_at              user reviewed it and is keeping it; the review rests 90 days
 *   cancel_requested_at  user tapped "Cancel it"
 *   cancel_expected_by   the predicted next charge at that moment
 *   cancel_amount        typical charge (NUMERIC money), for "saving ~$X/yr"
 *   cancel_frequency     monthly / weekly / ... (for the yearly figure + grace period)
 *   cancel_status        pending -> confirmed (no charge after the expected date)
 *                        or charged_again (a charge landed after the request);
 *                        decided by lib/bill-guardian.js from bank data, never assumed
 *   cancel_resolved_at   when the status left 'pending'
 */
module.exports = {
  name: 'bill_preferences_review',

  up: async (client) => {
    await client.query(`
      ALTER TABLE bill_preferences
        ADD COLUMN IF NOT EXISTS kept_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS cancel_expected_by DATE,
        ADD COLUMN IF NOT EXISTS cancel_amount NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS cancel_frequency TEXT,
        ADD COLUMN IF NOT EXISTS cancel_status TEXT,
        ADD COLUMN IF NOT EXISTS cancel_resolved_at TIMESTAMPTZ`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bill_preferences_cancel_status_check') THEN
          ALTER TABLE bill_preferences ADD CONSTRAINT bill_preferences_cancel_status_check
            CHECK (cancel_status IS NULL OR cancel_status IN ('pending', 'confirmed', 'charged_again'));
        END IF;
      END $$`);
  },

  down: async (client) => {
    await client.query('ALTER TABLE bill_preferences DROP CONSTRAINT IF EXISTS bill_preferences_cancel_status_check');
    await client.query(`
      ALTER TABLE bill_preferences
        DROP COLUMN IF EXISTS cancel_resolved_at,
        DROP COLUMN IF EXISTS cancel_status,
        DROP COLUMN IF EXISTS cancel_frequency,
        DROP COLUMN IF EXISTS cancel_amount,
        DROP COLUMN IF EXISTS cancel_expected_by,
        DROP COLUMN IF EXISTS cancel_requested_at,
        DROP COLUMN IF EXISTS kept_at`);
  },
};
