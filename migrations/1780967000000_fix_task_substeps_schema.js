'use strict';
/**
 * Repair task_substeps to match what db/substeps.js actually uses.
 *
 * Prisma created the table with:
 *   - 'title' (not 'step_text')
 *   - 'sort_order' (not 'step_order')
 *   - 'is_completed' BOOLEAN (not 'completed')
 *   - NO 'user_id' column
 *   - NO 'completed_at' column
 *
 * db/substeps.js uses:
 *   step_text TEXT, step_order INT, completed BOOLEAN,
 *   user_id INT (for security WHERE clause), completed_at TIMESTAMPTZ
 *
 * Strategy: keep existing Prisma columns intact and add the new columns that
 * code expects, backfilling data from the Prisma columns where applicable.
 * This avoids data loss and keeps tasks-prisma.js (which uses the Prisma names)
 * working alongside db/substeps.js (which uses the production names).
 *
 * This migration is fully idempotent.
 */

module.exports = {
  name: 'fix_task_substeps_schema',

  up: async (client) => {
    // ── 1. Create table from scratch if it doesn't exist at all ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_substeps (
        id           SERIAL PRIMARY KEY,
        task_id      INT  NOT NULL,
        user_id      INT,
        step_text    TEXT NOT NULL,
        step_order   INT  NOT NULL DEFAULT 0,
        completed    BOOLEAN NOT NULL DEFAULT false,
        completed_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── 2. Add user_id if missing ──────────────────────────────────────────────
    await client.query(`
      ALTER TABLE task_substeps ADD COLUMN IF NOT EXISTS user_id INT
    `);

    // ── 3. Add step_text if missing; backfill from title ──────────────────────
    await client.query(`
      ALTER TABLE task_substeps ADD COLUMN IF NOT EXISTS step_text TEXT
    `);
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'task_substeps' AND column_name = 'title'
        ) THEN
          UPDATE task_substeps SET step_text = title WHERE step_text IS NULL AND title IS NOT NULL;
        END IF;
      END $$
    `);

    // ── 4. Add step_order if missing; backfill from sort_order ────────────────
    await client.query(`
      ALTER TABLE task_substeps ADD COLUMN IF NOT EXISTS step_order INT NOT NULL DEFAULT 0
    `);
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'task_substeps' AND column_name = 'sort_order'
        ) THEN
          UPDATE task_substeps SET step_order = sort_order WHERE step_order = 0 AND sort_order IS NOT NULL;
        END IF;
      END $$
    `);

    // ── 5. Add completed if missing; backfill from is_completed ───────────────
    await client.query(`
      ALTER TABLE task_substeps ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT false
    `);
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'task_substeps' AND column_name = 'is_completed'
        ) THEN
          UPDATE task_substeps SET completed = is_completed WHERE is_completed IS NOT NULL;
        END IF;
      END $$
    `);

    // ── 6. Add completed_at if missing ────────────────────────────────────────
    await client.query(`
      ALTER TABLE task_substeps ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
    `);

    // ── 7. Backfill user_id from parent tasks table ────────────────────────────
    // Only fills rows where user_id is NULL and the task still exists
    await client.query(`
      UPDATE task_substeps ts
      SET user_id = t.user_id
      FROM tasks t
      WHERE ts.task_id = t.id
        AND ts.user_id IS NULL
    `);

    console.log('[migration] fix_task_substeps_schema: done');
  },
};
