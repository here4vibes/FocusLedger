'use strict';
/**
 * Repairs surfaced by the first real production migration run (Render logs
 * 2026-07-11) — Prisma-era tables missing columns the code writes/reads, plus
 * the four unique indexes that couldn't be created on the first pass.
 *
 * Observed errors this fixes:
 *   - [buddy] GET /midday-checkin: column "updated_at" does not exist
 *     (buddy_daily_plans has no updated_at in prod)
 *   - [buddy] GET /patterns: column "confidence_score" does not exist
 *     (detected_patterns is missing the pattern-detection column set)
 *   - nudges_user_notification_key_unique skipped: column a.notification_key
 *     does not exist (nudges table predates the notification_key dedup key —
 *     every ON CONFLICT nudge insert has been failing)
 *   - user_score_weights / user_followup_prefs skipped: column a.id does not
 *     exist (dedup assumed an id column; use ctid instead)
 *   - ai_extraction_usage: could not create unique index (NULL ids defeated
 *     the a.id < b.id dedup; ctid dedup handles every row)
 *
 * Every item runs under its own SAVEPOINT — one miss never aborts the rest.
 */

const items = [
  {
    name: 'buddy_daily_plans.updated_at',
    ddl: [`ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`],
  },
  {
    name: 'detected_patterns pattern-detection columns',
    ddl: [`ALTER TABLE detected_patterns
             ADD COLUMN IF NOT EXISTS occurrence_count        INT NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS total_opportunities     INT NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS time_consistency_score  NUMERIC(5,2) NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS confidence_score        NUMERIC(5,2) NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS last_detected_at        TIMESTAMPTZ,
             ADD COLUMN IF NOT EXISTS is_active               BOOLEAN NOT NULL DEFAULT true`],
  },
  {
    name: 'nudges.notification_key + unique index',
    ddl: [
      `ALTER TABLE nudges ADD COLUMN IF NOT EXISTS notification_key VARCHAR(255)`,
      `DELETE FROM nudges a USING nudges b
        WHERE a.user_id = b.user_id
          AND a.notification_key IS NOT DISTINCT FROM b.notification_key
          AND a.notification_key IS NOT NULL
          AND a.ctid < b.ctid`,
      `CREATE UNIQUE INDEX IF NOT EXISTS nudges_user_notification_key_unique
         ON nudges (user_id, notification_key)`,
    ],
  },
  {
    name: 'user_score_weights unique (ctid dedup)',
    ddl: [
      `DELETE FROM user_score_weights a USING user_score_weights b
        WHERE a.user_id = b.user_id AND a.ctid < b.ctid`,
      `CREATE UNIQUE INDEX IF NOT EXISTS user_score_weights_user_id_unique
         ON user_score_weights (user_id)`,
    ],
  },
  {
    name: 'user_followup_prefs unique (ctid dedup)',
    ddl: [
      `DELETE FROM user_followup_prefs a USING user_followup_prefs b
        WHERE a.user_id = b.user_id AND a.ctid < b.ctid`,
      `CREATE UNIQUE INDEX IF NOT EXISTS user_followup_prefs_user_id_unique
         ON user_followup_prefs (user_id)`,
    ],
  },
  {
    name: 'ai_extraction_usage unique (ctid dedup)',
    ddl: [
      `DELETE FROM ai_extraction_usage a USING ai_extraction_usage b
        WHERE a.user_id = b.user_id AND a.month = b.month AND a.ctid < b.ctid`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ai_extraction_usage_user_month_unique
         ON ai_extraction_usage (user_id, month)`,
    ],
  },
];

module.exports = {
  name: 'fix_prisma_era_columns_and_stragglers',

  up: async (client) => {
    for (const item of items) {
      await client.query('SAVEPOINT item_sp');
      try {
        for (const sql of item.ddl) {
          await client.query(sql);
        }
        await client.query('RELEASE SAVEPOINT item_sp');
        console.log(`[migration] applied: ${item.name}`);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT item_sp');
        console.warn(`[migration] ${item.name} skipped: ${e.message}`);
      }
    }
  },
};
