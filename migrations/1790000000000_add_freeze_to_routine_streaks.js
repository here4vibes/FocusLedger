'use strict';
/**
 * Streak-freeze: forgive the first missed day so one slip doesn't nuke a streak.
 *
 * ADHD users churn hardest when a single missed day resets a hard-won streak to
 * zero — the shame spiral that follows is the real cause of abandonment, not the
 * missed day itself. A "freeze" auto-forgives one gap day and keeps the streak
 * alive, replenishing every 7 consecutive completions.
 *
 * routine_streaks is a legacy Prisma-managed table with no canonical CREATE TABLE
 * in migrations/, so this uses ADD COLUMN IF NOT EXISTS (safe to re-run).
 */
module.exports = {
  name: 'add_freeze_to_routine_streaks',

  up: async (client) => {
    await client.query(`
      ALTER TABLE routine_streaks
        ADD COLUMN IF NOT EXISTS freeze_available     BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS last_freeze_used_date DATE
    `);
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE routine_streaks
        DROP COLUMN IF EXISTS freeze_available,
        DROP COLUMN IF EXISTS last_freeze_used_date
    `);
  },
};
