# FocusLedger — Company Context Bible

> **What this file is:** Single source of truth for anyone (human or agent) who needs to understand FocusLedger fast. Update here first — no regenerating from scratch.

---

## Company

**Name:** FocusLedger
**Mission:** Help ADHD adults get things done — with structure, accountability, and less friction.
**Tagline:** "Your brain's exoskeleton"
**Target user:** Adults with ADHD (diagnosed or self-identified), especially those who are accomplished but struggle with executive function. Built by a CPA with ADHD.
**Core promise:** Executive functioning on autopilot — tasks, money, habits, and a Buddy that keeps you honest.

---

## Product

**What it does:** ADHD-native personal command center. One app, four tabs.

| Tab | What it does |
|-----|--------------|
| **Tasks** | Todo list with due dates, steps, recurrence, AI breakdown for hard tasks. Core feature. |
| **Money** | Spending tracker (manual + Plaid bank sync). Impulse detection. Account summary with live balances. Pro-gated. |
| **Vault** | Document storage with AI extraction. Insurance policies, receipts, life admin. |
| **Buddy** | Daily check-ins (morning focus + evening recap). AI coaching conversations. Detected behavioral patterns. Streak tracking. |

**Supporting surfaces:** Landing page (focusledger.net), Settings, Routines, Journal, Ideas, Values, Email→Tasks, Partner Dashboard (Tandem).

---

## Tech Stack

- **Backend:** Node.js + Express.js
- **Database:** PostgreSQL via Neon (Prisma ORM for new code, raw `pg` for legacy)
- **Frontend:** Vanilla HTML/CSS/JS (static files from `/public`)
- **Hosting:** Render (port 10000)
- **App URL:** https://focusledger.polsia.app
- **External:** focusledger.net (apex domain, manual DNS)

**Integrations:**
- **Google OAuth** — primary signup/login via Polsia platform
- **Plaid** — bank account sync (link tokens, token exchange, transaction sync, bill detection)
- **Resend** — transactional email (hello@focusledger.net, SPF/DKIM live)
- **Sentry** — error tracking with commit-level release tracking
- **Stripe** — hosted payment links for subscription (Autopilot plans)

**⚠️ Platform constraint:** Polsia does NOT support Next.js. Express.js only.

---

## Architecture

- **Entry point:** `server.js` (293 lines, under 300-line cap)
- **Routing:** `routes/` — one file per endpoint group via `express.Router()`. Mounts under `/api/*` or `/api/v1/*`
- **Database:** `db/` — one file per table/table-group. All SQL via `pool.query`. Raw SQL outside `db/` is forbidden.
- **Static pages:** `public/app/*.html` — one per tab/surface
- **Service layer:** `lib/` — shared utilities (email, AI tagging, nudge generation, document extraction)
- **Scheduled work:** `jobs/` — all recurring work declared in `polsia.toml` `[[crons]]`; no in-process schedulers
- **Prisma:** New code uses Prisma (`prisma/schema.prisma`). Legacy code uses raw `pg`.

---

## Shipping Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Done | Audit + cleanup |
| Phase 2 | ✅ Done | Prisma migration: auth, values, tasks, steps, nudges, settings |
| Phase 3A | ✅ Done | Tasks tab modernized — Prisma CRUD + standalone `/app/tasks` |
| Phase 3B | 🚀 In progress | Money tab — Prisma expense CRUD, Plaid sync, live balances, account summary |
| Phase 3C | ⏳ Planned | Vault + Buddy + secondary pages |

**Test suite:** 162/162 passing (Phase 3A baseline). Phase 3B has ~3% pre-existing pool-mock test failures (non-blocking for Render deploy).

---

## Signup Architecture

- **Google OAuth only** — via Polsia platform. No custom signup form.
- **Geographic gating:** Pending decision. Hard block for USA + Europe being considered to stop spam signups from Calcutta/Singapore. Not yet implemented.

---

## Domain

- **External:** focusledger.net (apex domain, manual DNS, active)
- **App:** focusledger.polsia.app (Polsia-provisioned)
- **Canonical:** focusledger.net

---

## Key Decisions Log

| Decision | Reason |
|----------|--------|
| **Express.js over Next.js** | Polsia platform constraint — only Express.js supported |
| **Single shared email (hello@focusledger.net)** | One email for email-to-tasks; sender verification gates auto-task creation |
| **Prisma for new code, raw pg for legacy** | Phase 2 migration introduced Prisma incrementally; not all legacy db/ files migrated |
| **4 isolated tab routes** (`/app/tasks`, `/app/money`, `/app/vault`, `/app/buddy`) | Cleaner separation, easier to test, no cross-tab state leakage |
| **No in-process schedulers** | polsia.toml `[[crons]]` is the single source of truth for recurring work |
| **`fl_token` JWT in localStorage** | Historical decision; HttpOnly cookie migration is future work |
| **`is_qa_user` flag bypasses paywalls** | QA users get full Pro access; useful for testing |

---

## User Preferences

Owner is direct, pragmatic, and values shipping velocity. Clarifying questions before implementation are appreciated — don't assume.

---

## Pending Work

- **Phase 3B (Money tab):** Complete — Prisma CRUD, Plaid sync, live balances done. Account summary card live.
- **Phase 3C:** Vault + Buddy + secondary pages
- **Geographic signup gating:** Decision pending on USA/Europe hard block
- **Subscription audit feature:** Not started (see ROADMAP.md)
- **Values-aligned spending reports:** Not started (see ROADMAP.md)
- **Tandem accountability partner:** Not fully live (partnerships table exists, UI not complete)

---

*Last updated: 2026-05-25*