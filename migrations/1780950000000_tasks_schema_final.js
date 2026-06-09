'use strict';
/**
 * Definitive tasks.id repair.
 *
 * Previous migrations (fix_tasks_schema_v2, tasks_id_trigger) failed because
 * concurrent user inserts created new null-ID rows between DELETE and SET NOT NULL,
 * causing the transaction to roll back on every attempt.
 *
 * Fix: lock the table immediately so no concurrent inserts can interfere.
 *
 * Order matters:
 *   1. Lock table (blocks all concurrent reads/writes until COMMIT)
 *   2. Create sequence + set DEFAULT (so any insert AFTER commit gets an ID)
 *   3. Install BEFORE INSERT trigger (belt-and-suspenders)
 *   4. Delete null-ID tasks
 *   5. SET NOT NULL (safe: table locked, nulls gone)
 *   6. Add PRIMARY KEY if missing
 */
module.exports = {
  name: 'tasks_schema_final',

  up: async (client) => {
    // 1. Exclusive lock — held until transaction commits
    await client.query(`LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE`);

    // 2. Add missing columns (idempotent)
    await client.query(`
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW()
    `);

    // 3. Create sequence if missing, sync to max(id)+1
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'tasks_id_seq') THEN
          CREATE SEQUENCE tasks_id_seq;
        END IF;
      END$$
    `);
    await client.query(`
      SELECT setval(
        'tasks_id_seq',
        COALESCE((SELECT MAX(id) FROM tasks WHERE id IS NOT NULL), 0) + 1,
        false
      )
    `);

    // 4. Wire DEFAULT unconditionally
    await client.query(
      `ALTER TABLE tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq')`
    );
    await client.query(`ALTER SEQUENCE tasks_id_seq OWNED BY tasks.id`);

    // 5. Install BEFORE INSERT trigger — fires even if DEFAULT is bypassed
    await client.query(`
      CREATE OR REPLACE FUNCTION tasks_assign_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS NULL THEN
          NEW.id := nextval('tasks_id_seq');
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS tasks_auto_id ON tasks`);
    await client.query(`
      CREATE TRIGGER tasks_auto_id
        BEFORE INSERT ON tasks
        FOR EACH ROW EXECUTE FUNCTION tasks_assign_id()
    `);

    // 6. Delete null-ID tasks (table locked — no new nulls possible)
    const { rows: nullTasks } = await client.query(
      `SELECT user_id, title, created_at FROM tasks WHERE id IS NULL ORDER BY created_at`
    );
    if (nullTasks.length > 0) {
      console.log(`[tasks_schema_final] deleting ${nullTasks.length} null-ID task(s):`);
      nullTasks.forEach(r =>
        console.log(`  user_id=${r.user_id}  title="${r.title}"  created=${r.created_at}`)
      );
      await client.query(`DELETE FROM task_steps WHERE task_id IS NULL`);
      await client.query(`DELETE FROM tasks WHERE id IS NULL`);
    } else {
      console.log(`[tasks_schema_final] no null-ID tasks`);
    }

    // 7. Enforce NOT NULL (safe: locked + nulls deleted)
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE tasks ALTER COLUMN id SET NOT NULL;
        END IF;
      END$$
    `);

    // 8. Add PRIMARY KEY if missing
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

    console.log('[tasks_schema_final] done');
  },
};
