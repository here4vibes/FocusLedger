'use strict';
/**
 * Two dedup fixes for tables where Prisma-era UNIQUE constraints may be missing:
 *
 * 1. buddy_midday_checkins — the fix_buddy_midday_checkins_schema migration
 *    renamed 'date'→'checkin_date' and 'type'→'checkin_type' but never ensured
 *    a UNIQUE(user_id, checkin_date, checkin_type) constraint exists.
 *    In production the Prisma-era constraint survives the rename (PostgreSQL tracks
 *    by attnum not name), but a fresh-install DB has no constraint at all and
 *    ON CONFLICT DO NOTHING in buddy.js:726 silently allows duplicate rows.
 *
 * 2. detected_patterns — the upsertDetectedPattern helper computes a task_hash
 *    for dedup but never stores it or uses it in ON CONFLICT, so every cron run
 *    can insert duplicate patterns for the same user+type+task set.
 *    Fix: add task_hash TEXT column + UNIQUE(user_id, pattern_type, task_hash).
 */

module.exports = {
  name: 'fix_midday_checkins_and_patterns_dedup',

  up: async (client) => {

    // ── 1. buddy_midday_checkins — ensure UNIQUE(user_id, checkin_date, checkin_type)
    await client.query(`
      DO $$
      DECLARE
        uid_num    smallint;
        cdate_num  smallint;
        ctype_num  smallint;
      BEGIN
        SELECT attnum INTO uid_num FROM pg_attribute
          WHERE attrelid = 'buddy_midday_checkins'::regclass AND attname = 'user_id';
        SELECT attnum INTO cdate_num FROM pg_attribute
          WHERE attrelid = 'buddy_midday_checkins'::regclass AND attname = 'checkin_date';
        SELECT attnum INTO ctype_num FROM pg_attribute
          WHERE attrelid = 'buddy_midday_checkins'::regclass AND attname = 'checkin_type';

        IF uid_num IS NOT NULL AND cdate_num IS NOT NULL AND ctype_num IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = 'buddy_midday_checkins'::regclass
              AND c.contype = 'u'
              AND c.conkey @> ARRAY[uid_num, cdate_num, ctype_num]::smallint[]
          )
        THEN
          -- Remove duplicate rows before adding constraint (keep newest)
          DELETE FROM buddy_midday_checkins a
          USING buddy_midday_checkins b
          WHERE a.id < b.id
            AND a.user_id = b.user_id
            AND a.checkin_date IS NOT DISTINCT FROM b.checkin_date
            AND a.checkin_type IS NOT DISTINCT FROM b.checkin_type;

          BEGIN
            ALTER TABLE buddy_midday_checkins
              ADD CONSTRAINT buddy_midday_checkins_user_date_type_key
              UNIQUE (user_id, checkin_date, checkin_type);
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$
    `);

    // ── 2. detected_patterns — add task_hash column + UNIQUE constraint
    await client.query(`
      ALTER TABLE detected_patterns
        ADD COLUMN IF NOT EXISTS task_hash TEXT NOT NULL DEFAULT ''
    `);

    // Backfill task_hash from existing pattern_data for any rows without it.
    // In production pattern_data is TEXT (Prisma-era), not JSONB — the `?` and
    // `->` operators fail with "operator does not exist: text ? unknown". Detect
    // the column type and cast when needed; if any row holds invalid JSON, skip
    // the backfill (patterns are regenerated weekly by cron) rather than abort.
    await client.query(`
      DO $$
      DECLARE
        coltype text;
      BEGIN
        SELECT data_type INTO coltype
        FROM information_schema.columns
        WHERE table_name = 'detected_patterns' AND column_name = 'pattern_data';

        IF coltype = 'jsonb' THEN
          UPDATE detected_patterns
          SET task_hash = COALESCE(
            (SELECT string_agg(elem::text, ',' ORDER BY elem::text)
             FROM jsonb_array_elements(pattern_data->'task_ids') AS elem),
            ''
          )
          WHERE task_hash = ''
            AND pattern_data ? 'task_ids';
        ELSIF coltype IS NOT NULL THEN
          BEGIN
            UPDATE detected_patterns
            SET task_hash = COALESCE(
              (SELECT string_agg(elem::text, ',' ORDER BY elem::text)
               FROM jsonb_array_elements((pattern_data::jsonb)->'task_ids') AS elem),
              ''
            )
            WHERE task_hash = ''
              AND pattern_data IS NOT NULL;
          EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'task_hash backfill skipped (non-JSON pattern_data): %', SQLERRM;
          END;
        END IF;
      END $$
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'detected_patterns'::regclass
            AND conname = 'detected_patterns_user_type_hash_key'
        ) THEN
          -- Remove duplicate rows before adding constraint (keep newest)
          DELETE FROM detected_patterns a
          USING detected_patterns b
          WHERE a.id < b.id
            AND a.user_id = b.user_id
            AND a.pattern_type = b.pattern_type
            AND a.task_hash = b.task_hash;

          BEGIN
            ALTER TABLE detected_patterns
              ADD CONSTRAINT detected_patterns_user_type_hash_key
              UNIQUE (user_id, pattern_type, task_hash);
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$
    `);

    console.log('[migration] fix_midday_checkins_and_patterns_dedup: done');
  },
};
