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
- `public/` — all static HTML/CSS/JS; app entry: `public/app.html`
- `lib/` — shared service utilities: email, AI tagging, nudge generation, queryWithRetry, documentExtraction, ai-service
- `public/js/services/` — shared frontend service modules (values-service.js, ai-service.js)
- `services/` — PlaidService, TransactionService, ClassificationService, EventBus, InsightsService, TimeEstimationService
- `jobs/` — scheduled recurring work declared in polsia.toml `[[crons]]`; no in-process schedulers
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
- `bill_preferences` — per-user per-merchant auto-task toggle; merchant_key is normalized name; is_disabled stops task creation
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

## Recent changes
- **2026-05-27** — Energy/Movement Micro-Break Prompts: after 90 min of focus (configurable 45/60/90/120 min), Buddy sends a movement nudge "Stand up, stretch for 2 minutes — I'll wait." New `movement_break` nudge type; cron job `movementBreakCheck.js` checks active sessions against `break_interval_minutes` in `user_focus_prefs`; manual "I need a break" button on Focus Mode page; front-end interval selector (45m/60m/90m/2h).
- **2026-05-27** — Compact task cards with value tag badges: redesigned `.task-card` from blocky to thin single-line layout (~52px min-height); title truncates with ellipsis; colored value-name pill badge from `user_values` table renders on each card; steps hidden in compact view (shown in edit modal); `values-service.js` loaded in tasks.html; `state.valuesMap` caches values for O(1) badge lookup; recurrence icon + steps count badge inline.
- **2026-05-27** — Task card tap-to-expand + recurring settings: slide-down CSS animation (max-height transition, ~280ms); detail view with inline title edit, due date picker, value tag pills, recurring toggle (Off/Daily/Weekdays/Weekly/Monthly) with day selector, notes, steps, delete; tap-outside dismiss; recurring icon (🔄) on collapsed cards; `recurrence_type` + `recurrence_day` fields added to task model; completing a recurring task auto-spawns the next occurrence.
- **2026-05-27** — Tasks page Prisma schema fix: `due_date` added `@db.Date`, `due_time` added `@db.Time(6)`, `auto_complete_transaction_id` changed `String?→Int?` to match actual DB column types. `routes/tasks-prisma.js` now uses `timeStrToDate()` (write) and `dateToTimeStr()`/`normTask()` (read) to bridge PostgreSQL time/date types with Prisma DateTime mapping. All task API responses normalized so frontend receives `"HH:MM"` strings.
- **2026-05-26** — Quick-Add FAB: floating action button (+, bottom-right) on all 4 tabs (Tasks/Money/Vault/Buddy). Pre-focused modal with title input + real-time date chip suggestions. Natural language date parsing via `public/js/date-parser.js`: tomorrow, today, next [day], [day name], at [time], [time] combos. Backend: `due_time` added to `POST /api/tasks` in `routes/tasks-prisma.js`.
- **2026-05-26** — Vault: fix `+ +` double-plus typo in card rendering (caused NaN in summary); fix `runExtractionAsync` to write `summaryText` back into `metadata.summary` before storing (prevents raw JSON leaking into card); guard `renderConfirmedMeta` and `renderReviewFields` against JSON-artifact summaries; textarea for long summaries in review modal; expand category typeMap for medical/health insurance cards; DB backfill fixed `extraction_status` for legacy `ai_extracted=true/status=none` docs.

## Pre-Ship Checklist

Before any shared CSS change ships, verify all of the following:

1. **Buddy bubble tap test (mobile)** — Open the Buddy panel via the floating bubble on a phone. Verify the panel opens, displays messages, and the send button works. Buddy bubble uses `#bw-bubble` in `public/buddy-widget.css` — ensure no CSS change breaks it.
2. **Mobile viewport check (< 900px)** — Open `/app` at 375px, 428px, and 768px widths. Verify the bottom nav bar renders, task cards display without overflow, and the Chevron (›) buttons are tappable.
3. **Desktop viewport check (≥ 900px)** — Open `/app` at 1280px and 1440px. Verify the left sidebar renders, task cards use the warm-white background, and no new horizontal scrollbar appears.
4. **No new horizontal overflow** — Check `overflow-x: hidden` on body and `max-width` constraints on `.page-content-wrapper`. A removed `border` can change element width calculations — verify no layout reflows.
5. **Sidebar/nav renders correctly** — Verify the 200px left sidebar (desktop) and 60px bottom bar (mobile) both function. Check `shared-nav.css` and `public/shared-nav.js` — these are shared across all 17 app pages.