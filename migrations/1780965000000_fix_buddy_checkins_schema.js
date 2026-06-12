'use strict';
/**
 * Repair buddy_checkins table to match what buddy.js/evening-checkin.js actually use.
 *
 * Prisma created the table with:
 *   - 'date' (not 'checkin_date')
 *   - 'type' (not 'checkin_type')
 *   - 'mood' INT (not used by code)
 *   - 'response' JSONB (not used by code)
 *   - UNIQUE(user_id, date, type)
 *
 * Production code inserts/reads:
 *   checkin_date DATE, checkin_type VARCHAR,
 *   selected_task_id INT, tasks_completed INT, tasks_open INT,
 *   energy_level VARCHAR, blocks_text TEXT,
 *   tasks_completed_today INT, routines_kept_today INT,
 *   documents_handled INT, money_tasks_done INT
 *   ON CONFLICT (user_id, checkin_date, checkin_type)
 *
 * This migration is fully idempotent.
 */

module.exports = {
  name: 'fix_buddy_checkins_schema',

  up: async (client) => {
    // ── 1. Create table from scratch if it doesn't exist at all ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS buddy_checkins (
        id                   SERIAL PRIMARY KEY,
        user_id              INT  NOT NULL,
        checkin_date         DATE NOT NULL,
        checkin_type         VARCHAR(50) NOT NULL,
        selected_task_id     INT,
        tasks_completed      INT NOT NULL DEFAULT 0,
        tasks_open           INT NOT NULL DEFAULT 0,
        energy_level         VARCHAR(50),
        blocks_text          TEXT,
        tasks_completed_today INT,
        routines_kept_today  INT,
        documents_handled    INT,
        money_tasks_done     INT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, checkin_date, checkin_type)
      )
    `);

    // ── 2. Rename 'date' → 'checkin_date' if Prisma-era column name present ──
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_checkins' AND column_name = 'date'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_checkins' AND column_name = 'checkin_date'
        ) THEN
          ALTER TABLE buddy_checkins RENAME COLUMN "date" TO checkin_date;
        END IF;
      END $$
    `);

    // ── 3. Rename 'type' → 'checkin_type' if Prisma-era column name present ──
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_checkins' AND column_name = 'type'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'buddy_checkins' AND column_name = 'checkin_type'
        ) THEN
          ALTER TABLE buddy_checkins RENAME COLUMN "type" TO checkin_type;
        END IF;
      END $$
    `);

    // ── 4. Add missing columns ─────────────────────────────────────────────────
    await client.query(`
      ALTER TABLE buddy_checkins
        ADD COLUMN IF NOT EXISTS checkin_date         DATE,
        ADD COLUMN IF NOT EXISTS checkin_type         VARCHAR(50),
        ADD COLUMN IF NOT EXISTS selected_task_id     INT,
        ADD COLUMN IF NOT EXISTS tasks_completed      INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tasks_open           INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS energy_level         VARCHAR(50),
        ADD COLUMN IF NOT EXISTS blocks_text          TEXT,
        ADD COLUMN IF NOT EXISTS tasks_completed_today INT,
        ADD COLUMN IF NOT EXISTS routines_kept_today  INT,
        ADD COLUMN IF NOT EXISTS documents_handled    INT,
        ADD COLUMN IF NOT EXISTS money_tasks_done     INT
    `);

    // ── 5. Ensure UNIQUE(user_id, checkin_date, checkin_type) ─────────────────
    await client.query(`
      DO $$
      DECLARE
        uid_num smallint;
        cdate_num smallint;
        ctype_num smallint;
      BEGIN
        SELECT attnum INTO uid_num FROM pg_attribute
          WHERE attrelid = 'buddy_checkins'::regclass AND attname = 'user_id';
        SELECT attnum INTO cdate_num FROM pg_attribute
          WHERE attrelid = 'buddy_checkins'::regclass AND attname = 'checkin_date';
        SELECT attnum INTO ctype_num FROM pg_attribute
          WHERE attrelid = 'buddy_checkins'::regclass AND attname = 'checkin_type';

        IF uid_num IS NOT NULL AND cdate_num IS NOT NULL AND ctype_num IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = 'buddy_checkins'::regclass
              AND c.contype = 'u'
              AND c.conkey @> ARRAY[uid_num, cdate_num, ctype_num]::smallint[]
          )
        THEN
          -- Deduplicate rows before adding constraint
          DELETE FROM buddy_checkins a
          USING buddy_checkins b
          WHERE a.id < b.id
            AND a.user_id = b.user_id
            AND a.checkin_date IS NOT DISTINCT FROM b.checkin_date
            AND a.checkin_type IS NOT DISTINCT FROM b.checkin_type;

          BEGIN
            ALTER TABLE buddy_checkins
              ADD CONSTRAINT buddy_checkins_user_checkin_date_type_key
              UNIQUE (user_id, checkin_date, checkin_type);
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$
    `);

    // ── 6. Drop old UNIQUE constraint on (user_id, date, type) if still present
    await client.query(`
      DO $$
      BEGIN
        -- Drop Prisma-era constraint name if it exists (noop if already gone)
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'buddy_checkins'::regclass
            AND conname = 'buddy_checkins_user_id_date_type_key'
        ) THEN
          ALTER TABLE buddy_checkins
            DROP CONSTRAINT buddy_checkins_user_id_date_type_key;
        END IF;
      END $$
    `);

    console.log('[migration] fix_buddy_checkins_schema: done');
  },
};
