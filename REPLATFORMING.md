# FocusLedger Replatforming Guide

Everything you need to rebuild FocusLedger from scratch. A developer reading this should be able to wire up a working production instance without guessing.

---

## 1. Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla HTML/CSS/JS — no framework. Static files served from `/public`. Entry: `public/app.html` |
| **Backend** | Node.js 18+, Express 4.x |
| **Database** | PostgreSQL (Neon managed Postgres — supports branching, auto-suspend) |
| **Deployment** | Render (auto-deployed via GitHub, `render.yaml` in repo root) |
| **Auth** | Custom JWT (HMAC-SHA256, 30-day expiry) + Google OAuth |
| **Email** | Resend (`hello@focusledger.net`) |
| **AI** | Polsia AI proxy (`OPENAI_BASE_URL` → `https://polsia.com/ai/openai/v1`), model `claude-sonnet-4-5` |
| **Payments** | Stripe hosted checkout (subscription links — not API-based) |
| **Bank Sync** | Plaid (Link + Transaction API) |
| **Error Tracking** | Sentry (`@sentry/node`) |
| **Push (iOS)** | APNs via `apn` npm package |

---

## 2. Required Services & Accounts

### Database: Neon Postgres
- Create a project at [neon.tech](https://neon.tech)
- Use connection string as `DATABASE_URL` env var
- Neon uses `sslmode=require` — the `pg` pool is configured to `rejectUnauthorized: false` for Neon
- **Gotcha:** Neon suspends idle branches after 5 min of inactivity. First request after suspend can take ~1s while it wakes. Pool error handler (in `server.js`) recycles dead connections silently — user-facing 500s from dead connections are caught here.

### Auth: Google OAuth
- Create a project in [Google Cloud Console](https://console.cloud.google.com)
- Enable the **Google+ API** or **OAuth 2.0**
- Create OAuth 2.0 credentials (Web application type)
- Set **Authorized redirect URI** to `https://focusledger.net/auth/google-auth/callback`
- Or override via `GOOGLE_AUTH_REDIRECT_URI` env var
- Scopes: `openid email https://www.googleapis.com/auth/userinfo.profile`
- Same credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) handle both sign-in AND Gmail email linking — different routes use different scopes

### Payments: Stripe
- Create a Stripe account
- Create **two subscription products** (monthly + annual, named "Autopilot" per rebrand):
  - Monthly: $29/mo
  - Annual: $290/yr
- Copy the hosted checkout links — they are hardcoded in `routes/subscription.js` (`STRIPE_LINKS` object)
- Update links when Stripe product IDs change — old links create products named "Pro" (pre-rebrand)
- Stripe webhook (`/api/webhooks/stripe`) is NOT currently implemented — subscription status is determined by links, not webhook callbacks
- **Important:** The app does NOT read Stripe keys — it only uses hosted checkout links. The owner completes Stripe identity verification in their own dashboard.

### Email: Resend
- Create an account at [resend.com](https://resend.com)
- Add `hello@focusledger.net` as a verified domain (add DNS records)
- Use the API key as `RESEND_API_KEY`
- From address: `FocusLedger <hello@focusledger.net>` (set via `EMAIL_FROM` env var, defaults to this)
- **Email failures are fire-and-forget** — `sendEmail()` never blocks the calling code

### Bank Sync: Plaid
- Create an account at [plaid.com](https://plaid.com)
- Create a new application (Sandbox for dev, Production for prod)
- Copy `PLAID_CLIENT_ID` and `PLAID_SECRET`
- For production: upgrade to paid Plaid plan
- **Access tokens are encrypted** (AES-256-GCM) with `PLAID_ENCRYPTION_KEY` before storing in DB. Falls back to `JWT_SECRET` if `PLAID_ENCRYPTION_KEY` is unset (legacy tokens continue to decrypt).

### AI: Polsia AI (OpenAI-compatible proxy)
- Provided by Polsia infrastructure — no account setup needed
- `OPENAI_BASE_URL` = `https://polsia.com/ai/openai/v1`
- `OPENAI_API_KEY` = injected automatically by Polsia infra
- Model: `claude-sonnet-4-5`
- **Product AI** (Buddy coaching, daily plans, insights) → routes through `lib/polsia-ai.js`
- **Utility AI** (embeddings, OCR, tagging) → direct OpenAI calls via `lib/auto-tagger.js` and `lib/taskParsingService.js`
- DO NOT use `https://api.openai.com` directly — always route through Polsia proxy

### Error Tracking: Sentry
- Create a project at [sentry.io](https://sentry.io)
- Set `SENTRY_DSN` env var
- SDK initializes in `server.js` before all other requires
- `tracesSampleRate: 0.1` — 10% of requests traced
- `release` set from `RENDER_GIT_COMMIT` env var on Render

### (Optional) iOS Push: APNs
- Requires Apple Developer account + APNs key (.p8 file)
- Env vars: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` (full content of .p8 file), `APNS_BUNDLE_ID`
- Used by iOS Capacitor app only — not required for web app

### (Optional) Custom Domain: focusledger.net
- DNS: Add CNAME record pointing to Render
- Render: Add custom domain in Render dashboard → SSL auto-provisions after DNS propagates
- Currently in `waiting_for_dns` state — DNS not yet pointed to Render

---

## 3. Environment Variables

| Variable | Required | Secret | Description |
|----------|----------|--------|-------------|
| `DATABASE_URL` | ✅ | Yes | Neon PostgreSQL connection string. Include `?sslmode=require`. |
| `JWT_SECRET` | ✅ | Yes | 256-bit+ random string. Signs JWT tokens and CSRF state. Change in prod — all existing tokens invalidated. |
| `NODE_ENV` | ✅ | No | `production` on Render. Enables Sentry, stricter security headers. |
| `PORT` | No | No | Server port (default: 3000). Render sets this automatically. |
| `SENTRY_DSN` | Recommended | Yes | Sentry error tracking. Omit to disable Sentry. |
| `RESEND_API_KEY` | Recommended | Yes | Email delivery. If absent, all `sendEmail()` calls silently no-op. |
| `EMAIL_FROM` | No | No | From address for emails. Default: `FocusLedger <hello@focusledger.net>` |
| `APP_URL` | No | No | Used in email templates for magic link domains. Default: `https://focusledger.net` |
| `GOOGLE_CLIENT_ID` | For OAuth | Yes | Google OAuth client ID. Required for sign-in + Gmail linking. |
| `GOOGLE_CLIENT_SECRET` | For OAuth | Yes | Google OAuth client secret. |
| `GOOGLE_AUTH_REDIRECT_URI` | No | No | Override Google OAuth callback. Default: `https://focusledger.net/auth/google-auth/callback` |
| `PLAID_CLIENT_ID` | For bank sync | Yes | Plaid API client ID. |
| `PLAID_SECRET` | For bank sync | Yes | Plaid API secret. |
| `PLAID_ENCRYPTION_KEY` | Recommended | Yes | AES-256 key for Plaid token encryption. Falls back to `JWT_SECRET` (legacy behavior). Generate: `openssl rand -hex 32` |
| `OPENAI_API_KEY` | Auto-injected | Yes | Provided by Polsia infra. Do not set manually. |
| `OPENAI_BASE_URL` | Auto-injected | No | Points to Polsia AI proxy. Auto-set by Polsia infra. |
| `ALLOWED_ORIGIN` | No | No | Override CORS origin list (comma-separated). Defaults to `focusledger.polsia.app` + `focusledger.net`. |
| `ADMIN_EMAILS` | No | No | Comma-separated emails that get admin access (route `/api/admin/*`). Format: `admin@example.com,owner@example.com` |
| `RENDER_GIT_COMMIT` | Auto-set | No | Git commit hash on Render. Used to set Sentry release. |

### Cron / Background Jobs (Polsia-managed)
These are declared in `polisia.toml` [[crons]] and run by Polsia infrastructure — not by the web server:

```
routine-nudge-check:      */15 * * * *  → node jobs/routineNudgeCheck.js
followup-email-check:     */15 * * * *  → node jobs/followupEmailCheck.js
impulse-spending-check:   */15 * * * *  → node jobs/impulseSpendingCheck.js
plaid-daily-sync:              0 6 * * *  → node jobs/plaid-sync.js
evening-checkin-sender:        0 20 * * * → node jobs/evening-checkin.js
```

---

## 4. Third-Party Integration Details

### Google OAuth
- Used for: Sign-up, sign-in, Gmail email linking (separate from sign-in)
- Flow: Authorization Code → exchange at `https://oauth2.googleapis.com/token` → fetch user info at `https://www.googleapis.com/oauth2/v2/userinfo`
- CSRF protection: HMAC-signed state token (10-min expiry) — see `signState()`/`verifyState()` in `routes/auth.js`
- Sign-up creates new user in `users` table with `google_id` set
- Existing users can link Google account (if `google_id` not already claimed)

### Plaid Bank Sync
- Flow: Link token creation → Plaid Link UI → public token exchange → access token stored (encrypted) → daily transaction sync via cron
- **v1 API** (`routes/v1.js`, `services/PlaidService.js`): Uses `plaid_tokens` table — one active token per user. Newer integration.
- **Legacy** (`routes/plaid.js`): Uses `plaid_items` table — supports multiple linked items per user. Deprecated.
- Transactions written to `plaid_transactions` then confirmed → written to `expenses` table with `source='plaid'`, `plaid_transaction_id` for dedup
- `is_impulse` field: NULL = untriaged, TRUE = impulse, FALSE = planned
- Category auto-mapping: Plaid category strings mapped to FocusLedger categories via `PLAID_CATEGORY_MAP` in `routes/plaid.js`

### Stripe Payments
- Subscription status stored in `app_subscription` table (plan, stripe_subscription_id, status, current_period_end)
- Pro status check: `routes/subscription.js` checks `admin_pro_override` on user first, then falls back to Stripe
- `pro_granted_until` column allows time-limited Pro grants (NULL = permanent)
- `autopilot_expires_at` for promo-code-based Pro access
- Stripe links: `https://buy.stripe.com/eVq28re6bpAA0VBgWlbsc0a` (monthly), `https://buy.stripe.com/3cI14n0fzawwfQv21rbsc0b` (annual)
- No Stripe webhook — subscription updates require manual intervention or re-checkout

### Resend Email
- Two types: transactional (password reset, buddy check-ins) and marketing (v2 launch campaign)
- All emails fire-and-forget from call sites
- `email_log` table tracks sent emails (user_id, to_email, subject, template_type, sent_at)
- Magic links for email-to-tasks: `/api/email-to-tasks/claim?token=xxx` — 72h expiry, single use

---

## 5. Database Schema

### Core Tables

```
users                    — id, email, password_hash (pbkdf2), google_id, name, avatar_url,
                           admin_pro_override, pro_granted_by, pro_granted_until,
                           autopilot_expires_at, tandem_plan, tandem_expires_at,
                           utm_source/medium/campaign, timezone, last_active_at, is_qa_user,
                           created_at, updated_at
app_subscription          — id, user_id, plan, stripe_subscription_id, stripe_customer_id,
                           status, billing_cycle, current_period_end, activated_at, cancelled_at
tasks                    — id, user_id, title, description, is_completed, priority,
                           due_date, due_time, completed_at, created_at, updated_at
task_steps               — id, task_id (FK cascade), title, is_completed, sort_order,
                           completed_at, created_at
categories               — id, name, color, icon (seeded defaults)
expenses                 — id, user_id, amount, description, category_id (FK), expense_date,
                           source ('manual'|'plaid'), is_impulse (NULL/TRUE/FALSE),
                           plaid_transaction_id (unique), created_at
```

### Auth & Security

```
password_reset_tokens     — id, user_id, token_hash (SHA256), expires_at, used_at
account_deletion_tokens   — id, user_id, token_hash (SHA256), expires_at, used_at
```

### ADHD / Productivity Features

```
ideas                    — id, user_id, title, content, created_at
journal_entries          — id, user_id, entry_date, mood_score (1-5), content, created_at
user_values              — id, user_id, value_name, rank, icon, color, created_at
values_alignment_scores  — id, user_id, score (0-100), date, created_at
time_blocks              — id, user_id, title, start_time, end_time, date, created_at
work_hour_blocks         — id, user_id, day_of_week (0=Sun), start_time, end_time, label
focus_sessions           — id, user_id, task_id (FK cascade), planned_duration_seconds,
                           actual_duration_seconds, completed, started_at, ended_at
user_focus_prefs         — body_double_enabled, ambient_style ('cafe'|'library'|'rain'),
                           ambient_volume (0-100); PK user_id
```

### Buddy System

```
buddy_checkins           — id, user_id, type ('morning'|'evening'), checkin_date (UNIQUE),
                           mood_score, content, completed_at, created_at
buddy_daily_plans         — id, user_id, plan_date, mood, tasks (JSONB), reasons (JSONB),
                           accepted (bool), completion_count, created_at
buddy_patterns           — id, user_id, pattern_type, description, confidence_score,
                           occurrence_count, surfaced (bool), dismissed (bool), created_at
buddy_midday_checkins    — id, user_id, checkin_date, type ('post_plan'|'afternoon_energy'|
                           'pre_evening'), mood_score, content, created_at
buddy_engagement         — user_id (PK), consecutive_missed_checkins, hook_restart_count,
                           last_comeback_shown_at, touch flags (push/day5email/day14email)
buddy_conversations      — id, user_id, conversation_date, turn_number, role ('user'|'buddy'),
                           content, created_at
checkin_mode_preferences  — user_id (PK), preferred_mode ('form'|'conversation'),
                           manual_override (bool), session_count
```

### Bank & Money

```
plaid_items              — id, user_id, access_token (AES-256-GCM encrypted), item_id,
                           institution_name, institution_id, created_at
plaid_accounts           — id, item_id (FK), account_id, name, type, mask
plaid_transactions       — id, item_id (FK), transaction_id (Plaid), account_id,
                           date, name, amount, category (Plaid), pending, confirmed,
                           created_at
bill_preferences         — id, user_id, merchant_key, is_enabled (bool), created_at
transactions             — v1 legacy ledger: id, user_id, merchant, amount (cents), category,
                           icon, date, pending, logo_url, planned (bool), is_impulse (bool)
spending_sessions        — id, user_id, start_time, end_time, total_cents, task_id (FK)
transaction_classifications — id, transaction_id (FK), classification, confidence, created_at
```

### Vault & Documents

```
documents                — id, user_id, filename, s3_url, category, expiry_date,
                           extraction_status ('none'|'pending'|'processing'|'done'|'failed'),
                           extraction_confidence (JSONB), extraction_fields (JSONB),
                           created_at, updated_at
ai_extraction_usage      — id, user_id, month (YYYY-MM), count; UNIQUE(user_id, month);
                           capped at 25/month for Free/Pro
insurance_policies       — id, user_id, type, provider, policy_number, coverage_amount,
                           premium, expiry_date, document_url, created_at
coverage_gaps_log        — id, user_id, gap_type, status ('open'|'addressed'|'ignored'), created_at
```

### Nudges & Engagement

```
nudges                   — id, user_id, type ('document_expiry'|'insurance_gap'|'score_drop'|
                           'annual_review'), title, body, action_url, delivered_at, created_at
nudge_preferences         — user_id (PK), push_enabled, buddy_enabled, email_enabled,
                           banner_enabled
followup_email_types      — id, type_key, description (master list: task_reminder, routine_streak,
                           weekly_summary, follow_through)
user_followup_prefs       — user_id, type_key (FK), enabled (bool), preferred_hour
followup_email_log       — id, user_id, type_key (FK), ref_id, ref_type, sent_at (UNIQUE)
notification_send_log     — id, user_id, notification_key, send_date (UNIQUE for dedup), created_at
```

### Email & Communication

```
email_connections         — id, user_id, email_address, imap_token (encrypted), smtp_token
                           (encrypted), last_synced_at, created_at
email_log                 — id, user_id, to_email, subject, template_type, status, sent_at,
                           created_at
linked_emails             — id, user_id, email_address (max 5 per user), verified_at
email_tasks_stash         — id, user_id, from_email, subject, snippet, arrived_at (72h TTL)
customer_emails           — id, user_id, direction ('inbound'|'outbound'), from_email,
                           to_email, subject, body, resend_email_id (UNIQUE), created_at
```

### Routines & Habits

```
routines                  — id, user_id, name, type ('am'|'pm'|'weekly'|'custom'), color,
                           icon, nudge_after_hour, day_of_week, is_active, source_template_id (FK)
routine_task_links        — id, routine_id (FK), task_id (FK); tasks linked to routines
routine_streaks           — id, routine_id (FK), current_streak, best_streak, last_completed_date
routine_templates         — id (global read-only), name, category, description, tasks (JSONB)
detected_patterns         — id, user_id, pattern_type, confidence_score, occurrence_count,
                           task_ids (JSONB), metadata (JSONB), is_active, created_at
routine_suggestions       — id, user_id, suggestion_text, status ('pending'|'accepted'|
                           'dismissed'), presented_count, created_at
routine_nudge_events      — id, routine_id (FK), scheduled_for, status ('pending'|'sent'|
                           'skipped'), sent_at
routine_nudge_prefs       — user_id (PK), enabled (bool), frequency
```

### Growth & Analytics

```
adhd_tax_leads            — id, email, source (UNIQUE), utm_source, utm_medium, created_at
visitor_sessions          — id, session_id (UNIQUE), source, created_at, updated_at
analytics_events          — id, session_id (FK), event_name, properties (JSONB), created_at
insight_unlocks           — id, user_id, insight_key (UNIQUE), unlocked_at, viewed (bool),
                           interacted (bool)
weekly_stats              — id, user_id, week_start, tasks_completed, tasks_created,
                           total_spend_cents, impulse_count, planned_count, evening_sessions,
                           routines_completed, streak_days
task_time_estimations     — id, task_id (UNIQUE), estimated_minutes, actual_minutes,
                           calibration_score; FK cascade with tasks
task_substeps             — id, task_id (FK cascade), substeps (JSONB), created_at
promo_codes               — id, code, type ('free_days'), value (days), max_redemptions,
                           expires_at, is_active, redemption_count
promo_redemptions         — id, promo_code_id (FK), user_id (UNIQUE), redeemed_at
```

### Partnerships (Tandem)

```
partnerships              — id, inviter_id (FK users), invitee_id (FK users),
                           status ('pending'|'active'|'dissolved'), invite_token (UNIQUE, 7d),
                           dissolved_at, tandem_trial_activated_at; one active per user via
                           partial unique index
partner_concerns          — id, from_user_id (FK), about_user_id (FK), topic_area, status,
                           expires_at (7d); concern_text NEVER shown to about_user
```

### Other

```
contact_submissions       — id, user_id, category ('bug'|'account_issue'|'other'),
                           subject, body, page_url, browser_info, status ('pending'|
                           'resolved'), created_at
push_tokens              — id, user_id (FK), token, platform ('ios'), created_at
ios_waitlist             — id, email (UNIQUE), created_at
lead_magnet_emails        — id, magnet_type, email (UNIQUE), created_at
```

---

## 6. Deployment (Render)

### render.yaml
```yaml
services:
  - type: web
    runtime: node
    name: app
    buildCommand: npm install && npm test && npm run migrate
    startCommand: npm start
    healthCheckPath: /health
    envVars:
      - key: NODE_ENV
        value: production
```

### Build Pipeline
1. `npm install` — install all dependencies
2. `npm test` — run Jest tests (fails deploy if any test fails)
3. `npm run migrate` — run all pending migrations in order
4. `npm start` — start Express server on `PORT`

If tests fail, deploy aborts — broken code never ships.

### Health Check
- `GET /health` returns `{ status: 'healthy' }`
- Render hits this path after build and after each deploy
- No auth required — placed before all route mounts

### Environment Variables on Render
Set all required vars in Render dashboard → Environment tab:
- `DATABASE_URL` (required)
- `JWT_SECRET` (required, generate: `openssl rand -hex 32`)
- `NODE_ENV=production`
- `SENTRY_DSN` (recommended)
- `RESEND_API_KEY` (recommended)
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (for OAuth)
- `PLAID_CLIENT_ID` + `PLAID_SECRET` + `PLAID_ENCRYPTION_KEY` (for bank sync)
- `EMAIL_FROM=FocusLedger <hello@focusledger.net>`
- `APP_URL=https://focusledger.net`
- `ADMIN_EMAILS=you@example.com` (optional)

### Custom Domain (focusledger.net)
1. Add CNAME record in DNS: `focusledger.net` → Points to Render's default service URL
2. In Render dashboard → your service → Settings → Custom Domains → Add `focusledger.net`
3. Render auto-provisions SSL after DNS propagates
4. **Current status:** `waiting_for_dns` — DNS not yet pointed to Render

---

## 7. Seed Data & Initial Setup

### Migrations (run automatically on deploy)
Run `npm run migrate` which executes `node migrate.js`. The migrate script:
1. Creates `migrations` table to track what's already applied
2. Runs all `.js` files in `migrations/` directory in order (sorted by filename)
3. Each migration exports `{ name, up: async (client) => {} }`
4. Uses raw SQL via `pool.query` inside migrations

Key migrations to know:
- `001_create_tables.js` — creates core tables + seeds 8 default categories + default budget
- `003_add_user_auth.js` — adds `user_id` FK columns to tasks, expenses, budgets, app_subscription
- `023_add_google_auth.js` — adds `google_id` column to users
- `1748950000000_add_missing_categories.js` — adds 2 missing categories (Housing, Subscriptions)

### User Seed (on signup)
`lib/seedDefaultValues.js` seeds 8 default Maslow-hierarchy values for new users:
1. Health 🏃
2. Security 🏠
3. Relationships ❤️
4. Growth 🌱
5. Creativity 🎨
6. Autonomy ⚡
7. Learning 📚
8. Money 💰

This is called fire-and-forget after signup/first login. Idempotent — only seeds if user has zero values.

### QA User
`config/test-users.js` defines `qa@focusledger.net` as the canonical QA user.
Password: `QA_Test_2026!FocusLedger`
Reset script: `scripts/reset-qa-user.js` — clears all user data without deleting the account.

### Categories
8 default categories seeded in `001_create_tables.js`. 2 more added in `1748950000000_add_missing_categories.js`:
- Food & Dining 🍔, Transport 🚗, Shopping 🛍️, Bills & Utilities 💡, Entertainment 🎮, Health 💊, Groceries 🛒, Other 📦
- + Housing 🏠, Subscriptions 🔄

---

## 8. Known Gotchas

### 1. Neon connection drop after suspend
Neon suspends branches after 5 min idle. The `server.js` pool error handler catches dead connections, but the first request after wake may timeout. `queryWithRetry` in `lib/queryWithRetry.js` adds retry logic for this.

### 2. DATE type parser shifts dates by ±1 day
`server.js` sets `types.setTypeParser(1082, (val) => val)` to return raw "YYYY-MM-DD" strings instead of JS Date objects. Without this, `JSON.stringify` converts dates to UTC, shifting the calendar date if server isn't in UTC. Applied immediately after `pg` import, before pool creation.

### 3. JWT in localStorage (not HttpOnly cookies)
JWT is stored in `localStorage`. This is a known security trade-off. Migration to HttpOnly cookies is noted as future work in `server.js` security comments.

### 4. Plaid encryption key rotation
`PLAID_ENCRYPTION_KEY` falls back to `JWT_SECRET` for legacy tokens. If you rotate `PLAID_ENCRYPTION_KEY`, existing Plaid tokens will fail to decrypt — users must re-link their bank accounts. New tokens use the new key.

### 5. Stripe links hardcoded in subscription route
`STRIPE_LINKS` in `routes/subscription.js` has checkout URLs. These must be updated if Stripe product IDs change. The rebrand (Pro → Autopilot) required new links; old links still exist but create old-named products.

### 6. Buddy widget CSS — fragile at mobile widths
`public/buddy-widget.css` uses `#bw-bubble`. Any shared CSS refactor risks breaking the Buddy bubble on mobile. Pre-ship checklist enforces tap-testing the bubble before any CSS change.

### 7. Service worker cache busting
`/sw.js` served with `Cache-Control: no-store` to prevent browsers from running stale service workers. This is documented in `server.js` — changing this cache header will cause deploy failures where users get old JS.

### 8. CSS cache busting on science.css
`/css/science.css` uses `no-cache, must-revalidate` + query string (handled by frontend). Without this, extracted inline styles failed to reach browsers across 5 deploys.

### 9. In-process cron guards
`server.js` schedules nudges via `scheduleMorningNudges()`, `scheduleEveningNudges()`, etc. These are guarded by `POLSIA_IN_PROCESS_CRONS_ENABLED === 'true'` in the Blaxel shadow migration path. On Render without Blaxel, these run in-process — acceptable since Render is a long-lived web service.

### 10. No Stripe webhook
Subscription status is only updated via hosted checkout link — there is no `/api/webhooks/stripe` handler. If a subscription is cancelled directly in Stripe dashboard, the app won't know until the user re-checks.

### 11. `is_qa_user` flag bypasses limits
Users with `is_qa_user = true` in the `users` table bypass task limits and Pro feature gating. Used for automated testing.

### 12. CORS origins hardcoded
`ALLOWED_ORIGINS` in `middleware/security.js` lists `focusledger.polsia.app` and `focusledger.net`. If deploying to a new domain, must update both the env var and the hardcoded array.