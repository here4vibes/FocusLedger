'use strict';
/**
 * Repair buddy_daily_plans table to match what buddy.js actually needs.
 *
 * The table was originally created via Prisma with a different schema:
 *   - column named 'date' (not 'plan_date')
 *   - mood as INT (not VARCHAR)
 *   - plan_json JSONB instead of individual task_N_id / task_N_reason columns
 *   - unique constraint on (user_id, date)
 *
 * All production SQL in buddy.js uses: plan_date DATE, mood VARCHAR,
 * task_1_id/task_2_id/task_3_id INT, task_1_reason/… TEXT, tasks_completed INT,
 * accepted BOOLEAN, and ON CONFLICT (user_id, plan_date).
 *
 * This migration is fully idempotent.
 */

module.exports = {
  name: 'fix_buddy_daily_plans_schema',

  up: async (client) => {
    // ── 1. Create table from scratch if it doesn't exist at all ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS buddy_daily_plans (
        id             SERIAL PRIMARY KEY,
        user_id        INT  NOT NULL,
        plan_date      DATE NOT NULL,
        mood           VARCHAR(50),
        task_1_id      INT,
        task_1_reason  TEXT,
        task_2_id      INT,
        task_2_reason  TEXT,
        task_3_id      INT,
        task_3_reason  TEXT,
        accepted       BOOLEAN NOT NULL DEFAULT false,
        tasks_completed INT    NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, plan_date)
      )
    `);

    // ── 2. Rename 'date' → 'plan_date' if the Prisma-era column name is present ─
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_daily_plans' AND column_name = 'date'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_daily_plans' AND column_name = 'plan_date'
        ) THEN
          ALTER TABLE buddy_daily_plans RENAME COLUMN "date" TO plan_date;
        END IF;
      END $$
    `);

    // ── 3. Ensure plan_date exists (in case neither branch above applied) ──────
    await client.query(`
      ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS plan_date DATE
    `);

    // ── 4. Fix mood column: Prisma schema defined it as INT, we need VARCHAR ───
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_daily_plans'
            AND column_name = 'mood'
            AND data_type IN ('integer', 'bigint', 'smallint')
        ) THEN
          -- Prisma created mood as INT NOT NULL — drop the constraint before
          -- changing the type, otherwise USING NULL violates the NOT NULL check.
          ALTER TABLE buddy_daily_plans ALTER COLUMN mood DROP NOT NULL;
          ALTER TABLE buddy_daily_plans ALTER COLUMN mood DROP DEFAULT;
          ALTER TABLE buddy_daily_plans ALTER COLUMN mood TYPE VARCHAR(50) USING NULL;
        END IF;
      END $$
    `);
    await client.query(`
      ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS mood VARCHAR(50)
    `);

    // ── 5. Add individual task-slot columns (were missing when table used plan_json) ─
    await client.query(`
      ALTER TABLE buddy_daily_plans
        ADD COLUMN IF NOT EXISTS task_1_id      INT,
        ADD COLUMN IF NOT EXISTS task_1_reason  TEXT,
        ADD COLUMN IF NOT EXISTS task_2_id      INT,
        ADD COLUMN IF NOT EXISTS task_2_reason  TEXT,
        ADD COLUMN IF NOT EXISTS task_3_id      INT,
        ADD COLUMN IF NOT EXISTS task_3_reason  TEXT,
        ADD COLUMN IF NOT EXISTS tasks_completed INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS accepted       BOOLEAN NOT NULL DEFAULT false
    `);

    // ── 6. Ensure UNIQUE(user_id, plan_date) exists for ON CONFLICT clause ─────
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conrelid = 'buddy_daily_plans'::regclass
            AND c.contype = 'u'
            AND c.conkey @> ARRAY[
              (SELECT attnum FROM pg_attribute
               WHERE attrelid = 'buddy_daily_plans'::regclass AND attname = 'user_id'),
              (SELECT attnum FROM pg_attribute
               WHERE attrelid = 'buddy_daily_plans'::regclass AND attname = 'plan_date')
            ]::smallint[]
        ) THEN
          -- Deduplicate before constraining
          DELETE FROM buddy_daily_plans a
          USING buddy_daily_plans b
          WHERE a.id < b.id
            AND a.user_id = b.user_id
            AND a.plan_date IS NOT DISTINCT FROM b.plan_date;

          BEGIN
            ALTER TABLE buddy_daily_plans
              ADD CONSTRAINT buddy_daily_plans_user_id_plan_date_key
              UNIQUE (user_id, plan_date);
          EXCEPTION WHEN duplicate_object THEN
            NULL; -- already exists under another name, that's fine
          END;
        END IF;
      END $$
    `);

    console.log('[migration] fix_buddy_daily_plans_schema: done');
  },

  // No safe down() — column renames and type changes cannot be auto-reversed
  // without data loss. Restore from a DB snapshot if a rollback is needed.
  down: async (_client) => {},
};
