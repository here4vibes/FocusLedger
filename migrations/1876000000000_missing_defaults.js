'use strict';
/**
 * The defaults, types and unique keys the code assumes but production never had.
 *
 * Production's schema came from Prisma with no column defaults, and many INSERTs
 * leave these columns out, so new rows got NULL. Every reader that filters on
 * `= false` / `= 'pending'` then skipped them. Checked against prod on 2026-10-18:
 *   - tasks.is_completed: 21 NULL rows (4 of them real tasks). They never show in
 *     Today, the Buddy plan, deadline nudges or "Done ✓", and skip the free cap.
 *   - plaid_transactions.is_confirmed: 726 NULL rows, so the spending check-in
 *     queue was always empty.
 *   - buddy_conversations.created_at: 257 NULL rows, so "new Buddy message"
 *     never fired and the ADHD profile found no history.
 *   - partnerships.status: new Tandem invites were saved with NULL, and accepting
 *     requires status = 'pending', so no invite could ever be accepted.
 *   - recurring_tasks/expenses.is_paused, task_steps.is_completed, nudges.status,
 *     contact_submissions.status and others: same pattern, fewer or no rows yet.
 *   - task_time_estimations.calibration_score was int4 for a ratio (0.8 → 1).
 *   - detected_patterns scores were int4 for 0–1 floats; routine_suggestions.
 *     created_routine_id was timestamptz. Both tables are empty.
 *   - promo_codes / promo_redemptions / partnerships had none of the unique keys
 *     their 23505 handlers rely on, so a double submit could grant days twice.
 *
 * Old plaid_transactions rows are only backfilled for the last 14 days, so the
 * check-in doesn't suddenly show months of history. Older NULL rows stay hidden,
 * as they are today. Idempotent.
 */

const DEFAULTS = [
  ['tasks', 'is_completed', 'false'],
  ['tasks', 'created_at', 'now()'],
  ['tasks', 'updated_at', 'now()'],
  ['tasks', 'is_household', 'false'],
  ['tasks', 'is_shared_with_partner', 'false'],
  ['plaid_transactions', 'is_confirmed', 'false'],
  ['plaid_transactions', 'created_at', 'now()'],
  ['buddy_conversations', 'created_at', 'now()'],
  ['partnerships', 'status', "'pending'"],
  ['partnerships', 'created_at', 'now()'],
  ['partner_concerns', 'is_consumed', 'false'],
  ['promo_codes', 'redemption_count', '0'],
  ['promo_codes', 'is_active', 'true'],
  ['promo_codes', 'created_at', 'now()'],
  ['promo_redemptions', 'redeemed_at', 'now()'],
  ['recurring_tasks', 'is_paused', 'false'],
  ['recurring_expenses', 'is_paused', 'false'],
  ['task_steps', 'is_completed', 'false'],
  ['nudges', 'status', "'pending'"],
  ['routine_nudge_events', 'status', "'pending'"],
  ['contact_submissions', 'status', "'pending'"],
  ['email_connections', 'is_active', 'true'],
  ['bill_preferences', 'is_disabled', 'false'],
  ['budgets', 'is_active', 'true'],
  ['buddy_demo_sessions', 'is_complete', 'false'],
  ['detected_patterns', 'is_active', 'true'],
  ['routine_suggestions', 'status', "'pending'"],
  ['expenses', 'created_at', 'now()'],
  ['events', 'created_at', 'now()'],
  ['email_log', 'created_at', 'now()'],
  ['app_subscription', 'created_at', 'now()'],
  ['user_values', 'created_at', 'now()'],
  ['budgets', 'created_at', 'now()'],
];

async function hasColumn(client, table, column) {
  const r = await client.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.rows[0] ? r.rows[0].data_type : null;
}

async function rowCount(client, table) {
  const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0].n;
}

module.exports = {
  name: 'missing_defaults',

  up: async (client) => {
    for (const [table, column, expr] of DEFAULTS) {
      if (!(await hasColumn(client, table, column))) {
        console.warn(`[migration missing_defaults] skipped ${table}.${column}: column not found`);
        continue;
      }
      await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${expr}`);
    }

    // Backfills for rows written without the defaults.
    await client.query(`UPDATE tasks SET is_completed = (completed_at IS NOT NULL) WHERE is_completed IS NULL`);
    await client.query(`UPDATE tasks SET created_at = COALESCE(updated_at, now()) WHERE created_at IS NULL`);
    await client.query(`
      UPDATE plaid_transactions SET is_confirmed = false
      WHERE is_confirmed IS NULL AND expense_id IS NULL AND transaction_date >= CURRENT_DATE - 14`);
    await client.query(`
      UPDATE buddy_conversations SET created_at = session_date::timestamptz
      WHERE created_at IS NULL AND session_date IS NOT NULL`);
    await client.query(`UPDATE partnerships SET status = 'pending' WHERE status IS NULL AND invitee_id IS NULL`);
    await client.query(`UPDATE contact_submissions SET status = 'pending' WHERE status IS NULL`);
    await client.query(`UPDATE promo_codes SET redemption_count = 0 WHERE redemption_count IS NULL`);
    await client.query(`UPDATE promo_codes SET is_active = true WHERE is_active IS NULL`);

    // Types: ratios and scores stored as integers.
    if ((await hasColumn(client, 'task_time_estimations', 'calibration_score')) === 'integer') {
      await client.query(`ALTER TABLE task_time_estimations ALTER COLUMN calibration_score TYPE numeric(6,2)`);
    }
    for (const col of ['confidence_score', 'time_consistency_score']) {
      if ((await hasColumn(client, 'detected_patterns', col)) === 'integer') {
        await client.query(`ALTER TABLE detected_patterns ALTER COLUMN ${col} TYPE numeric(5,3)`);
      }
    }
    // A routine id in a timestamp column. Only convert while the table is empty,
    // since USING NULL would drop any values.
    if ((await hasColumn(client, 'routine_suggestions', 'created_routine_id')) === 'timestamp with time zone') {
      if ((await rowCount(client, 'routine_suggestions')) === 0) {
        await client.query(`ALTER TABLE routine_suggestions ALTER COLUMN created_routine_id TYPE integer USING NULL`);
      } else {
        console.warn('[migration missing_defaults] routine_suggestions.created_routine_id left as timestamptz: table has rows');
      }
    }

    // Unique keys behind the 23505 handlers in routes/promo-codes.js and routes/partnerships.js.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_upper_uidx ON promo_codes (upper(code))`);
    await client.query(`
      DELETE FROM promo_redemptions a USING promo_redemptions b
      WHERE a.promo_code_id = b.promo_code_id AND a.user_id = b.user_id AND a.id > b.id`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS promo_redemptions_code_user_uidx
      ON promo_redemptions (promo_code_id, user_id)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS partnerships_invite_token_uidx
      ON partnerships (invite_token) WHERE invite_token IS NOT NULL`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS partnerships_one_active_inviter_uidx
      ON partnerships (inviter_id) WHERE status = 'active'`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS partnerships_one_active_invitee_uidx
      ON partnerships (invitee_id) WHERE status = 'active'`);
  },

  down: async (client) => {
    for (const idx of [
      'promo_codes_code_upper_uidx', 'promo_redemptions_code_user_uidx', 'partnerships_invite_token_uidx',
      'partnerships_one_active_inviter_uidx', 'partnerships_one_active_invitee_uidx',
    ]) {
      await client.query(`DROP INDEX IF EXISTS ${idx}`);
    }
  },
};
