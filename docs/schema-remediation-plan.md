# Prod Schema Constraint Remediation — Scope

## The recurring problem
When Prisma was removed, the tables it created lost their keys. **Fresh DBs are now correct** (the genesis migration gives them every primary key and unique constraint), but the **live production tables are missing them.** Every time the code uses `ON CONFLICT (…)` against one of those tables, Postgres throws *"no unique or exclusion constraint matching the ON CONFLICT specification"* — and we've patched it four times in code (nudges, linked_emails, email_tasks_stash, the notification dedup logs).

This plan makes prod match the genesis so `ON CONFLICT` works natively and the whack-a-mole ends.

## What's actually missing (measured against the prod dump)
- **39 unique constraints** the code's `ON CONFLICT` assumes but prod lacks. (Only 6 tables already have theirs: `buddy_checkins`, `buddy_daily_plans`, `buddy_midday_checkins`, `daily_reveals`, `detected_patterns`, `one_off_email_log`.)
- **90 tables** have a **nullable `id` and no primary key** (the NULL-id disease at scale). Only 7 tables have a proper serial id: `cross_domain_insights`, `daily_reveals`, `email_campaigns`, `email_suppression`, `expenses`, `one_off_email_log`, `tasks`.

## Two tiers, in priority order

### Tier 1 — Unique constraints (fixes active bugs; do first)
The 39 missing uniques, grouped:

- **Per-user singletons** (`… (user_id)`) — settings/state tables where there should be exactly one row per user: `buddy_engagement`, `checkin_mode_preferences`, `nudge_preferences`, `plaid_tokens`, `routine_nudge_prefs`, `user_email_preferences`, `user_focus_prefs`, `user_followup_prefs`, `user_notification_prefs`, `user_score_weights`. **These are the highest dup risk** — a failing upsert may have inserted several rows per user.
- **Per-user + period** (`… (user_id, <date/week>)`): `ai_extraction_usage`, `cross_domain_insights`, `health_score_history`, `journal_trust_metrics`, `spending_sessions`, `user_weekly_reports`, `weekly_stats`, `impulse_spending_alerts`.
- **External-id dedup keys**: `expenses (plaid_transaction_id)`, `plaid_accounts (account_id)`, `plaid_transactions (transaction_id)`, `transactions (plaid_transaction_id)`, `customer_emails (resend_email_id)`, `news_cache (url)`, `push_subscriptions (user_id, endpoint)`, `push_tokens (user_id, token)`, `ios_waitlist (email)`, `lead_magnet_emails (email, lead_magnet_type)`, and others.

**Approach per constraint — dedup-first, then add the index (idempotent):**
```sql
-- 1. keep one row per key group (only runs where duplicates actually exist)
DELETE FROM <t> a USING <t> b
WHERE <a.k = b.k for each key col> AND a.ctid < b.ctid;   -- ctid: many tables have no usable id
-- 2. add the unique (satisfies ON CONFLICT; no-op if already present)
CREATE UNIQUE INDEX IF NOT EXISTS <t>_<cols>_uidx ON <t> (<cols>);
```
The `DELETE` is the **only destructive statement**, and it removes *only* exact-key duplicates, keeping one. We run it **only on tables the audit shows have duplicates** — everything else just gets the index directly.

### Tier 2 — Primary keys + sequences (integrity/editability; do later)
The 90 keyless tables have nullable `id` with no sequence, so their rows can't be reliably updated/deleted by id (the same disease we already fixed for `expenses`). Per table:
```sql
CREATE SEQUENCE IF NOT EXISTS <t>_id_seq;
UPDATE <t> SET id = nextval('<t>_id_seq') WHERE id IS NULL;   -- backfill
ALTER TABLE <t> ALTER COLUMN id SET DEFAULT nextval('<t>_id_seq');
ALTER TABLE <t> ALTER COLUMN id SET NOT NULL;
ALTER TABLE <t> ADD PRIMARY KEY (id);
```
Bigger, touches every table, lower urgency (no active bug depends on it). **Separate phase after Tier 1 proves the approach.**

## Safety & execution
1. **Back up first** — take a Neon branch/snapshot immediately before running (instant, free rollback).
2. **Read-only dup audit first** (Step 0 below) — tells us exactly which tables have duplicate rows, so the `DELETE`s are *informed, not blind*. Most tables will show 0 (the failing upserts never inserted), and those skip dedup entirely.
3. **Idempotent migration** — everything `IF NOT EXISTS`; `migrate.js` already wraps each migration in its own savepoint, so one failure can't corrupt the run.
4. **Boot-smoke validates from scratch** — the migration runs against a throwaway Postgres in CI before it ever touches prod.
5. **Phased** — Tier 1 in 2–3 batches (external-id keys and zero-dup tables first, per-user singletons after their dup counts are reviewed). Tier 2 as its own later effort.
6. **Cleanup (optional)** — once a table has its real constraint, its code workaround can revert to a clean `ON CONFLICT`.

## Step 0 — the only thing needed to start (read-only, zero risk)
Run this in the Neon SQL editor and send the result. Any row with `dup_groups > 0` needs dedup before its constraint; everything at `0` gets the index directly. **This is committed at `scripts/dup-audit.sql`.**

```sql
-- (39 checks; see scripts/dup-audit.sql for the full generated query)
SELECT 'user_score_weights (user_id)' AS constraint_needed, COUNT(*) AS dup_groups
  FROM (SELECT user_id FROM user_score_weights GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'expenses (plaid_transaction_id)', COUNT(*)
  FROM (SELECT plaid_transaction_id FROM expenses GROUP BY plaid_transaction_id HAVING COUNT(*) > 1) d
-- … 37 more …
ORDER BY dup_groups DESC;
```

## Recommendation
Run **Step 0** (read-only, ~10s). With the dup landscape in hand, I write the Tier 1 migration — dedup only where the audit says so, then add all 39 uniques — validate it on a fresh DB via the boot-smoke, and land it behind a Neon backup. Tier 2 follows as a separate, deliberate pass.
