'use strict';
/**
 * lib/startup-repair.js — tasks.id schema repair.
 *
 * Runs on every server start until the schema is correct (all ops are
 * idempotent). Bypasses migrate.js so it can use the live pool directly.
 * Non-blocking: errors are logged but do not prevent the server from starting.
 */

module.exports = async function repairTasksSchema(pool) {
  let client;
  try {
    client = await pool.connect();
    await client.query('SET statement_timeout = 0'); // DDL may wait for locks
    await client.query('BEGIN');

    // 1. Ensure sequence exists and is synced
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'tasks_id_seq') THEN
          CREATE SEQUENCE tasks_id_seq;
        END IF;
      END $$
    `);
    await client.query(`
      SELECT setval('tasks_id_seq',
        COALESCE((SELECT MAX(id) FROM tasks WHERE id IS NOT NULL), 0) + 1, false)
    `);

    // 2. Wire DEFAULT on id if not already set
    const { rows: [col] } = await client.query(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tasks' AND column_name='id'`
    );
    if (!col?.column_default?.startsWith('nextval')) {
      await client.query(
        `ALTER TABLE tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq')`
      );
      console.log('[startup] tasks.id DEFAULT set');
    }

    // 3. Install BEFORE INSERT trigger (belt-and-suspenders)
    await client.query(`
      CREATE OR REPLACE FUNCTION tasks_assign_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS NULL THEN NEW.id := nextval('tasks_id_seq'); END IF;
        RETURN NEW;
      END; $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS tasks_auto_id ON tasks`);
    await client.query(`
      CREATE TRIGGER tasks_auto_id
        BEFORE INSERT ON tasks
        FOR EACH ROW EXECUTE FUNCTION tasks_assign_id()
    `);

    // 4. Delete null-ID tasks
    const { rows: [{ cnt }] } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM tasks WHERE id IS NULL`
    );
    if (cnt > 0) {
      await client.query(`DELETE FROM task_steps WHERE task_id IS NULL`);
      await client.query(`DELETE FROM tasks WHERE id IS NULL`);
      console.log(`[startup] purged ${cnt} null-ID tasks`);
    }

    await client.query('COMMIT');
    console.log('[startup] tasks.id repair done');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[startup] tasks.id repair failed:', e.message);
  } finally {
    if (client) client.release();
  }
};
