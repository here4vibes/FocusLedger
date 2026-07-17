'use strict';
/**
 * Tier 1 of the prod constraint remediation — see docs/schema-remediation-plan.md.
 *
 * Adds the 39 unique constraints the code's ON CONFLICT assumes but prod's
 * (Prisma-orphaned) tables lacked. A read-only audit (scripts/dup-audit.sql)
 * confirmed 38/39 have ZERO duplicate rows; only expenses(plaid_transaction_id)
 * flagged one group — a double-synced Plaid txn or the shared-NULL manual
 * expenses. Handled safely: dedup touches only NON-NULL duplicate plaid txns
 * (keeps the lowest id — the same real bank transaction recorded twice), and a
 * plain unique index allows the many NULLs of manual expenses.
 *
 * Idempotent + per-item savepoints so one index can't abort the batch. Fresh
 * DBs already have these from the genesis; on prod this makes ON CONFLICT work
 * natively so the code workarounds can retire.
 */
const UNIQUES = [
  ['ai_extraction_usage', ['user_id', 'month']],
  ['bill_preferences', ['user_id', 'merchant_key']],
  ['buddy_engagement', ['user_id']],
  ['checkin_mode_preferences', ['user_id']],
  ['cross_domain_insights', ['user_id', 'week_start']],
  ['customer_emails', ['resend_email_id']],
  ['email_connections', ['user_id', 'provider']],
  ['email_suggestions', ['user_id', 'message_id']],
  ['expenses', ['plaid_transaction_id']],
  ['health_score_history', ['user_id', 'date']],
  ['impulse_spending_alerts', ['user_id', 'alert_type', 'local_date']],
  ['insight_unlocks', ['user_id', 'insight_key']],
  ['ios_waitlist', ['email']],
  ['journal_trust_metrics', ['user_id', 'metric_date']],
  ['lead_magnet_emails', ['email', 'lead_magnet_type']],
  ['news_cache', ['url']],
  ['nudge_dismissals', ['user_id', 'nudge_type', 'pattern_key']],
  ['nudge_preferences', ['user_id']],
  ['plaid_accounts', ['account_id']],
  ['plaid_items', ['institution_id', 'user_id']],
  ['plaid_items', ['item_id', 'user_id']],
  ['plaid_tokens', ['user_id']],
  ['plaid_transactions', ['transaction_id']],
  ['push_subscriptions', ['user_id', 'endpoint']],
  ['push_tokens', ['user_id', 'token']],
  ['routine_nudge_events', ['routine_id', 'nudge_date']],
  ['routine_nudge_prefs', ['user_id']],
  ['routine_streaks', ['routine_id']],
  ['spending_sessions', ['user_id', 'session_date']],
  ['task_time_estimations', ['task_id']],
  ['transaction_classifications', ['transaction_id', 'user_id']],
  ['transactions', ['plaid_transaction_id']],
  ['user_email_preferences', ['user_id']],
  ['user_focus_prefs', ['user_id']],
  ['user_followup_prefs', ['user_id']],
  ['user_notification_prefs', ['user_id']],
  ['user_score_weights', ['user_id']],
  ['user_weekly_reports', ['user_id', 'week_start']],
  ['weekly_stats', ['user_id', 'week_start']],
];

function indexName(table, cols) {
  return `${table}_${cols.join('_')}_uidx`.slice(0, 63);
}

module.exports = {
  name: 'remediate_prod_unique_constraints_tier1',
  up: async (client) => {
    // ── expenses: the one flagged table. Remove only NON-NULL duplicate Plaid
    //    transactions (the same bank txn synced twice), keeping the lowest id.
    //    No-op if the dup group was the shared-NULL manual expenses.
    await client.query('SAVEPOINT sp_expenses_dedup');
    try {
      const { rowCount } = await client.query(`
        DELETE FROM expenses a USING expenses b
        WHERE a.plaid_transaction_id = b.plaid_transaction_id
          AND a.plaid_transaction_id IS NOT NULL
          AND a.id > b.id
      `);
      await client.query('RELEASE SAVEPOINT sp_expenses_dedup');
      if (rowCount) console.log(`[remediate-tier1] expenses: removed ${rowCount} duplicate Plaid txn row(s)`);
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_expenses_dedup');
      console.warn('[remediate-tier1] expenses dedup skipped:', e.message);
    }

    // ── Add each unique index independently (savepoint per item).
    let added = 0;
    for (const [table, cols] of UNIQUES) {
      const idx = indexName(table, cols);
      await client.query('SAVEPOINT sp_idx');
      try {
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${table} (${cols.join(', ')})`);
        await client.query('RELEASE SAVEPOINT sp_idx');
        added++;
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_idx');
        console.warn(`[remediate-tier1] ${table} (${cols.join(', ')}) — index failed:`, e.message);
      }
    }
    console.log(`[remediate-tier1] Done. unique indexes ensured: ${added}/${UNIQUES.length}`);
  },
};
