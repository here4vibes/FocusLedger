# FocusLedger Shipped Engineering Ledger

Machine-readable log of completed engineering tasks. **Consult this first** before starting any new task (see `docs/engineering-playbook.md` §1a).

| task_id | date | summary | files_touched | pages_affected |
|---------|------|---------|---------------|----------------|
| 1752705 | 2026-05-23 | Tier-name codebase sweep — replaced all UI-facing Pro/Premium/Family strings with Free/Autopilot/Tandem; unblocks badge rendering bugs #1720378 and #1747348 | landing-old.html, vault.html, app.html, shared-nav.js, admin.html | /pricing, /vault, /app/tasks, /app/settings |
| 1747801 | 2026-05-21 | Default values seeding audit + fix — corrected canonical order (Autonomy=6,Learning=7,Money=8), added One Tap returning-user seed call, backfill migration for existing users, regression test, playbook section | lib/seedDefaultValues.js, routes/auth.js, migrations/1749050000000_backfill_canonical_values.js, __tests__/seed-default-values.test.js, docs/engineering-playbook.md | /values (data) |
| 1747481 | 2026-05-21 | Buddy Routine Nudge System — 5 DB tables, nudge engine, CRUD API, scheduled job, session-status integration; fixed route ordering bug (static before :id) | migrations/1748970000000_routine_nudge_system.js, db/routineNudges.js, lib/routineNudgeEngine.js, routes/routineNudges.js, jobs/routineNudgeCheck.js, polsia.toml, routes/buddy.js | /app/buddy, /app/checkin |
| 1747433 | 2026-05-21 | Desktop nav polish — fixed sidebar at 900px+, active left-accent indicator, smooth hover states, sidebar hides hamburger; mobile unchanged | public/shared-nav.css, public/shared-nav.js | /app, /money, /buddy, /settings, /journal, /documents, /values |
| 1747360 | 2026-05-21 | Engineering playbook + shipped ledger + CONTRIBUTING.md created | docs/engineering-playbook.md, docs/shipped-ledger.md, CONTRIBUTING.md | none (docs only) |
| 1736443 | 2026-05-20 | Timezone-aware notification + email scheduling — morningNudge, eveningNudge, emailCron send at 8am user local time | morningNudge.js, eveningNudge.js, emailCron.js, routes/admin.js | none (cron only) |
| 1736441 | 2026-05-20 | Verified timezone conversion across all buddy routes — no new code needed, confirmed live in all 4 paths | CLAUDE.md | none (verification) |
| 1720378 | 2026-05-20 | Fixed nav badge showing "PRO" — API now returns plan_label (Autopilot/Tandem/Free) | routes/subscription.js, public/app.html | /app |
| 1718345 | 2026-05-20 | Converted all UTC time logic to user timezone — expenses, buddy patterns, alignment nudges, time-blocks | db/expenses.js, routes/expenses.js, lib/buddyPatterns.js, routes/buddy.js, routes/alignment-nudges.js, routes/alignment-score.js, routes/time-blocks.js, lib/timezone.js | /money, /app/buddy, /app/checkin |
| 1718340 | 2026-05-20 | Fixed morning check-in showing all tasks — added actionable 4-day date filter to /api/tasks/morning-launch | lib/task-filters.js, routes/tasks.js, routes/buddy.js | /app/buddy, /app/checkin |
| 1707482 | 2026-05-19 | Refactored task parsing into clean service boundary — taskParsingService.js zero-coupled, 40+ unit tests | lib/taskParsingService.js, lib/taskParser.js, routes/buddy.js, __tests__/taskParsingService.test.js | /app/buddy, /app/checkin |
| — | 2026-05-19 | Fixed /app/checkin mobile layout — textarea + send button clipped behind bottom nav | public/checkin.html | /app/checkin |
| — | 2026-05-19 | Fixed money.html using 'token' instead of 'fl_token' — logout loop resolved | public/money.html | /money |
| — | 2026-05-19 | iOS waitlist endpoint + table — POST /api/waitlist, 5/hr per IP rate limit | routes/waitlist.js, db/waitlist.js, migrations/1748800000000_ios_waitlist.js | / (landing footer) |
| — | 2026-05-18 | Lead magnet email capture — /api/leads/capture + /api/admin/leads, lead_magnet_emails table | routes/lead-magnets.js, db/lead-magnets.js | /science |
| — | 2026-05-18 | Siri Shortcuts API — /api/siri/today-focus (top 3 tasks, spoken_text), /api/siri/status | routes/siri.js | native (Siri) |
| — | 2026-05-18 | Promo codes system — admin CRUD + user redemption, autopilot_expires_at grants | routes/promo-codes.js, db/promo-codes.js | /settings, /admin |
| — | 2026-05-17 | Email-to-tasks inbound pipeline — magic-link claim, linked-emails CRUD, Autopilot gate | routes/email-to-tasks.js, db/email-to-tasks.js | /link-email |
| — | 2026-05-17 | iOS widget API — /api/widget/tasks top 3 prioritized, timezone-aware, 30-min refresh | routes/widget.js | native (WidgetKit) |
| — | 2026-05-16 | Tandem partnership system — invite flow, active/dissolved status, 14-day trial, partner concerns | routes/buddy.js, migrations (partnerships, partner_concerns) | /app/buddy, /partner-invite |
| — | 2026-05-16 | Buddy engagement cron — 3-day lapse detection, push + session_count reset, day-5 + day-14 re-engagement emails | buddyEngagementCron.js, db/ (buddy_engagement) | none (cron) |
| — | 2026-05-15 | V3 conversational check-in — Coaching Habit flow, 3-5 exchange, buddy_conversations table, day-2 hook | routes/buddy.js, public/checkin.html, migrations (buddy_conversations) | /app/checkin |
| — | 2026-05-14 | Document vault AI extraction — GPT-4o async, per-field confidence, 25/mo cap, review modal | routes/documents.js (inferred), db/documents.js (inferred) | /app/vault |
| — | 2026-05-13 | "I'm stuck" task breakdown — GPT-4o substep generation, task_substeps table, auto-complete parent + confetti | routes/buddy.js, db/substeps.js | /app/buddy |
