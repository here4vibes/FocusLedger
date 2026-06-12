'use strict';
/**
 * Repair buddy_midday_checkins to match what buddy.js actually uses.
 *
 * Prisma created the table with:
 *   - 'date' (not 'checkin_date')
 *   - 'type' (not 'checkin_type')
 *   - no 'plan_id' column
 *   - UNIQUE(user_id, date, type)
 *
 * Production code uses:
 *   checkin_date DATE, checkin_type VARCHAR, plan_id INT, response JSONB
 *   SELECT WHERE checkin_date = $2 AND checkin_type = $3
 *
 * This migration is fully idempotent.
 */

module.exports = {
  name: 'fix_buddy_midday_checkins_schema',

  up: async (client) => {
    // ── 1. Create table from scratch if it doesn't exist at all ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS buddy_midday_checkins (
        id           SERIAL PRIMARY KEY,
        user_id      INT  NOT NULL,
        checkin_date DATE NOT NULL,
        checkin_type VARCHAR(50) NOT NULL,
        plan_id      INT,
        response     JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── 2. Rename 'date' → 'checkin_date' if Prisma column present ────────────
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_midday_checkins' AND column_name = 'date'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_midday_checkins' AND column_name = 'checkin_date'
        ) THEN
          ALTER TABLE buddy_midday_checkins RENAME COLUMN "date" TO checkin_date;
        END IF;
      END $$
    `);

    // ── 3. Rename 'type' → 'checkin_type' if Prisma column present ────────────
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_midday_checkins' AND column_name = 'type'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_midday_checkins' AND column_name = 'checkin_type'
        ) THEN
          ALTER TABLE buddy_midday_checkins RENAME COLUMN "type" TO checkin_type;
        END IF;
      END $$
    `);

    // ── 4. Add missing columns ─────────────────────────────────────────────────
    await client.query(`
      ALTER TABLE buddy_midday_checkins
        ADD COLUMN IF NOT EXISTS checkin_date DATE,
        ADD COLUMN IF NOT EXISTS checkin_type VARCHAR(50),
        ADD COLUMN IF NOT EXISTS plan_id      INT
    `);

    console.log('[migration] fix_buddy_midday_checkins_schema: done');
  },
};
