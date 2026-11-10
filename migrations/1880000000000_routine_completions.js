'use strict';
/**
 * routine_completions: one row per routine per local day it was completed.
 *
 * routine_streaks keeps only last_completed_date, so the history needed for
 * the habit-strength score (lib/habit-strength.js) wasn't stored anywhere.
 * Written by recordRoutineCompletion (db/routineNudges.js), which both the
 * task-tick path (lib/routine-capture.js onTasksCompleted) and
 * POST /api/routines/:id/complete go through.
 *
 * Every column the INSERT omits has a default (prod-schema trap: genesis was
 * generated from a catalog where many columns had none). The unique key backs
 * the ON CONFLICT (routine_id, local_date) DO NOTHING in the writer.
 *
 * Backfill: each existing streak's last_completed_date (the only past
 * completion we actually know). Earlier days aren't invented. Idempotent.
 */
module.exports = {
  name: 'routine_completions',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS routine_completions (
        id         SERIAL      PRIMARY KEY,
        routine_id INTEGER     NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        local_date DATE        NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT routine_completions_routine_date_key UNIQUE (routine_id, local_date)
      )`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS routine_completions_user_date_idx
        ON routine_completions (user_id, local_date)`);
    await client.query(`
      INSERT INTO routine_completions (routine_id, user_id, local_date)
      SELECT rs.routine_id, r.user_id, rs.last_completed_date
      FROM routine_streaks rs
      JOIN routines r ON r.id = rs.routine_id
      JOIN users u ON u.id = r.user_id
      WHERE rs.last_completed_date IS NOT NULL
      ON CONFLICT (routine_id, local_date) DO NOTHING`);
  },

  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS routine_completions');
  },
};
