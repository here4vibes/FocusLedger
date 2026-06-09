'use strict';
/**
 * Ensure the tasks table exists with all base columns.
 * Safe to re-run: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
 * This covers deployments where the table predates some columns.
 */
module.exports = {
  name: 'ensure_tasks_base_columns',

  up: async (client) => {
    // Create tasks table if it somehow doesn't exist yet
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id           SERIAL PRIMARY KEY,
        user_id      INT NOT NULL,
        title        VARCHAR(500) NOT NULL,
        is_completed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Add columns that may be missing from older deploys
    await client.query(`
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS description  TEXT,
        ADD COLUMN IF NOT EXISTS priority     VARCHAR(20) NOT NULL DEFAULT 'medium',
        ADD COLUMN IF NOT EXISTS source       VARCHAR(50),
        ADD COLUMN IF NOT EXISTS notes        TEXT,
        ADD COLUMN IF NOT EXISTS due_date     DATE,
        ADD COLUMN IF NOT EXISTS due_time     TIME,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_user_completed ON tasks (user_id, is_completed)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_user_due       ON tasks (user_id, due_date)`);

    // Add primary key if missing — required for GROUP BY t.id to work with SELECT t.*
    // Safe: DO block checks pg_constraint before trying to add
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'tasks'::regclass AND contype = 'p'
        ) THEN
          ALTER TABLE tasks ADD PRIMARY KEY (id);
        END IF;
      END$$
    `);
  },
};
