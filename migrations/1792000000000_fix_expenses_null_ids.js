'use strict';
/**
 * Definitive expenses.id repair — root cause of "triage never saves".
 *
 * Production expenses.id had no sequence/default (same Prisma-era disease as
 * tasks.id and plaid_accounts.id), so every Plaid auto-confirm INSERT created
 * a row with id = NULL. Consequences observed in Render logs:
 *   - PATCH /api/money/expenses/null/triage → "invalid input syntax for
 *     type integer: NaN" — a row with no id can never be updated, so no
 *     impulse/planned answer ever saved.
 *   - Auto-confirm dedup found the row but read id NULL → treated as missing
 *     → re-INSERT → "duplicate key ... expenses_plaid_tx_id_unique" spam.
 *
 * UNLIKE the tasks repair, null-id rows here are REAL FINANCIAL DATA and are
 * BACKFILLED with fresh ids, never deleted.
 *
 * Order (mirrors tasks_schema_final, the proven pattern):
 *   1. Lock table (no concurrent inserts can add new nulls mid-repair)
 *   2. Sequence + DEFAULT + BEFORE INSERT trigger
 *   3. Backfill null ids from the sequence
 *   4. Repair plaid_transactions.expense_id links (they were set to NULL by
 *      the same bug) via plaid_transaction_id join
 *   5. SET NOT NULL + PRIMARY KEY (guarded — duplicates among legacy
 *      non-null ids would abort the whole migration otherwise)
 */
module.exports = {
  name: 'fix_expenses_null_ids',

  up: async (client) => {
    // 1. Exclusive lock — held until COMMIT
    await client.query(`LOCK TABLE expenses IN ACCESS EXCLUSIVE MODE`);

    // 2a. Sequence, synced past current max
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'expenses_id_seq') THEN
          CREATE SEQUENCE expenses_id_seq;
        END IF;
      END$$
    `);
    await client.query(`
      SELECT setval(
        'expenses_id_seq',
        COALESCE((SELECT MAX(id) FROM expenses WHERE id IS NOT NULL), 0) + 1,
        false
      )
    `);

    // 2b. DEFAULT + ownership
    await client.query(
      `ALTER TABLE expenses ALTER COLUMN id SET DEFAULT nextval('expenses_id_seq')`
    );
    await client.query(`ALTER SEQUENCE expenses_id_seq OWNED BY expenses.id`);

    // 2c. BEFORE INSERT trigger — fires even if a code path bypasses DEFAULT
    //     by passing id explicitly as NULL
    await client.query(`
      CREATE OR REPLACE FUNCTION expenses_assign_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS NULL THEN
          NEW.id := nextval('expenses_id_seq');
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS expenses_auto_id ON expenses`);
    await client.query(`
      CREATE TRIGGER expenses_auto_id
        BEFORE INSERT ON expenses
        FOR EACH ROW EXECUTE FUNCTION expenses_assign_id()
    `);

    // 3. BACKFILL null ids (financial data — never delete)
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM expenses WHERE id IS NULL`
    );
    const nullCount = countRows[0].n;
    if (nullCount > 0) {
      await client.query(
        `UPDATE expenses SET id = nextval('expenses_id_seq') WHERE id IS NULL`
      );
      console.log(`[fix_expenses_null_ids] backfilled ${nullCount} null-id expense row(s)`);
    } else {
      console.log('[fix_expenses_null_ids] no null-id expenses found');
    }

    // 4. Repair plaid_transactions.expense_id links broken by the same bug
    //    (auto-confirm wrote expense_id = NULL because RETURNING id was NULL)
    const { rows: linkRows } = await client.query(`
      UPDATE plaid_transactions pt
      SET expense_id = e.id
      FROM expenses e
      WHERE pt.expense_id IS NULL
        AND pt.is_confirmed = true
        AND pt.transaction_id IS NOT NULL
        AND e.plaid_transaction_id = pt.transaction_id
      RETURNING pt.id
    `);
    if (linkRows.length > 0) {
      console.log(`[fix_expenses_null_ids] repaired ${linkRows.length} plaid_transactions.expense_id link(s)`);
    }

    // 5a. NOT NULL (safe: locked + backfilled)
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'expenses' AND column_name = 'id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE expenses ALTER COLUMN id SET NOT NULL;
        END IF;
      END$$
    `);

    // 5b. PRIMARY KEY — guarded so legacy duplicate ids surface as a log
    //     line instead of aborting the whole (otherwise-successful) repair
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'expenses'::regclass AND contype = 'p'
        ) THEN
          BEGIN
            ALTER TABLE expenses ADD PRIMARY KEY (id);
          EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'expenses PK skipped (duplicate legacy ids?): %', SQLERRM;
          END;
        END IF;
      END$$
    `);

    console.log('[fix_expenses_null_ids] done');
  },

  down: async (client) => {
    await client.query(`DROP TRIGGER IF EXISTS expenses_auto_id ON expenses`);
    await client.query(`DROP FUNCTION IF EXISTS expenses_assign_id()`);
    // Sequence + backfilled ids are kept — reverting ids would re-break rows.
  },
};
