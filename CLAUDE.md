# FocusLedger

## What this app does
FocusLedger is an ADHD-native personal command center: tasks, money tracking, impulse spending detection — all in one tab. Built by a CPA with ADHD. Executive functioning on autopilot.

## Stack
Node.js + Express · PostgreSQL (Neon) · Render deployment · Vanilla HTML/CSS/JS frontend (served as static files from `/public`)

## Directory map
- `server.js` — app entry point, middleware mount, route wiring (hard cap 300 lines)
- `middleware/security.js` — Helmet CSP, CORS, rate limiters (extracted from server.js)
- `routes/` — one file per endpoint group using express.Router(); mounts under /api/* or /api/v1/*
- `db/` — one file per table/table-group; all SQL via pool.query; no raw SQL outside db/
- `public/` — all static HTML/CSS/JS; the home page is `public/weightless.html`
- `lib/` — shared service utilities: email, AI tagging, nudge generation, queryWithRetry, documentExtraction, ai-service
- `public/js/services/` — shared frontend service modules (values-service.js, ai-service.js)
- `services/` — PlaidService, TransactionService, ClassificationService, EventBus, InsightsService, TimeEstimationService
- `jobs/` — scheduled recurring work declared in `render.yaml` cron services; no in-process schedulers
- `migrations/` — node-postgres JS migrations; each exports `{ name, up: async (client) => {} }`
- `config/test-users.js` — canonical QA user (qa@focusledger.net)

## Database
- `users` — accounts, subscription, Google OAuth, is_qa_user, Pro/Tandem grants, UTM, timezone
- `tasks` — todo items: due dates, steps, recurring, notes, duration_minutes; `is_household`/`is_shared_with_partner` for Tandem sharing
- `task_steps` — subtask breakdown for AI task splitting; cascade-deletes with parent task
- `work_hour_blocks` — user-defined blocked time slots (day_of_week 0-6, start/end times, label)
- `expenses` — amount, category_id, expense_date, source ('manual'|'plaid'), is_impulse (NULL=untriaged), plaid_transaction_id (unique dedup)
- `categories` — spending categories (seeded defaults; 10 FocusLedger slugs enforced)
- `time_blocks` — calendar/focus blocks
- `ideas` — quick capture notes
- `journal_entries` — daily journal with mood
- `user_values` — personal values list
- `values_alignment_scores` — daily alignment check-ins
- `email_connections` — OAuth email account links
- `analytics_events` — privacy-safe anonymous page/event tracking
- `adhd_tax_leads + visitor_sessions` — ADHD Tax Calculator email captures; anonymous visitor tracking
- `password_reset_tokens` — reset tokens: 1-hour expiry, SHA256 hash, single-use
- `contact_submissions` — support form + in-app bug reports: category (bug/account issue/other), status (pending/resolved), auto-captures page URL + browser
- `buddy_checkins` — daily check-ins (morning focus, evening recap; one per user/date/type)
- `buddy_daily_plans` — V2A AI-curated daily 3-task plans: mood, task slots with reasons, accepted flag, completion count
- `buddy_patterns` — V2B detected behavioral patterns per user; surfaced/dismissed flags
- `buddy_midday_checkins` — V2B mid-day check-in responses (post_plan, afternoon_energy, pre_evening); one per user/date/type
- `buddy_engagement` — per-user Buddy streak tracking: consecutive_missed_checkins, hook_restart_count, lapse timestamps, touch flags (push/day5email/day14email); last_comeback_shown_at
- `buddy_conversations` — V3 coaching conversation turns per user/date: role ('user'|'buddy'), ordered by turn number; used for day-2 hook context
- `checkin_mode_preferences` — per-user check-in mode (form vs conversation); preferred_mode learned after 5 sessions; manual_override for explicit choice
- `buddy_demo_sessions + buddy_demo_turns` — anonymous demo sessions keyed by UUID; `buddy_demo_turns` mirrors `buddy_conversations` for authenticated users
- `focus_sessions` — Focus Mode deep-work sessions: task_id, planned_duration_seconds, actual_duration_seconds, completed, started_at, ended_at; FK to tasks ON DELETE CASCADE
- `user_focus_prefs` — Body Double + Ambient Layer preferences: body_double_enabled, ambient_style ('cafe'|'library'|'rain'), ambient_volume (0-100); PK user_id
- `documents` — Life section vault: file metadata, S3 URL, category, expiry, AI-extracted fields; extraction_status ('none'|'pending'|'processing'|'done'|'failed'), extraction_confidence (JSONB per-field scores)
- `ai_extraction_usage` — monthly AI extraction counter per user; capped at 25/month for Free and Pro
- `nudges + nudge_preferences` — actionable nudge records per user (types: document_expiry, insurance_gap, score_drop, annual_review); per-user delivery channel toggles (push, buddy, email, banner)
- `insurance_policies` — type, provider, policy#, coverage, premium, expiry, document link
- `coverage_gaps_log` — detected missing coverage types; status: open/addressed/ignored
- `plaid_items + plaid_accounts + plaid_transactions` — bank sync: encrypted access_token (AES-256-GCM), account_ids, transaction dedup on Plaid transaction_id; confirmed=true means written to expenses
- `plaid_tokens` — legacy per-user Plaid access token (Phase 1 v1 API); replaced by `plaid_items` table with AES-256-GCM encrypted tokens for current Plaid integration
- `transactions + spending_sessions + transaction_classifications` — v1 API transaction ledger (legacy); current money tab uses Prisma-backed expense + plaid_transaction tables
- `bill_preferences` — per-user per-merchant: `bucket` (obligation/subscription/habit), `is_disabled` (legacy stop-auto-tasks), `kept_at` (subscription kept; review rests 90d), `cancel_*` (requested/expected_by/amount/frequency/status pending→confirmed|charged_again/resolved_at, settled by the bill guardian from bank data)
- `customer_emails` — two-way admin inbox; direction enum ('inbound'/'outbound'); unique on resend_email_id
- `account_deletion_tokens` — one-time confirmation tokens for self-service deletion; 24h expiry, SHA256 hashed, single-use
- `notification_send_log` — push dedup: (user_id, notification_key, send_date) to prevent duplicates; daily cap of 3
- `followup_email_types + user_followup_prefs` — master list of 4 email types (task_reminder, routine_streak, weekly_summary, follow_through) with per-user enabled/hour overrides
- `followup_email_log` — sent history; unique per user+type+ref+date
- `linked_emails + email_tasks_stash` — verified sender addresses (max 5 per user) that auto-create tasks when emailed; stashed inbound emails from unknown senders pending magic-link claim; 72h TTL
- `promo_codes` — admin-created codes: code, type, value (days), max_redemptions, expires_at, is_active, redemption_count
- `promo_redemptions` — per-user redemption log; unique (promo_code_id, user_id); one per user per code
- `partnerships` — Tandem accountability partner links: inviter_id, invitee_id, status (pending/active/dissolved), invite_token (unique, 7d TTL), soft-delete with dissolved_at; tandem_trial_activated_at; one active per user via partial unique index
- `partner_concerns` — soft concern signals from one partner to Buddy; concern_text NEVER shown to the concerned-about user; Buddy receives only topic_area as coaching context; auto-expire 7 days
- `push_tokens` — APNs device tokens for iOS (Capacitor); unique (user_id, token); separate from push_subscriptions (Web Push/VAPID)
- `ios_waitlist + lead_magnet_emails` — iOS waitlist; lead captures from Science Cheat Sheet + Daily Three Template downloads; unique on email
- `task_substeps` — AI-generated micro-step breakdowns for "I'm stuck" flow; persisted for resume; cascade-deletes with task
- `routines + routine_task_links` — user-defined routine groups (AM/PM/weekly) with many-to-many task links; nudge_after_hour trigger, optional day_of_week for weekly
- `routine_streaks` — per-routine consecutive-day tracking: current_streak, best_streak, last_completed_date
- `routine_nudge_events + routine_nudge_prefs` — event log (status, skip_count) + per-user nudge prefs (enabled, frequency); nudge_after_hour trigger on routines table
- `detected_patterns` — AI-detected recurring task patterns per user: pattern_type (time/day/sequence/category), confidence_score, occurrence_count, is_active flag; stores task IDs + metadata
- `routine_suggestions` — surfaceable suggestions from detected patterns: status (pending/accepted/dismissed); presented_count for ephemeral expiry (auto-remove after 3 ignored sessions); accepted links to created routine
- `routine_templates` — global read-only pre-built routine library (5 templates); tasks as JSONB; category: morning/evening/weekly/productivity/movement; `routines.source_template_id` FK links adopted copies
- `weekly_stats` — weekly rollup: tasks_completed/created, total_spend_cents, impulse/planned counts, evening_sessions, routines_completed, streak_days; computed daily by cron
- `insight_unlocks` — tracks which Progressive Insights tiers each user has unlocked; unlocked_at, viewed, interacted flags; UNIQUE(user_id, insight_key)
- `task_time_estimations` — Time-Blindness P1: user time estimates vs actuals per task; calibration_score (actual/estimated ratio); UNIQUE(task_id)

## External integrations
- **Resend + OpenAI/Polsia AI** — email delivery (Resend, hello@focusledger.net) + AI task breakdown/tagging/coaching/personalized insights
- **Plaid** — bank account sync for spending + bill detection
- **Stripe** — Autopilot subscription via hosted checkout links
- **Google OAuth** — primary signup/login method
- **Facebook Pixel** — conversion tracking on landing page
- **Polsia Analytics** — first-party beacon pixel
- **APNs** — iOS push via `apn` npm package; env vars: APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8, APNS_BUNDLE_ID

## Current state & handoff (updated 2026-10-18)

**Read this section first.** It's the only context a new session gets.
- **Every reply ends with a "Summary" section** (the user's standing request).
- **Context is limited, so stay small:** one PR per feature, and read only the files a task touches.
- **Keep this section current:** update it in the PR that changes the state, or in a small `docs(claude-md)` PR at the end of a work chunk. Keep it short and delete what's done.

### Open PRs (each needs the user's explicit "merge N")
**When several PRs are open,** they usually all edit this file and `public/changelog.html`. After each merge, merge `main` into the next PR. Resolve `changelog.html` by taking `main`'s file and re-inserting the branch's entry at the top. Resolve CLAUDE.md by keeping both sides' lines. Check CI goes green, then merge with the full head SHA.

- **#218** `claude/test-coverage-analysis-wAcNr`: billing portal, nudge-quality pass, "one home", security upgrades. **It waits only on the user's live Stripe purchase test.** It's stale against `main`, so merge `main` in before merging; expect conflicts in `changelog.html`, CLAUDE.md and maybe the nudge jobs.
  - **Contents:**
    - `POST /api/subscription/portal`.
    - Nudge fixes: lifecycle emails, Buddy lapse timing, deadline quiet hours 08:00–21:59 local, routine gating, cold-start nudge at 10am local, evening check-in at `evening_time`.
    - `/home` and `/portal` → `/weightless` (Command Center at `/portal/legacy`).
    - `apn` → native HTTP/2 sender; `imap` → `imapflow`.
    - Migrations `user_email_preferences_boolean` (NODE-EXPRESS-5) and `events_id_default`.
  - **On deploy:**
    - Re-engagement emails resume; only Miles (user 35) is eligible. 22 users are paused via `user_email_preferences.re_engagement='false'`; flip them back at relaunch.
    - `render.yaml` moves `cold-start-nudge` and `evening-checkin` to hourly. Confirm in Render if Blueprint sync is off.

### Next up: the bug-hunt plan (agreed with the user, 2026-10-18)
The user asked to finish the big bug classes in about 4 sessions:
1. **Schema audit (done: #252 code fixes, #253 defaults migration).** The genesis migration was generated from prod's catalog, so a from-scratch DB reproduces prod; a SQL error locally is a prod bug.
   - The 217 stale pending `plaid_transactions` (never removed because the "removed" webhook only deletes `is_confirmed = false`) are deleted once by migration `stale_pending_plaid` (user-approved 2026-10-18). 683 older posted rows still have `is_confirmed` NULL and stay out of the check-in.
2. ~~**Silent failures, part 3**~~ done: HIGH in #250, MEDIUM in #255. `__tests__/no-silent-catches.test.js` now checks every catch body (blocks and `.catch()` handlers, root cron modules included): it must log, rethrow, forward or carry `// silent-ok: <reason>`.
3. **Main paths end to end in CI:** the GET sweep is in CI (`scripts/ci-api-sweep.js`, `npm run test:sweep`, after `test:boot`). It GETs every parameterless `/api` route as a new user and fails on a 5xx (503 is OK) or a logged SQL/TypeError line. Its first run's 20 routes are fixed. The from-scratch schema is prod's, so a hit is a prod bug.
   - **Write flows** (`scripts/ci-write-flows.js`, `npm run test:flows`, after `test:sweep`; shared boot/log code in `scripts/ci-harness.js`): two new users drive ~25 flows (tasks, routines, check-ins, Buddy evening, money, focus, settings prefs, Tandem invite → share → dissolve, push Done, account deletion) and assert the follow-up GET state. The user's zone is picked so its date differs from UTC's, so server-clock "today" bugs fail every run.
   - **Still to do:** not driven: AI chat/breakdowns, Plaid, Stripe, documents upload, admin routes. Server-clock dates remain in `buildPartnerContext` (`routes/buddy.js`), `archiveBuddyConversationToJournal`, `services/InsightsService.js` and the pattern/reveal jobs. `checkin-spending.html` reads the legacy `transactions` table, which current Plaid sync doesn't write, so it always shows "nothing to review".
4. **Retire legacy pages:** `app.html`, `home.html` and `landing-old` are gone (#251), and `buddy.html` in #256: the form check-in is `public/checkin-form.html` at `/app/checkin/form`. **Still to do:** `portal.html`, after #218 merges (it changes `/home` and `/portal`).

**Smaller items:**
- **News sync** uses an in-process `setInterval` (`routes/news.js`). Move it to the commented-out `rss-sync` cron in `render.yaml`, or drop the feature.
- **Capture, still to do:** bank-charge suggestions, i.e. a known recurring charge such as a gym or pharmacy suggests ticking the related task.
- **Ideas discussed, not agreed:** show renewals and Bills in hours of work at the user's income rate; a risky-time spending nudge. The user noted purchases don't happen in the app, so these are reflection and planning views, not in-the-moment ones.

### UI consolidation plan (agreed with the user, 2026-10-11)
Four places plus a Settings gear. One small PR per phase; old URLs keep working through redirects.

| Place | Absorbs |
|---|---|
| **Home** = `/weightless` | `/app`, `/app/buddy`, `/home`, `/portal`, `/app/*` fallback |
| **Tasks** `/app/tasks` | Today, Done, Routines, Calendar, Ideas |
| **Money** `/app/money` | transactions, spending check-in, bills/subscriptions |
| **Life** `/app/life` | Vault, Insurance, Nudges, Score, Values, Journal, Insights |
| ⚙ **Settings** | Email → Tasks, Partner, Help & Contact, billing |

1. **Phase 1, one front door (#234, merged):**
   - The shared nav (`public/shared-nav.js`) has 4 tabs, and "More" is grouped by future home. Child pages light up their place's tab (`PLACE_CHILDREN`).
   - The Weightless header links to Tasks · Money · Life · ⚙.
   - `/app`, `/app/buddy` and unknown `/app/*` now go to `/weightless`. `/app/buddy?mode=form` redirects to the form check-in at `/app/checkin/form`.
   - `/home` and `/portal` are handled by #218.
2. **Phase 2, Tasks hub (#235, merged):** sections All tasks · Today · Routines · Calendar · Ideas.
   - Defined once in `PLACE_TABS` in `shared-nav.js`: a sticky `.place-tabs` strip on phones, and sub-items under the place in the desktop sidebar.
   - Don't dock a strip under page headers on desktop; old pages have their own sticky/fixed bars, which phase 5 removes.
   - `/app/done` is a flow screen, not a section.
   - For phases 3 and 4, add the Money and Life entries to `PLACE_TABS` and drop them from "More".
3. **Phase 3, Money hub (#236):** Overview (`/app/money`) · Transactions (`/transactions`) · Bills (`/app/money/bills`, the full recurring list with monthly and yearly totals, statuses and the "unsure" question). The spending check-in is a flow, not a section.
4. **Phase 4, Life hub (#243, merged):** Overview (`/app/life`, also Score and Nudges) · Vault · Insurance · Values · Journal · Insights; "More" now holds only Email → Tasks, Partner, Settings and Help. Legacy pages: see Next up, item 4.
5. **Phase 5, visual pass:** Weightless tokens on every page.

### Waiting on the user
- **Live Stripe purchase test.** Expected: Settings shows Autopilot $9.95 with a renewal date; after cancelling, "Cancelled — you won't be charged again" and a "Keep Autopilot" button.
- **Render `DATABASE_URL`:** change `sslmode=require` → `verify-full` in both the `focusledger` env group and the web service (NODE-EXPRESS-4).
- **`SENTRY_DSN`** must be in the `focusledger` env group so cron errors reach Sentry.
- **Neon and Stripe MCP connectors** fail to connect in cloud sessions, and Neon drops out mid-session too. Stripe needs re-authorizing. Reconnect both at claude.ai/customize/connectors.
- **`renewal-heads-up` cron (#237):** if Render Blueprint sync is off, create it in the dashboard with the `focusledger` env group.
- **Plaid:** the MCP shows zero production usage on team `69e2d08b7146d5000d5a94d1`. Confirm `PLAID_ENV`, and whether Liabilities and Recurring Transactions are enabled. If so, layer them onto the bill guardian.
- **Phone check of the live Weightless page:** tap a radar box, open a subscription review, and confirm the Buddy bubble still opens.

### Backlog (agreed or proposed)
- **Subscription cancel, stage 2 (proposed):** Buddy emails the cancellation from the user's own address.
  - Needs Gmail send scope: `routes/email.js` `GMAIL_SCOPE` is `gmail.readonly` today, so this means another Google verification.
  - Today `draft_and_send_email` sends from the FocusLedger domain with reply-to set to the user.
  - **Stage 3 (browser agent) and stage 4 (cancellation partners or virtual cards): deferred** until there are active users.
- **Grow the cancel-link list** in `lib/cancel-links.js`, but only with well-known, stable URLs.
- **After #218:** add an "Invite an accountability partner" link to the weekly email for people with no partner (`/app/settings?focus=tandem`, scroll to `#tandemSection`).
- **Hardening:**
  1. `user_id NOT NULL` and foreign keys on core tables. Check for orphans first; use a Neon branch.
  2. ~~Silent catches~~ done: #239 (one-liners, `lib/log-failure.js`) and #240 (block catches). `__tests__/no-silent-catches.test.js` now fails CI on any new empty or comment-only catch in server code. Since part 3 it also fails on catches that don't log (e.g. `catch { return null; }`).
  3. Neon point-in-time restore and snapshot schedule.
  4. ~~`routine_task_links` unique key~~ done in #242.
  5. 23 moderate npm advisories.
- **Strategy (decided):**
  - Agentic **type 2** (Buddy acts: bills, subscriptions, start-it-for-me) and **type 3** (shareable outcomes, e.g. "cancelled Netflix, $186/yr back") come first.
  - The MCP server for Claude/ChatGPT/Meta Muse is deferred.
  - Positioning: ADHD-native; the "ADHD tax" from a CPA founder; privacy; partner accountability.
- **News sync runs on an in-process `setInterval`** (`routes/news.js` `startRssCron`), which breaks the no-in-process-schedulers rule. The `rss-sync` cron in `render.yaml` is commented out. Either move it to that cron or drop the feature.
- **AI JSON:** parse model replies with `parseAiJson` from `lib/ai-json.js` (it handles code fences and surrounding prose). Never call `JSON.parse` on a raw model reply.
- **Plaid v1 `connect`** stores the institution *id* as the bank name (`services/PlaidService.js`). The legacy path isn't used by the frontend.
- **`weekly_stats` is never populated** (0 rows in prod; the "P2 cron" was never built). Its columns are integers since #241, so it's ready if a rollup job is ever added.
- **Product loop:** watch the admin Activation card and the `first_checkin_starter` events (#223).

### Production facts (learned the hard way)
- **Scale (Oct 2026):**
  - About 28 real users, 1 active (the founder), about 64 real visitors in 30 days.
  - 19 of 28 never created a task or talked to Buddy.
  - Stripe has never had a subscription. Live account `acct_1Td92HCX9qN8DGgb`.
  - Prices: Autopilot $9.95/$99.95, Tandem $14.95/$149.95.
  - The webhook API version is dahlia: `current_period_end` is on items; the invoice's subscription is at `invoice.parent.subscription_details.subscription`.
- **The prod schema came from Prisma; genesis `CREATE TABLE IF NOT EXISTS` was a no-op.** When something "silently doesn't work", **check the prod column first.** Past traps:
  - missing id defaults and PKs (#219–#221);
  - JSON columns that code writes text into (`tasks.description`, #225);
  - TEXT columns used as booleans (#218);
  - `buddy_checkins` has no `mood` (#229; check-ins store `energy_level`).
  - Missing defaults: `routines.is_active` and `created_at` had none, so every routine was saved inactive (fixed in #242). #253 added about 30 more (tasks, plaid_transactions, partnerships, nudges…). **When you add an INSERT that omits a column, check that column has a default in prod.**
  - Counters stored as text, boolean or timestamp: `routine_streaks.current_streak`/`best_streak`, `routine_suggestions.presented_count`, `routines.day_of_week`, `task_substeps.step_order` and the `weekly_stats` counters (all fixed in #241). If you suspect another one, find it with a prod `information_schema.columns` query.
- **Silent failures:** many routes catch DB errors, log them and return 200. Sentry captures every `console.error`. The CI boot smoke fails on any logged "column/relation … does not exist".
- **Migrations run on every deploy** (`npm start` = `node migrate.js && node server.js`). A failed migration aborts the deploy and the old version keeps serving. Test risky migrations on a Neon branch.
- **Key user IDs:** Sean = 2, **QA user = 25 (never touch)**, Miles = 35.
- **Free plan cap:** free users are capped at **10 active tasks**. `POST /api/tasks` returns 402 `TASK_LIMIT_REACHED`.

### Where things live (Oct 2026 additions)
- **Errors and health:**
  - Sentry: `lib/sentry.js` (`initSentry(name)` in every process).
  - `/health` migration status: `lib/migration-manifest.js` and `db/migrations-status.js`.
- **Billing and admin:**
  - Billing: `lib/billing.js`, `db/billing.js`, `lib/stripe-client.js`.
  - OAuth callbacks: every flow signs `state` with `lib/oauth-state.js` (purpose-bound HMAC, constant-time, 10 min, no fallback secret): `signUserState(purpose, userId)` for connect flows (Calendar `gcal`, `email-gmail`/`-outlook`/`-yahoo`), `signPayload` for Google sign-in (`returnTo` login|signup, trusted host only). Never put a login token in it.
  - Admin gate: `lib/admin-access.js` (`requireAdmin(pool)` middleware after `authenticateToken`, judged from the DB row; sets `req.admin`). Every admin route uses it (`routes/analytics.js` still has its own lookup). It holds the only `isAdminUser`; import it, don't copy it.
  - Activation: `db/activation.js` and `GET /api/admin/activation`.
- **Best-effort work:** use `.catch(logFailure('[Module]', 'op', { userId }, fallback))` from `lib/log-failure.js`. Never use `.catch(() => {})`.
- **AI:** every AI call goes through `lib/claude-client.js` (`createMessage`/`complete`). Per-user daily budget: `lib/ai-budget.js` (Free 100 / Pro 500).
- **Bills and subscriptions:**
  - Bill guardian: `lib/bill-guardian.js` and `db/bills.js`.
    - Detects recurring streams from `plaid_transactions` and buckets them as obligation / subscription / habit / unsure.
    - Creates reminders 3 days before an obligation is due.
    - Settles pending subscription cancellations from bank data (`cancellationVerdict`).
    - Runs in `jobs/plaid-sync.js` and after a bucket answer.
  - API: `GET /api/plaid/recurring` (streams, the one `ask`, settled `cancellations`); `POST …/:key/bucket|keep|cancel`; `DELETE …/:key/cancel`.
  - Cancel pages: `lib/cancel-links.js`. In-card steps: `lib/cancel-help.js` (`POST …/:key/cancel-help`).
  - Agent duplicate-task guard: `lib/task-dedupe.js`, used by `create_task` in `lib/agent-tools.js`.
- **Weightless** (`public/weightless.html`, the one home):
  - Tap-to-complete radar with a reward loop (`public/js/reward.js`, undo, next task steps up).
  - Bills · next 7 days card.
  - Subscription review: cancel (pending → confirmed / charged again from bank data) / keep (rests 90 days) / it's a bill.
- **Routine capture:** `lib/routine-capture.js`.
  - `onTasksCompleted` runs at every task-completion point (Tasks API toggle, update and steps; Buddy; the agent's `mark_task_done`). When a tick finishes a routine's last open task, it records the routine completion and streak.
  - `refreshRoutineTasks` reopens routine tasks finished on an earlier local day (weekly routines after 7 days). It runs when `/api/tasks`, `/api/buddy/status`, `/api/routines` and `/api/today/timeline` load, so there's no cron to set up.
  - **"Done ✓" on pushes (#245):** single-task pushes (deadline reminder, cold-start nudge) carry a signed one-task token (`lib/push-action-token.js`, HMAC with `JWT_SECRET`, 72h). The service worker posts it to `POST /api/push-actions/done` (`routes/push-actions.js`, `db/task-completion.js`), which completes the task and runs `onTasksCompleted`. A process without `JWT_SECRET` just omits the button. iOS web push shows no action buttons.
  - Buddy already auto-completes tasks it hears about in chat (`completionMatches` in `routes/buddy.js`), so with `onTasksCompleted` that now also counts toward routines.
  - **Evening round-up:** after 5pm local, Home (`roundupCard` in `public/weightless.html`) lists today's open routine items that aren't already on the radar, with one tap each. "Not today" hides it per device per day.
  - **Capture plan, still to do:** bank-charge suggestions.
- **Tandem recap:** `lib/tandem-recap.js` and `db/tandem-recap.js`.
- **Insights cron:** `jobs/crossDomainInsightsJob.js` (exports helpers; runs only when executed directly).
- **Claude Code helpers (`.claude/`, committed):** agents `silent-failure-hunter`, `database-reviewer` and `security-reviewer`, plus the skill `postgres-patterns`.
  - They're adapted from ECC (`affaan-m/everything-claude-code`, MIT, commit `b92f181`) and rewritten around this file's rules.
  - Use them for reviews and the hardening backlog, e.g. the silent `catch {}` sweep.
  - **Don't install the full ECC plugin, its hooks, its MCP configs or its auto-update in this repo;** only reviewed copies go in.
  - `.gitignore` keeps the rest of `.claude/` (worktrees, local settings) local.

### Cloud-session gotchas
- **Prod isn't reachable from here:** the egress proxy blocks focusledger.net and onrender.com. Test prod via GitHub Actions or the Render/Sentry MCPs. Render service `srv-d8bpimul51nc73cjdg90`. Sentry org `sean-hendler` (`https://us.sentry.io`).
- **Neon:** project `weathered-cherry-58315264`, prod branch `br-plain-darkness-aphya16p`. `get_connection_string` is blocked by a guardrail; don't work around it.
- **`npm ci` on `main`** fails on `apn`'s GitHub tarball until #218 merges. Workaround: remove `apn` from `package.json`, `npm install`, then `git checkout -- package.json package-lock.json`.
- **Local Postgres:**
  - The container can restart mid-session and take Postgres down. Restart it with `pg_ctlcluster 16 main start`.
  - In a fresh container, first create the role: `su postgres -c "psql -c \"CREATE ROLE fl LOGIN PASSWORD 'fl' CREATEDB\""`, then create the `focusledger` DB owned by `fl`.
  - `DATABASE_URL=postgres://fl:fl@localhost:5432/focusledger`, then `node migrate.js`.
- **Local browser testing:**
  - Start the server: `PORT=3999 JWT_SECRET=x SESSION_SECRET=x node server.js`.
  - Sign up with `POST /api/auth/signup`, set `fl_token` and `fl_user` in localStorage, then open the page with Playwright (`executablePath: '/opt/pw-browsers/chromium'`).
  - Give test users `users.admin_pro_override=true` so the free task cap doesn't block them.
  - Run Playwright scripts from inside the repo, so `require('playwright')` resolves.
- **Merging:** only on the user's explicit "merge N". Use a squash merge with the full 40-character head SHA. A draft PR must be marked ready first (`update_pull_request draft:false`). Use the GitHub MCP, not `gh`.
- **Local rate limiter:** repeated `POST /api/auth/login` in test scripts trips the auth limiter, and pages then bounce to login or Home. Log in once per run, or restart the server.
- **Shell:** never `pkill -f` a pattern that matches your own shell. Find the server by `/proc/<pid>/environ` containing `PORT=3999`.

## Recent changes
- **2026-10-18:** #245 "Done ✓" on task pushes · #246 evening round-up · #247 AI JSON parsing (`parseAiJson`) and news-feed backoff · #248 a single `isAdminUser` · #249 this handoff.
- **2026-10-12 to 10-17:**
  - #238 Claude Code helper agents (silent-failure, database, security reviewers) plus the `postgres-patterns` skill.
  - #239 and #240 silent-catch sweep and its CI guard; 3 dead queries fixed.
  - #241 counter columns to INTEGER (Sentry A, B, 8); the weekly summary counts from tasks.
  - #242 the starter routine is seeded once, at signup only; routines default to active; `routine_task_links` unique key.
  - #243 UI phase 4, Life hub.
  - #244 routine capture: ticking a routine's last task completes the routine, and routine tasks reopen daily (`lib/routine-capture.js`).
  - **Sentry status:** D is fixed and C is quieted in #247. 4 and 5 clear with #218 plus the user's `sslmode` change.
- **2026-10-11 (later):**
  - #233 cancel steps inside the card, no duplicate tasks.
  - #234 UI phase 1, one front door.
  - #235 Tasks hub, plus the `fl_token` fix: pages reading `localStorage.token` instead of `fl_token` were silently signed out. Grep for it when a page "bounces to Home".
  - Found: inline-script syntax errors silently killed `/transactions` and `/reset-password` for three months (fixed in #236). The new parse test guards every page.
  - #236 UI phase 3, Money hub (Overview · Transactions · Bills at `/app/money/bills`), plus `__tests__/inline-scripts-parse.test.js`.
  - #237 renewal heads-up: hourly cron `renewal-heads-up` (`jobs/renewalHeadsUpJob.js`), one push per merchant per renewal date, 10am local, ~7 days ahead; the bill guardian reads 800 days (weekly/monthly use the last 400, `SHORT_CADENCE_WINDOW_DAYS`); Plaid link requests `days_requested: 730` (new connections only). **If Render Blueprint sync is off, create the cron in the dashboard with the `focusledger` env group.**
- **2026-10-11:**
  - #225 bill guardian.
  - #226 Tandem weekly recap.
  - #228 `/api/plaid/diagnostic` made admin-only, with no secret characters in the response.
  - #229 cross-domain-insights job fixed (NODE-EXPRESS-6).
  - #230 Weightless: tap-to-complete radar with a reward loop, a bills card, and the greeting no longer says "Sean" to everyone.
  - #231 subscription review with a cancel page and bank-confirmed cancellation.
- **2026-10-09/10:**
  - #217 Sentry captures logged errors.
  - #219–#221 id sequences and PKs (fixed signups broken since ~May 29).
  - #222 CI traffic excluded from analytics; daily prod signup check.
  - #223 first-session starters.
  - #224 per-user AI budget.
- **Older history:** `public/changelog.html` and `git log`.

## Pre-Ship Checklist

Before any shared CSS change ships, verify all of the following:

1. **Buddy bubble tap test (mobile)** — Open the Buddy panel via the floating bubble on a phone. Verify the panel opens, displays messages, and the send button works. Buddy bubble uses `#bw-bubble` in `public/buddy-widget.css` — ensure no CSS change breaks it.
2. **Mobile viewport check (< 900px)** — Open `/app` at 375px, 428px, and 768px widths. Verify the bottom nav bar renders, task cards display without overflow, and the Chevron (›) buttons are tappable.
3. **Desktop viewport check (≥ 900px)** — Open `/app` at 1280px and 1440px. Verify the left sidebar renders, task cards use the warm-white background, and no new horizontal scrollbar appears.
4. **No new horizontal overflow** — Check `overflow-x: hidden` on body and `max-width` constraints on `.page-content-wrapper`. A removed `border` can change element width calculations — verify no layout reflows.
5. **Sidebar/nav renders correctly** — Verify the 200px left sidebar (desktop) and 60px bottom bar (mobile) both function. Check `shared-nav.css` and `public/shared-nav.js` — these are shared across all 17 app pages.
6. **Update changelog.html** — Every feature, improvement, or fix that ships must get a dated entry in `public/changelog.html`. Format: `<div class="entry">` with day/month + title + 1–2 sentence description + badge (new/improvement/fix/design). If the feature is ADHD-relevant, end the description with a science tie-in: "This maps to [concept] from the [science page](/science) — [1-sentence explanation]." Use the June 2026 section as a template for new month sections.

---

## Claude Code: Autonomous Agent Instructions

This section tells Claude Code how to act on your behalf across GitHub, Neon, and Render. Read this before starting any task.

### Engineering philosophy (Palantir/Addepar standard)

FocusLedger handles financial data and personal mental-health habits. Apply the same rigor expected of serious fintech infrastructure.

**Correctness over velocity.**
Ship slower and right. A silent bug in financial data (wrong balance, missed transaction, miscounted streak) erodes trust faster than a late feature.

**No silent failures. Ever.**
Every `catch` block must either re-throw or log the error with enough context to diagnose it from Render logs alone. A bare `catch {}` or `catch (e) {}` with no logging is a defect, not a style choice. The canonical pattern:
```javascript
} catch (e) {
  console.error('[Module] operationName failed:', e.message, '| contextKey:', contextValue);
  return null; // or throw, depending on caller contract
}
```

**Logs must reflect reality.**
A log line like "Synced 42 transactions" must mean 42 rows were actually written. Never log a count of attempted operations as if they were successful operations. Gate counters and success-path logic on confirmed outcomes.

**Enforce data integrity at the database layer, not just the application layer.**
Unique constraints, foreign keys, NOT NULL, and check constraints belong in the schema. Application-level dedup is a second line of defense, not the first. When adding a uniqueness assumption to code (e.g. `ON CONFLICT (col) DO NOTHING`), verify the corresponding DB constraint exists — and write a migration if it doesn't.

**Financial amounts use NUMERIC, not float arithmetic.**
PostgreSQL `NUMERIC(12,2)` for all money columns. `parseFloat()` is acceptable only for display formatting, never for aggregation or storage.

**Observability is a feature.**
Structured log prefixes like `[Plaid]`, `[BillTasks]`, `[home-context]` are required on every server-side log line. This makes Render log filtering useful in production incidents.

**Fail at the boundary, not in the interior.**
Validate inputs (auth, required fields, enum values) at the route layer. Inside `db/` functions, trust the caller and throw on unexpected errors rather than returning null silently.

---

### Ground rules
- **Always read before writing.** Before touching any file, read it. Before touching any route, read the route file and the db/ file it calls.
- **One concern per commit.** Never bundle unrelated changes. Commit message format: `type(scope): what changed` — e.g. `fix(tasks): normalize due_time in GET response`.
- **Never touch the QA user.** `qa@focusledger.net` is sacred. No data changes, no role changes, no deletions.
- **No raw SQL outside `db/`.** All queries go through `pool.query` in the appropriate `db/` file.
- **No in-process schedulers.** All cron jobs go in `jobs/` and are declared in `render.yaml` as `type: cron` services.
- **server.js hard cap: 300 lines.** If a change would push it over, extract to middleware/ or routes/ first.
- **migrations/ only, never ALTER in routes.** Schema changes always go through a migration file with `{ name, up: async (client) => {} }`.

### GitHub workflow
```bash
# Check current branch before anything
git status
git branch

# Always work on a feature branch, never directly on main
git checkout -b type/short-description   # e.g. fix/plaid-reauth-webhook

# Stage and commit atomically
git add -p                               # review hunks before staging
git commit -m "type(scope): description"

# Push and open PR — never merge your own PRs to main without review
git push -u origin HEAD

# To check what's changed vs main
git diff main...HEAD --stat
```

**Branch naming:** `fix/`, `feat/`, `chore/`, `migration/` prefixes. Always branch from `main`.

**Never force-push to main.** Never commit `.env`, secrets, or `node_modules`.

### Branching in cloud sessions (code.claude.com)

Every cloud session is assigned a dedicated branch via the system prompt — e.g. `claude/task-slug-wXxXx`. That branch is already wired to CI (`branches: [main, "claude/**"]` in `.github/workflows/ci.yml`).

**Rules for cloud sessions:**
1. **Use the assigned branch.** The system prompt always specifies the branch. Develop on that branch — do NOT create a different one.
2. **Do NOT create additional branches** during a session unless the user explicitly asks.
3. **Push to the assigned branch.** Always `git push -u origin <assigned-branch>`.
4. **After merge:** once the session's PR is squash-merged to main, that `claude/<slug>` branch is stale. The next session starts fresh on a new branch — do not re-use old session branches.
5. **Local dev:** use standard prefixes (`fix/`, `feat/`, `chore/`, `migration/`) when working outside a cloud session.

### Neon (PostgreSQL)
Connection is via `DATABASE_URL` env var (already set in Render + local `.env`).

```bash
# Run a migration manually
node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await client.connect();
  // paste migration up() body here
  await client.end();
})();
"

# Inspect a table
psql $DATABASE_URL -c "\d table_name"

# Check row counts (safe read-only audit)
psql $DATABASE_URL -c "SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days';"

# Never run DELETE or UPDATE on production without a WHERE clause
# Always dry-run with SELECT first:
# SELECT * FROM expenses WHERE ... LIMIT 10;
# Then: DELETE FROM expenses WHERE ...;
```

**Migration checklist before running:**
1. Does the migration have a rollback path? (Add a `down` export even if not wired up yet.)
2. Does it touch a high-traffic table? If so, use `CREATE INDEX CONCURRENTLY` not `CREATE INDEX`.
3. Does it add a NOT NULL column? Add with a default first, backfill, then drop the default.

### Render deployment
The app auto-deploys from `main` branch on Render. Do not manually trigger deploys for feature branches.

```bash
# Check Render deploy status (install render-cli first if not present)
render deploys list --service focusledger

# Tail live logs
render logs --service focusledger --tail

# Trigger a manual deploy of main (only when auto-deploy is off)
render deploys create --service focusledger --branch main

# Check env vars (read-only audit — never print secrets)
render env list --service focusledger
```

**Deploy checklist before merging to main:**
1. Run `node --check server.js` — syntax check passes.
2. Run the Pre-Ship Checklist above (Buddy bubble, mobile/desktop viewports, overflow check).
3. Confirm no new `require()` of packages not in `package.json`.
4. If a migration was added: it runs automatically on deploy (`npm start` runs `migrate.js` first) and a failure aborts the deploy. Test risky ones on a Neon branch before merging.

### Environment variables
Never hardcode. All secrets live in `.env` locally and in Render's environment dashboard. Known vars:
- `DATABASE_URL` — Neon connection string
- `SESSION_SECRET` — Express session
- `ANTHROPIC_API_KEY` — AI features (Claude via Anthropic SDK)
- `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` — Plaid integration
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Stripe
- `RESEND_API_KEY` — email delivery
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth
- `ENCRYPTION_KEY` — AES-256-GCM for Plaid tokens (32-byte hex)
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, `APNS_BUNDLE_ID` — iOS push
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — Web Push

If a new env var is needed: add to `.env.example` (with a placeholder value, never real), document it here, and add it to Render manually.

### Task execution patterns

**Bug fix:**
1. Read the failing route + its db/ file.
2. Reproduce with `curl` or a test script if possible.
3. Fix in the narrowest scope possible.
4. Commit on a `fix/` branch, open PR.

**New feature:**
1. Check if a migration is needed — if so, write it first.
2. Write the db/ query file or add to existing.
3. Wire the route in routes/.
4. Add frontend in public/ if needed.
5. Run Pre-Ship Checklist.
6. Commit on `feat/` branch, open PR.

**Schema change:**
1. Write migration in `migrations/` with name + up().
2. Test locally against Neon dev branch (if available) or staging.
3. Run migration manually before deploying.
4. Commit on `migration/` branch.

**Cron job:**
1. Write job file in `jobs/` — standalone Node.js script: create pool, do work, `pool.end()`, exit.
2. Add `type: cron` entry to `render.yaml` with schedule, buildCommand, and startCommand.
3. Env vars: attach the "focusledger" Env Group in the Render dashboard (or copy from web service).
4. Never use `setInterval` or `node-cron` in process.

### What Claude Code should NOT do autonomously
- Merge PRs to `main` without human review
- Delete users, expenses, or plaid_items records in production
- Change `ENCRYPTION_KEY` (would corrupt all Plaid tokens)
- Modify `config/test-users.js` or touch `qa@focusledger.net` data
- Push directly to `main`
- Run `DROP TABLE` or `TRUNCATE` on any production table
- Change Stripe webhook endpoints or Plaid webhook URLs without confirming

### Asking for clarification
If a task is ambiguous about scope (e.g. "fix the Plaid bug" — which one?), ask before touching code. State what you're about to do and why before doing it for any destructive or schema-level operation.
