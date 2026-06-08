'use strict';
/**
 * Add recurrence_type + recurrence_day to tasks, and any other columns
 * in the Prisma schema that may not exist in the actual Neon DB.
 * Uses ADD COLUMN IF NOT EXISTS so it is safe to re-run.
 */
module.exports = {
  name: 'add_recurrence_and_missing_task_columns',

  up: async (client) => {
    // -- tasks table: columns added after initial schema ----------------------
    await client.query(`
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS recurrence_type   VARCHAR(20) DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS recurrence_day    INT,
        ADD COLUMN IF NOT EXISTS is_household      BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_shared_with_partner BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS duration_minutes  INT,
        ADD COLUMN IF NOT EXISTS duration_source   VARCHAR(20),
        ADD COLUMN IF NOT EXISTS value_id          INT,
        ADD COLUMN IF NOT EXISTS recurring_task_id INT,
        ADD COLUMN IF NOT EXISTS bill_merchant_key VARCHAR(255),
        ADD COLUMN IF NOT EXISTS bill_type         VARCHAR(50),
        ADD COLUMN IF NOT EXISTS merchant_hint     VARCHAR(255),
        ADD COLUMN IF NOT EXISTS expected_amount   NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS auto_complete_note TEXT,
        ADD COLUMN IF NOT EXISTS auto_complete_transaction_id INT
    `);

    // -- morning_streaks: created by Prisma schema but may not exist ----------
    await client.query(`
      CREATE TABLE IF NOT EXISTS morning_streaks (
        id                  SERIAL PRIMARY KEY,
        user_id             INT NOT NULL UNIQUE,
        current_streak      INT NOT NULL DEFAULT 0,
        longest_streak      INT NOT NULL DEFAULT 0,
        last_completed_date DATE,
        grace_day_available BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // -- morning_sessions & morning_task_events: needed for streak tracking ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS morning_sessions (
        id              SERIAL PRIMARY KEY,
        user_id         INT NOT NULL,
        session_date    DATE NOT NULL,
        tasks_completed INT NOT NULL DEFAULT 0,
        tasks_skipped   INT NOT NULL DEFAULT 0,
        completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, session_date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS morning_task_events (
        id           SERIAL PRIMARY KEY,
        user_id      INT NOT NULL,
        task_id      INT,
        event_type   VARCHAR(20) NOT NULL,
        session_date DATE NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // -- task_substeps: AI "I'm stuck" micro-steps (used in re-entry brief) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_substeps (
        id           SERIAL PRIMARY KEY,
        task_id      INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        is_completed BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order   INT NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // -- focus_sessions: Focus Mode deep-work sessions -------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS focus_sessions (
        id                       SERIAL PRIMARY KEY,
        task_id                  INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id                  INT NOT NULL,
        planned_duration_seconds INT,
        actual_duration_seconds  INT,
        completed                BOOLEAN NOT NULL DEFAULT FALSE,
        started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at                 TIMESTAMPTZ
      )
    `);

    // -- user_focus_prefs: Body Double + Ambient Layer preferences -------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_focus_prefs (
        id                  SERIAL PRIMARY KEY,
        user_id             INT NOT NULL UNIQUE,
        body_double_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ambient_style       VARCHAR(20) NOT NULL DEFAULT 'cafe',
        ambient_volume      INT NOT NULL DEFAULT 50
      )
    `);
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE tasks
        DROP COLUMN IF EXISTS recurrence_type,
        DROP COLUMN IF EXISTS recurrence_day,
        DROP COLUMN IF EXISTS is_household,
        DROP COLUMN IF EXISTS is_shared_with_partner,
        DROP COLUMN IF EXISTS duration_minutes,
        DROP COLUMN IF EXISTS duration_source,
        DROP COLUMN IF EXISTS value_id,
        DROP COLUMN IF EXISTS recurring_task_id,
        DROP COLUMN IF EXISTS bill_merchant_key,
        DROP COLUMN IF EXISTS bill_type,
        DROP COLUMN IF EXISTS merchant_hint,
        DROP COLUMN IF EXISTS expected_amount,
        DROP COLUMN IF EXISTS auto_complete_note,
        DROP COLUMN IF EXISTS auto_complete_transaction_id
    `);
  },
};
