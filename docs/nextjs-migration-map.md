# FocusLedger → Next.js + Prisma Migration Map

> Phase 1 Audit · Generated 2026-05-24 · Source: codebase analysis

---

## Source Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Vanilla HTML/CSS/JS in `public/` | 47 HTML files, no framework |
| Backend | Express.js (`server.js` + `routes/`) | 64 route files |
| Database | PostgreSQL on Neon | 88 migration files, node-postgres |
| Auth | Custom JWT (HMAC-SHA256) + Google OAuth | Tokens stored in `localStorage`, transition to HttpOnly cookies needed |
| AI | OpenAI via `lib/polsia-ai.js` + `lib/ai-service.js` | GPT-4o for Buddy, GPT-4o-mini for task suggestions |
| File Storage | Polsia R2 via `POLSIA_R2_BASE_URL` env var | Document uploads in `routes/documents.js` |
| Email | Resend via `lib/emailService.js` | Both transactional and inbound (inbox) |
| Payments | Stripe hosted checkout links | `routes/subscription.js`, Polsia payment verification |
| Bank Sync | Plaid Link (v2025-01-15 API) | `routes/plaid.js`, AES-256-GCM encrypted tokens |
| Deploy | Render (port 10000) | `npm run migrate && npm start` |
| Cron | `polsia.toml` [[crons]] + in-process setTimeout in server.js | See server.js lines 266–289 |

---

## Page Route Map

### Primary App Pages (4 tabs — isolated routes as of 2026-05-23)

| Original File | Route | Purpose | Auth | Shared Components |
|---------------|-------|---------|------|-------------------|
| `public/app.html` | `GET /app/tasks` | Tasks dashboard (main entry) | Required | `shared-nav.js`, `shared-nav.css` |
| `public/money.html` | `GET /app/money` | Money/expenses dashboard | Required | `shared-nav.js`, `plaid-service.js` |
| `public/vault.html` | `GET /app/vault` | Life section → Vault (documents) | Required | `shared-nav.js`, `ai-service.js` |
| `public/buddy.html` | `GET /app/buddy` | Accountabilibuddy check-in | Required | `shared-nav.js`, `ai-service.js` |

### Secondary App Pages

| Original File | Route | Purpose | Auth | Notes |
|---------------|-------|---------|------|-------|
| `public/settings.html` | `GET /app/settings` | Account settings + subscription | Required | Standalone (not nav-driven) |
| `public/checkin.html` | `GET /app/checkin` | Morning check-in flow | Required | |
| `public/checkin-evening.html` | `GET /app/checkin/evening` | Evening swipe/check-in | Required | |
| `public/app/task.html` | `GET /app/task/:taskId` | Task detail view | Required | |
| `public/app/focus.html` | `GET /app/focus/:taskId` | Focus Mode (body double) | Required | |
| `public/routines.html` | `GET /routines` | Routine builder + templates | Required | |
| `public/ideas.html` | `GET /ideas` | Quick capture ideas | Required | |
| `public/values.html` | `GET /values` | Maslow values list + alignment | Required | |
| `public/journal.html` | `GET /journal` | Daily journal + mood | Required | |
| `public/calendar.html` | `GET /calendar` | Time blocks calendar | Required | |
| `public/email.html` | `GET /email` | Email→Tasks magic link setup | Required | |
| `public/transactions.html` | `GET /transactions` | Transaction list + review | Required | |
| `public/insights.html` | `GET /insights` | Progressive Insights dashboard | Required | |
| `public/vault.html` (aliased) | `GET /app/life/vault` | Same as /app/vault | Required | Life section alias |
| `public/insurance.html` | `GET /app/life/insurance` | Insurance tracker | Required | |
| `public/nudges.html` | `GET /app/life/nudges` | Nudge preferences/history | Required | |
| `public/partner-dashboard.html` | `GET /partner-dashboard` | Tandem partner dashboard | Required | |
| `public/share.html` | `GET /share` | Share/promotion flow | Required | |

### Auth Pages

| Original File | Route | Purpose | Auth |
|---------------|-------|---------|------|
| `public/login.html` | `GET /login` | Email/password login | None |
| `public/signup.html` | `GET /signup` | Email/password signup | None |
| `public/forgot-password.html` | `GET /forgot-password` | Password reset request | None |
| `public/reset-password.html` | `GET /reset-password` | Password reset (token in URL) | None |
| `public/confirm-delete.html` | `GET /confirm-delete` | Account deletion confirmation | Required |
| `public/link-email.html` | `GET /link-email` | Email→Tasks magic link claim | Optional |
| `public/partner-invite.html` | `GET /partner-invite` | Tandem invite acceptance | Optional |

### Marketing / Landing Pages

| Original File | Route | Purpose |
|---------------|-------|---------|
| `public/index.html` | `GET /` | Landing page (injects Polsia analytics slug) |
| `public/adhd-tax.html` | `GET /adhd-tax` | ADHD Tax Calculator (email capture) |
| `public/pricing.html` | `GET /pricing` | Pricing page |
| `public/story.html` | `GET /story` | About/Founder story |
| `public/science.html` | `GET /science` | ADHD Science page (no-store cache header) |
| `public/changelog.html` | `GET /changelog` | Product changelog |
| `public/terms.html` | `GET /terms` | Terms of service |
| `public/privacy.html` | `GET /privacy` | Privacy policy |
| `public/contact.html` | `GET /contact` | Contact form |
| `public/news.html` | `GET /news` | News/RSS feed display |
| `public/assets/adhd-science-cheatsheet.html` | `GET /assets/adhd-science-cheatsheet` | Lead magnet PDF-like page |
| `public/assets/daily-three-template.html` | `GET /assets/daily-three-template` | Lead magnet template |
| `public/install.html` | `GET /install` | PWA install prompt |
| `public/landing-old.html` | `GET /landing-old` | Old landing page (revert point) |

### Admin Pages

| Original File | Route | Purpose | Auth |
|---------------|-------|---------|------|
| `public/admin.html` | `GET /admin/stats` | Admin stats dashboard | Admin |
| `public/ideas.html` | `GET /admin/ideas` | Admin idea management | Admin |

### Redirect Routes (backward compat aliases)

| Route | Redirects to |
|-------|-------------|
| `GET /money` | → 301 `/app/money` |
| `GET /vault` | → 301 `/app/vault` |
| `GET /documents` | → 301 `/app/vault` |
| `GET /buddy` | → 301 `/app/buddy` |
| `GET /app` | → 301 `/app/tasks` |

---

## API Route Map

> All routes live in `routes/<name>.js`. Mount paths shown before the file.

### Auth & Identity

| Route | Methods | File | Purpose | Auth |
|-------|---------|------|---------|------|
| `/api/auth/signup` | POST | `routes/auth.js` | Email/password signup | None |
| `/api/auth/login` | POST | `routes/auth.js` | Email/password login | None |
| `/api/auth/me` | GET | `routes/auth.js` | Current user profile | Required |
| `/api/auth/google/start` | GET | `routes/auth.js` | Start Google OAuth flow | None |
| `/api/auth/google/callback` | GET | `routes/auth.js` | Google OAuth callback | None |
| `/api/auth/google/one-tap` | POST | `routes/auth.js` | GIS credential sign-in | None |
| `/api/auth/google/link-password` | POST | `routes/auth.js` | Link password to Google account | Required |
| `/api/auth/forgot-password` | POST | `routes/auth.js` | Request password reset | None |
| `/api/auth/reset-password` | POST | `routes/auth.js` | Set new password from token | None |
| `/api/auth/attribution` | PATCH | `routes/auth.js` | Save UTM attribution | Required |
| `/api/auth/migrate-demo-session` | POST | `routes/auth.js` | Hydrate account from Buddy demo | Required |
| `/api/auth/profile` | PATCH | `routes/auth.js` | Update display name | Required |

### Tasks

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/tasks` | GET, POST | `routes/tasks.js` | List tasks (with filters/sort), create task |
| `/api/tasks/summary` | GET | `routes/tasks.js` | Dashboard summary counts |
| `/api/tasks/nudges` | GET | `routes/tasks.js` | Tasks approaching due date |
| `/api/tasks/suggest-steps` | POST | `routes/tasks.js` | AI step suggestions (Pro) |
| `/api/tasks/suggest-duration` | POST | `routes/tasks.js` | AI duration estimate |
| `/api/tasks/:id` | GET, PATCH, DELETE | `routes/tasks.js` | CRUD single task |
| `/api/tasks/:id/toggle` | PATCH | `routes/tasks.js` | Toggle completion + spawn recurring |
| `/api/tasks/:id/duration` | PATCH | `routes/tasks.js` | Set duration manually |
| `/api/tasks/:taskId/steps` | POST | `routes/tasks.js` | Add step to task |
| `/api/tasks/:taskId/steps/:stepId` | PATCH, DELETE | `routes/tasks.js` | Update/delete step |
| `/api/tasks/:taskId/steps/:stepId/toggle` | PATCH | `routes/tasks.js` | Toggle step + auto-complete parent |
| `/api/tasks/morning-launch` | GET, POST | `routes/tasks.js` | Effort-sorted task launcher + session record |
| `/api/tasks/streak` | GET | `routes/tasks.js` | Morning launch streak info |

### Money & Expenses

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/expenses` | GET, POST | `routes/expenses.js` | List/create expenses |
| `/api/v1/transactions` | GET | `routes/v1.js` | Transaction list (v1 API) |
| `/api/v1/spending-sessions` | GET, POST | `routes/spending-sessions.js` | Spending session tracking |

### Bank Sync (Plaid)

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/plaid/status` | GET | `routes/plaid.js` | Plaid config status + connected items |
| `/api/plaid/create-link-token` | POST | `routes/plaid.js` | Start Plaid Link OAuth |
| `/api/plaid/exchange-token` | POST | `routes/plaid.js` | Exchange public token → access token |
| `/api/plaid/sync` | POST | `routes/plaid.js` | Manual transaction sync |
| `/api/plaid/transactions/pending` | GET | `routes/plaid.js` | Unconfirmed transactions for review |
| `/api/plaid/transactions/:id/category` | PATCH | `routes/plaid.js` | Re-categorize transaction |
| `/api/plaid/transactions/:id/confirm` | POST | `routes/plaid.js` | Confirm transaction → create expense |
| `/api/plaid/transactions/confirm-all` | POST | `routes/plaid.js` | Bulk confirm all pending |
| `/api/plaid/transactions/:id/dismiss` | POST | `routes/plaid.js` | Dismiss transaction |
| `/api/plaid/bills` | GET | `routes/plaid.js` | List detected recurring bills |
| `/api/plaid/bills/:key/disable` | POST | `routes/plaid.js` | Disable auto-task for merchant |
| `/api/plaid/bills/:key/enable` | POST | `routes/plaid.js` | Re-enable auto-task |
| `/api/plaid/items/:id` | DELETE | `routes/plaid.js` | Disconnect bank account |

### Subscription & Payments

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/subscription/status` | GET | `routes/subscription.js` | Subscription status + task limits |
| `/api/subscription/activate` | GET | `routes/subscription.js` | Stripe checkout success redirect (no JWT, email lookup) |
| `/api/subscription/webhook` | POST | `routes/subscription.js` | Polsia payment webhook |
| `/api/subscription/cancel` | POST | `routes/subscription.js` | Cancel subscription |
| `/api/subscription/reactivate` | POST | `routes/subscription.js` | Reactivate subscription |

### Buddy / Accountabilibuddy

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/buddy/status` | GET | `routes/buddy.js` | Today's check-in state + tasks |
| `/api/buddy/login-checkin-status` | GET | `routes/buddy.js` | Post-login check-in due |
| `/api/buddy/login-checkin-done` | POST | `routes/buddy.js` | Mark post-login check-in done |
| `/api/buddy/session-status` | GET | `routes/buddy.js` | V3 session count + daily plan status |
| `/api/buddy/increment-session` | POST | `routes/buddy.js` | Increment session count |
| `/api/buddy/conversation` | POST | `routes/buddy.js` | V3 coaching conversational turn |
| `/api/buddy/generate-insights` | POST | `routes/buddy.js` | First-session personalized insight |
| `/api/buddy/daily-plan` | GET | `routes/buddy.js` | Get or generate today's AI plan |
| `/api/buddy/daily-plan/accept` | POST | `routes/buddy.js` | Accept the plan |
| `/api/buddy/daily-plan/swap` | POST | `routes/buddy.js` | Swap one task in the plan |
| `/api/buddy/daily-plan/regenerate` | POST | `routes/buddy.js` | Regenerate the plan |
| `/api/buddy/morning` | POST | `routes/buddy.js` | (legacy) Store morning focus |
| `/api/buddy/break-down` | POST | `routes/buddy.js` | "I'm stuck" → AI micro-steps |
| `/api/buddy/substeps/:taskId` | GET | `routes/buddy.js` | Fetch saved substeps |
| `/api/buddy/demo` | POST | `routes/buddy-demo.js` | Anonymous Buddy demo session |
| `/api/buddy-widget/*` | * | `routes/buddy-widget.js` | Buddy floating widget |
| `/api/buddy/conversations/:date` | GET, POST | `routes/buddy.js` | Buddy conversation history |
| `/api/buddy/concerns` | POST | `routes/buddy.js` | Send partner concern signal |

### Documents / Vault

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/documents` | GET, POST | `routes/documents.js` | List documents, upload (multer) |
| `/api/documents/usage/ai` | GET | `routes/documents.js` | AI extraction usage remaining |
| `/api/documents/:id` | GET, PATCH, DELETE | `routes/documents.js` | Get/update/delete document |
| `/api/documents/:id/extraction-status` | GET | `routes/documents.js` | Poll async AI extraction state |
| `/api/documents/:id/confirm-metadata` | PATCH | `routes/documents.js` | User confirms extracted metadata |

### AI Endpoints

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/ai/summarize` | POST | `routes/ai.js` | Generic text summarization |
| `/api/ai/suggest-tasks` | POST | `routes/ai.js` | Parse freeform text → task suggestions |
| `/api/ai/extract-fields` | POST | `routes/ai.js` | Document field extraction (GPT-4o) |
| `/api/ai/parse-ai-response` | POST | `routes/ai.js` | Normalize AI raw response |
| `/api/ai-suggestions/break-down` | POST | `routes/ai-suggestions.js` | "I'm stuck" task decomposition |

### Values & Alignment

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/values` | GET, POST | `routes/values.js` | List/create user values |
| `/api/values/:id` | PATCH, DELETE | `routes/values.js` | Update/delete value |
| `/api/alignment-score` | GET, POST | `routes/alignment-score.js` | Daily values alignment check-in |

### Journal & Check-ins

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/journal` | GET, POST | `routes/journal.js` | Journal entries with mood |
| `/api/journal/:id` | PATCH, DELETE | `routes/journal.js` | Update/delete entry |
| `/api/check-in/*` | * | `routes/check-in.js` | Morning/evening check-in flow |
| `/api/evening/*` | * | `routes/evening-checkin.js` | Evening spending review |
| `/api/comeback/*` | * | `routes/comeback.js` | Re-engagement flow |

### Routines

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/routines` | GET, POST | `routes/routineNudges.js` | List/create routines |
| `/api/routines/:id` | GET, PATCH, DELETE | `routes/routineNudges.js` | CRUD routine |
| `/api/routines/:id/toggle` | PATCH | `routes/routineNudges.js` | Toggle routine completion |
| `/api/auto-routines/*` | * | `routes/autoRoutines.js` | AI-detected pattern → routine |
| `/api/v1/routine-templates` | GET | `routes/autoRoutines.js` | Pre-built routine templates |

### Focus Mode

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/v1/focus-sessions` | GET, POST | `routes/focus-sessions.js` | Focus session start/end/complete |
| `/api/v1/focus-preferences` | GET, PATCH | `routes/focus-prefs.js` | Body double + ambient layer prefs |
| `/api/v1/time-estimations` | GET, POST | `routes/time-estimations.js` | Time-blindness calibration |

### Insights & Analytics

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/v1/insights` | GET | `routes/insights.js` | Progressive insights tiers |
| `/api/health-score` | GET | `routes/health-score.js` | Habit/health score tracking |
| `/api/analytics/*` | * | `routes/analytics.js` | Page/event tracking |
| `/api/analytics/events` | POST | `routes/analytics.js` | Track anonymous event |

### Notifications & Nudges

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/notifications` | GET | `routes/notifications.js` | User notifications list |
| `/api/notifications/:id/read` | PATCH | `routes/notifications.js` | Mark notification read |
| `/api/notifications/:id/read-all` | PATCH | `routes/notifications.js` | Mark all read |
| `/api/v1/notifications/*` | * | `routes/notifications-v1.js` | v1 notification endpoints |
| `/api/nudge-system/*` | * | `routes/nudge-system.js` | Nudge preferences + history |
| `/api/nudges` | GET | `routes/alignment-nudges.js` | Values-alignment nudges |

### Insurance

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/insurance/policies` | GET, POST | `routes/insurance.js` | List/add insurance policies |
| `/api/insurance/policies/:id` | PATCH, DELETE | `routes/insurance.js` | Update/delete policy |
| `/api/insurance/gaps` | GET | `routes/insurance.js` | Coverage gap detection |

### Partnerships (Tandem)

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/partnerships/status` | GET | `routes/partnerships.js` | Active/pending/none status |
| `/api/partnerships/invite` | POST | `routes/partnerships.js` | Generate invite link |
| `/api/partnerships/accept` | POST | `routes/partnerships.js` | Accept invite |
| `/api/partnerships/dissolve` | POST | `routes/partnerships.js` | Dissolve partnership |
| `/api/partnerships/tasks` | GET | `routes/partnerships.js` | Partner's shared tasks |
| `/api/partnerships/feed` | GET | `routes/partnerships.js` | Partner completion feed |
| `/api/partnerships/concern` | POST | `routes/partnerships.js` | Send partner concern |
| `/api/partnerships/tandem-activate` | POST | `routes/partnerships.js` | Activate Tandem subscription |

### Email & Inbox

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/email` | GET, POST | `routes/email.js` | Email linking status + connect |
| `/api/email/auth/callback` | GET | `routes/email.js` | Gmail OAuth callback |
| `/api/email/verify-code` | POST | `routes/email.js` | Verify magic link code |
| `/api/email/disconnect` | POST | `routes/email.js` | Disconnect email connection |
| `/api/inbox` | GET | `routes/inbound-email.js` | Admin two-way inbox |
| `/api/inbox/:threadId` | GET, POST | `routes/inbound-email.js` | Thread messages + reply |
| `/api/inbox/:threadId/read` | PATCH | `routes/inbound-email.js` | Mark thread read |
| `/api/inbox/unread-count` | GET | `routes/inbound-email.js` | Unread count |
| `/api/webhooks/resend-inbound` | POST | `routes/inbound-email.js` | Resend inbound webhook |
| `/api/email-to-tasks/*` | * | `routes/email-to-tasks.js` | Magic link + inbound task creation |
| `/api/outbound-email/*` | * | `routes/outbound-email.js` | Outbound email sending |

### Other

| Route | Methods | File | Purpose |
|-------|---------|------|---------|
| `/api/ideas` | GET, POST | `routes/ideas.js` | Quick capture ideas |
| `/api/ideas/:id` | PATCH, DELETE | `routes/ideas.js` | Update/delete idea |
| `/api/time-blocks` | GET, POST | `routes/time-blocks.js` | Calendar focus blocks |
| `/api/time-blocks/:id` | PATCH, DELETE | `routes/time-blocks.js` | Update/delete block |
| `/api/work-hours` | GET, POST | `routes/work-hours.js` | Work hour preferences |
| `/api/recurring` | GET, POST | `routes/recurring.js` | Recurring task templates |
| `/api/recurring/:id` | PATCH, DELETE | `routes/recurring.js` | Update/delete recurring |
| `/api/contact` | POST | `routes/contact.js` | Contact form submission |
| `/api/adhd-tax/*` | * | `routes/adhd-tax.js` | ADHD Tax calculator + email capture |
| `/api/news` | GET | `routes/news.js` | RSS feed management |
| `/api/waitlist` | POST | `routes/waitlist.js` | iOS waitlist sign-up |
| `/api/leads/*` | GET, POST | `routes/lead-magnets.js` | Lead magnet email collection |
| `/api/admin/promo-codes/*` | * | `routes/promo-codes.js` | Admin promo CRUD |
| `/api/promo/*` | * | `routes/promo-codes.js` | User promo redemption |
| `/api/account-deletion/*` | * | `routes/account-deletion.js` | Self-service account deletion |
| `/api/siri/*` | * | `routes/siri.js` | Siri shortcut endpoints |
| `/api/followup-emails/*` | * | `routes/followupEmails.js` | Scheduled follow-up emails |
| `/api/push-tokens` | POST | `routes/push-tokens.js` | Register APNs device token |
| `/api/widget/*` | * | `routes/widget.js` | Widget/embed endpoints |
| `/health` | GET | `server.js` | Health check (no auth) |

---

## Prisma Schema

> Full schema derived from 88 migration files, ordered by dependency. Tables with `user_id` are user-scoped.

### Core Application Tables

```prisma
// ── Users & Auth ────────────────────────────────────────────────────────────

model users {
  id                          SERIAL PRIMARY KEY
  email                       VARCHAR(255) UNIQUE NOT NULL
  name                        VARCHAR(100)
  password_hash               VARCHAR(255)          // salt:hash format, PBKDF2-SHA512
  google_id                   VARCHAR(255)
  auth_method                 VARCHAR(20) DEFAULT 'password'  // 'password'|'google'|'both'
  avatar_url                  TEXT
  timezone                    VARCHAR(50)
  utm_source/medium/campaign/content/term  VARCHAR(500)
  signup_referrer             VARCHAR(500)
  login_count                 INTEGER DEFAULT 0
  last_login_at               TIMESTAMPTZ
  last_active_at              TIMESTAMPTZ
  admin_pro_override          BOOLEAN DEFAULT FALSE
  pro_granted_by              VARCHAR(20)          // 'stripe'|'admin'|NULL
  pro_granted_until           TIMESTAMPTZ           // NULL = permanent
  autopilot_expires_at         TIMESTAMPTZ            // Promo code expiry
  tandem_plan                  VARCHAR(20)
  tandem_expires_at           TIMESTAMPTZ
  tandem_trial_activated_at    TIMESTAMPTZ
  is_qa_user                  BOOLEAN DEFAULT FALSE
  values_banner_dismissed     BOOLEAN DEFAULT FALSE
  previous_checkin_summary    TEXT
  created_at                  TIMESTAMPTZ DEFAULT NOW()
  updated_at                  TIMESTAMPTZ DEFAULT NOW()

  // Relations
  tasks                       task[]
  expenses                    expense[]
  values                      user_value[]
  subscriptions               app_subscription[]
  budgets                     budget[]
  recurring_tasks             recurring_task[]
  nudges                      nudge[]
  insurance_policies          insurance_policy[]
  documents                   document[]
  // ... 60+ more relations
}

model password_reset_tokens {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  token_hash  VARCHAR(64) NOT NULL           // SHA256 of raw token
  expires_at  TIMESTAMPTZ NOT NULL
  used_at     TIMESTAMPTZ
  created_at  TIMESTAMPTZ DEFAULT NOW()
}

model account_deletion_tokens {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  token_hash  VARCHAR(64) NOT NULL
  expires_at   TIMESTAMPTZ NOT NULL
  used_at      TIMESTAMPTZ
  created_at   TIMESTAMPTZ DEFAULT NOW()
}

model analytics_events {
  id           SERIAL PRIMARY KEY
  visitor_hash VARCHAR(255)                  // Anonymous visitor ID
  user_id      INTEGER REFERENCES users(id)
  event_name   VARCHAR(100) NOT NULL
  event_data   JSONB DEFAULT '{}'
  occurred_at   TIMESTAMPTZ DEFAULT NOW()
}

model adhd_tax_leads {
  id        SERIAL PRIMARY KEY
  email     VARCHAR(255) UNIQUE NOT NULL
  name      VARCHAR(255)
  created_at TIMESTAMPTZ DEFAULT NOW()
}

model visitor_sessions {
  id           SERIAL PRIMARY KEY
  visitor_hash VARCHAR(255) UNIQUE NOT NULL
  utm_source   VARCHAR(500)
  utm_medium   VARCHAR(500)
  utm_campaign VARCHAR(500)
  utm_content  VARCHAR(500)
  utm_term     VARCHAR(500)
  landed_at    TIMESTAMPTZ DEFAULT NOW()
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
}

model push_tokens {
  id        SERIAL PRIMARY KEY
  user_id   INTEGER REFERENCES users(id)
  token     VARCHAR(500) NOT NULL            // APNs device token
  created_at TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, token)
}

model notification_send_log {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  notification_key VARCHAR(100)
  send_date   DATE NOT NULL
  UNIQUE(user_id, notification_key, send_date)
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

model app_subscription {
  id                    SERIAL PRIMARY KEY
  user_id               INTEGER REFERENCES users(id)
  plan                  VARCHAR(20) DEFAULT 'free'  // 'free'|'pro'
  status                VARCHAR(20) DEFAULT 'active'  // 'active'|'cancelled'
  billing_cycle         VARCHAR(20)                  // 'monthly'|'annual'
  stripe_subscription_id VARCHAR(255)
  checkout_session_id   VARCHAR(255) UNIQUE
  activated_at          TIMESTAMPTZ
  cancelled_at          TIMESTAMPTZ
  current_period_end    TIMESTAMPTZ
  updated_at            TIMESTAMPTZ DEFAULT NOW()
}

model promo_codes {
  id             SERIAL PRIMARY KEY
  code           VARCHAR(50) UNIQUE NOT NULL
  type           VARCHAR(20)               // 'days' (free days), 'percent', 'plan'
  value          INTEGER                   // e.g. 30 = 30 days free
  max_redemptions INTEGER DEFAULT 1
  expires_at     TIMESTAMPTZ
  is_active      BOOLEAN DEFAULT TRUE
  created_at     TIMESTAMPTZ DEFAULT NOW()
  redemptions    promo_redemption[]
}

model promo_redemptions {
  id             SERIAL PRIMARY KEY
  promo_code_id  INTEGER REFERENCES promo_codes(id)
  user_id        INTEGER REFERENCES users(id)
  redeemed_at    TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(promo_code_id, user_id)
}

model budget {
  id             SERIAL PRIMARY KEY
  user_id        INTEGER REFERENCES users(id)
  weekly_amount  DECIMAL(10,2) DEFAULT 500.00
  is_active      BOOLEAN DEFAULT TRUE
  created_at     TIMESTAMPTZ DEFAULT NOW()
  updated_at     TIMESTAMPTZ DEFAULT NOW()
}

// ── Tasks ────────────────────────────────────────────────────────────────────

model task {
  id                     SERIAL PRIMARY KEY
  user_id                INTEGER REFERENCES users(id)
  title                  VARCHAR(500) NOT NULL
  description            TEXT
  priority               VARCHAR(20) DEFAULT 'medium'  // 'low'|'medium'|'high'
  due_date               DATE
  due_time               TIME
  is_completed           BOOLEAN DEFAULT FALSE
  completed_at           TIMESTAMPTZ
  source                 VARCHAR(50)               // 'manual'|'onboarding'|'auto_bill'|'buddy_demo'|'recurring'
  recurring_task_id      INTEGER REFERENCES recurring_task(id)
  bill_merchant_key      VARCHAR(100)
  bill_type              VARCHAR(50)              // 'subscription'|'utility'|'insurance'|'rent'|'loan'
  merchant_hint          VARCHAR(100)
  expected_amount        DECIMAL(10,2)
  auto_complete_note     TEXT
  auto_complete_transaction_id VARCHAR(255)
  notes                  TEXT
  duration_minutes       INTEGER
  duration_source        VARCHAR(20)               // 'manual'|'ai'
  value_id               INTEGER REFERENCES user_value(id)
  is_household           BOOLEAN DEFAULT FALSE
  is_shared_with_partner BOOLEAN DEFAULT FALSE
  created_at             TIMESTAMPTZ DEFAULT NOW()
  updated_at             TIMESTAMPTZ DEFAULT NOW()

  steps                  task_step[]
  substeps               task_substep[]
  focus_sessions         focus_session[]
}

model task_step {
  id          SERIAL PRIMARY KEY
  task_id     INTEGER REFERENCES task(id) ON DELETE CASCADE
  title       VARCHAR(500) NOT NULL
  is_completed BOOLEAN DEFAULT FALSE
  sort_order  INTEGER DEFAULT 0
  completed_at TIMESTAMPTZ
  created_at   TIMESTAMPTZ DEFAULT NOW()
}

model task_substep {
  id        SERIAL PRIMARY KEY
  task_id   INTEGER REFERENCES task(id) ON DELETE CASCADE
  title     VARCHAR(500) NOT NULL
  is_completed BOOLEAN DEFAULT FALSE
  sort_order INTEGER DEFAULT 0
  created_at TIMESTAMPTZ DEFAULT NOW()
}

model recurring_task {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  title       VARCHAR(500) NOT NULL
  description TEXT
  priority    VARCHAR(20) DEFAULT 'medium'
  frequency   VARCHAR(20) NOT NULL             // 'daily'|'weekly'|'biweekly'|'monthly'
  next_due_date DATE NOT NULL
  end_date    DATE
  is_paused   BOOLEAN DEFAULT FALSE
  value_id    INTEGER REFERENCES user_value(id)
  created_at  TIMESTAMPTZ DEFAULT NOW()
  updated_at   TIMESTAMPTZ DEFAULT NOW()

  task_instances  task[]
}

model time_estimation {
  id             SERIAL PRIMARY KEY
  task_id        INTEGER REFERENCES task(id) ON DELETE CASCADE
  user_id        INTEGER REFERENCES users(id)
  estimated_minutes INTEGER
  actual_minutes   INTEGER
  calibration_score DECIMAL(4,3)              // actual/estimated ratio
  estimated_at    TIMESTAMPTZ DEFAULT NOW()
  completed_at    TIMESTAMPTZ
}

// ── Expenses & Money ─────────────────────────────────────────────────────────

model categories {
  id        SERIAL PRIMARY KEY
  name      VARCHAR(100) NOT NULL
  color     VARCHAR(7) DEFAULT '#6B6B80'
  icon      VARCHAR(10) DEFAULT ''
  created_at TIMESTAMPTZ DEFAULT NOW()
}

model expense {
  id                   SERIAL PRIMARY KEY
  user_id              INTEGER REFERENCES users(id)
  amount               DECIMAL(10,2) NOT NULL
  description          VARCHAR(500)
  category_id          INTEGER REFERENCES categories(id)
  expense_date         DATE NOT NULL
  source               VARCHAR(20) DEFAULT 'manual'  // 'manual'|'plaid'
  plaid_transaction_id  VARCHAR(255) UNIQUE WHERE plaid_transaction_id IS NOT NULL
  is_impulse           BOOLEAN                              // NULL=untriaged, TRUE/FALSE
  created_at           TIMESTAMPTZ DEFAULT NOW()
}

model spending_session {
  id            SERIAL PRIMARY KEY
  user_id       INTEGER REFERENCES users(id)
  started_at    TIMESTAMPTZ DEFAULT NOW()
  ended_at      TIMESTAMPTZ
  planned_count INTEGER DEFAULT 0
  impulse_count INTEGER DEFAULT 0
}

// ── Bank Sync (Plaid) ─────────────────────────────────────────────────────────

model plaid_item {
  id               SERIAL PRIMARY KEY
  user_id          INTEGER REFERENCES users(id)
  access_token     TEXT NOT NULL             // AES-256-GCM encrypted
  item_id          VARCHAR(255)
  institution_name VARCHAR(255)
  institution_id   VARCHAR(255)
  cursor           TEXT                       // Pagination cursor for transactionsSync
  last_synced_at   TIMESTAMPTZ
  created_at       TIMESTAMPTZ DEFAULT NOW()
}

model plaid_account {
  id              SERIAL PRIMARY KEY
  plaid_item_id   INTEGER REFERENCES plaid_item(id)
  user_id         INTEGER REFERENCES users(id)
  account_id      VARCHAR(255) UNIQUE
  name            VARCHAR(255)
  official_name   VARCHAR(255)
  type            VARCHAR(50)
  subtype         VARCHAR(50)
  mask            VARCHAR(20)
}

model plaid_transaction {
  id               SERIAL PRIMARY KEY
  plaid_account_id INTEGER REFERENCES plaid_account(id)
  user_id          INTEGER REFERENCES users(id)
  transaction_id   VARCHAR(255) UNIQUE
  amount           DECIMAL(10,2) NOT NULL
  description      VARCHAR(500)
  merchant_name    VARCHAR(255)
  category_id      INTEGER REFERENCES categories(id)
  plaid_category   TEXT                      // Plaid category string
  transaction_date DATE
  is_pending       BOOLEAN DEFAULT FALSE
  is_confirmed     BOOLEAN DEFAULT FALSE
  expense_id       INTEGER
  created_at       TIMESTAMPTZ DEFAULT NOW()
  updated_at       TIMESTAMPTZ DEFAULT NOW()
}

model bill_preferences {
  id                    SERIAL PRIMARY KEY
  user_id               INTEGER REFERENCES users(id)
  merchant_key          VARCHAR(100) NOT NULL
  merchant_display_name VARCHAR(255)
  bill_type             VARCHAR(50)
  is_disabled           BOOLEAN DEFAULT FALSE
  updated_at            TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, merchant_key)
}

// ── Values & Alignment ─────────────────────────────────────────────────────────

model user_value {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  value_name  VARCHAR(100) NOT NULL
  maslow_tier VARCHAR(50)
  icon        VARCHAR(10)
  color       VARCHAR(7)
  rank        INTEGER
  created_at  TIMESTAMPTZ DEFAULT NOW()
}

model values_alignment_score {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  value_id    INTEGER REFERENCES user_value(id)
  date        DATE NOT NULL
  score       INTEGER                              // 0-100
  created_at  TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, value_id, date)
}

// ── Journal & Mood ────────────────────────────────────────────────────────────

model journal_entry {
  id        SERIAL PRIMARY KEY
  user_id   INTEGER REFERENCES users(id)
  date      DATE NOT NULL
  mood      INTEGER                               // 1-5
  content   TEXT
  created_at TIMESTAMPTZ DEFAULT NOW()
  updated_at TIMESTAMPTZ DEFAULT NOW()
}

// ── Buddy / Accountabilibuddy ────────────────────────────────────────────────

model buddy_checkins {
  id           SERIAL PRIMARY KEY
  user_id      INTEGER REFERENCES users(id)
  date         DATE NOT NULL
  type         VARCHAR(20) NOT NULL               // 'morning'|'evening'|'midday'
  mood         INTEGER
  response     JSONB
  created_at   TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, date, type)
}

model buddy_daily_plans {
  id           SERIAL PRIMARY KEY
  user_id      INTEGER REFERENCES users(id)
  date         DATE NOT NULL
  mood         INTEGER
  plan_json    JSONB                             // { slots: [{ task_id, reason, accepted }] }
  accepted     BOOLEAN DEFAULT FALSE
  completion_count INTEGER DEFAULT 0
  created_at   TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, date)
}

model buddy_patterns {
  id             SERIAL PRIMARY KEY
  user_id        INTEGER REFERENCES users(id)
  pattern_type   VARCHAR(50)                     // 'time'|'day'|'sequence'|'category'
  description    TEXT
  confidence_score DECIMAL(4,3)
  occurrence_count INTEGER
  is_active      BOOLEAN DEFAULT TRUE
  last_seen_at   TIMESTAMPTZ
  surfaced_at     TIMESTAMPTZ
  dismissed_at   TIMESTAMPTZ
  created_at      TIMESTAMPTZ DEFAULT NOW()
}

model buddy_midday_checkins {
  id              SERIAL PRIMARY KEY
  user_id         INTEGER REFERENCES users(id)
  date            DATE NOT NULL
  type            VARCHAR(20) NOT NULL           // 'post_plan'|'afternoon_energy'|'pre_evening'
  response        JSONB
  created_at      TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, date, type)
}

model buddy_engagement {
  id                        SERIAL PRIMARY KEY
  user_id                   INTEGER REFERENCES users(id) UNIQUE
  consecutive_missed_checkins INTEGER DEFAULT 0
  hook_restart_count        INTEGER DEFAULT 0
  last_comeback_shown_at    TIMESTAMPTZ
  lapse_timestamps          TIMESTAMPTZ[]
  push_at                   TIMESTAMPTZ
  day5_email_at             TIMESTAMPTZ
  day14_email_at            TIMESTAMPTZ
  updated_at                TIMESTAMPTZ DEFAULT NOW()
}

model buddy_conversations {
  id           SERIAL PRIMARY KEY
  user_id      INTEGER REFERENCES users(id)
  session_date DATE NOT NULL
  role         VARCHAR(20) NOT NULL              // 'user'|'buddy'
  message      TEXT NOT NULL
  turn         INTEGER NOT NULL
  created_at   TIMESTAMPTZ DEFAULT NOW()
}

model checkin_mode_preferences {
  id              SERIAL PRIMARY KEY
  user_id         INTEGER REFERENCES users(id) UNIQUE
  preferred_mode  VARCHAR(20)                   // 'form'|'conversation'
  manual_override BOOLEAN DEFAULT FALSE
  learned_after   INTEGER DEFAULT 0             // sessions before preference solidified
}

model buddy_demo_sessions {
  id                 VARCHAR(36) PRIMARY KEY       // UUID
  created_at         TIMESTAMPTZ DEFAULT NOW()
  expires_at         TIMESTAMPTZ
  surfaced_values    JSONB
  extracted_tasks    JSONB
  conversation_summary TEXT
  claimed_user_id    INTEGER REFERENCES users(id)
}

model buddy_demo_turns {
  id           SERIAL PRIMARY KEY
  session_id  VARCHAR(36) REFERENCES buddy_demo_sessions(id)
  role         VARCHAR(20) NOT NULL
  message      TEXT NOT NULL
  turn         INTEGER NOT NULL
  created_at   TIMESTAMPTZ DEFAULT NOW()
}

// ── Morning Launch ────────────────────────────────────────────────────────────

model morning_streaks {
  id                 SERIAL PRIMARY KEY
  user_id           INTEGER REFERENCES users(id) UNIQUE
  current_streak    INTEGER DEFAULT 0
  longest_streak    INTEGER DEFAULT 0
  last_completed_date DATE
  grace_day_available BOOLEAN DEFAULT TRUE
  updated_at        TIMESTAMPTZ DEFAULT NOW()
}

model morning_sessions {
  id               SERIAL PRIMARY KEY
  user_id          INTEGER REFERENCES users(id)
  session_date     DATE NOT NULL
  tasks_completed  INTEGER DEFAULT 0
  tasks_skipped    INTEGER DEFAULT 0
  completed_at     TIMESTAMPTZ DEFAULT NOW()
}

model morning_task_events {
  id           SERIAL PRIMARY KEY
  user_id      INTEGER REFERENCES users(id)
  task_id      INTEGER REFERENCES task(id)
  event_type   VARCHAR(20) NOT NULL              // 'completed'|'skipped'
  session_date DATE NOT NULL
  created_at   TIMESTAMPTZ DEFAULT NOW()
}

// ── Routines ──────────────────────────────────────────────────────────────────

model routine {
  id                SERIAL PRIMARY KEY
  user_id           INTEGER REFERENCES users(id)
  name              VARCHAR(100) NOT NULL
  time_of_day       VARCHAR(20)                   // 'morning'|'evening'|'afternoon'|'any'
  day_of_week       INTEGER                        // 0-6 (Sunday-Saturday), NULL for daily
  task_ids          INTEGER[]                      // Array of task IDs
  nudge_after_hour  INTEGER                        // Hour (0-23) to send nudge
  is_active         BOOLEAN DEFAULT TRUE
  source_template_id INTEGER                       // FK to routine_templates if adopted
  created_at        TIMESTAMPTZ DEFAULT NOW()
  updated_at        TIMESTAMPTZ DEFAULT NOW()
}

model routine_task_link {
  id         SERIAL PRIMARY KEY
  routine_id INTEGER REFERENCES routine(id)
  task_id    INTEGER REFERENCES task(id)
  UNIQUE(routine_id, task_id)
}

model routine_streaks {
  id             SERIAL PRIMARY KEY
  routine_id    INTEGER REFERENCES routine(id)
  current_streak INTEGER DEFAULT 0
  best_streak    INTEGER DEFAULT 0
  last_completed_date DATE
}

model routine_template {
  id        SERIAL PRIMARY KEY
  name      VARCHAR(100) NOT NULL
  category  VARCHAR(50) NOT NULL                   // 'morning'|'evening'|'weekly'|'productivity'|'movement'
  icon      VARCHAR(10)
  tasks     JSONB                                  // Array of task objects
  is_active BOOLEAN DEFAULT TRUE
}

model routine_nudge_prefs {
  id       SERIAL PRIMARY KEY
  user_id  INTEGER REFERENCES users(id) UNIQUE
  enabled  BOOLEAN DEFAULT TRUE
  frequency VARCHAR(20) DEFAULT 'default'         // 'default'|'less'|'more'
}

model routine_nudge_event {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  routine_id  INTEGER REFERENCES routine(id)
  date        DATE NOT NULL
  status      VARCHAR(20)                          // 'sent'|'skipped'|'dismissed'
  skip_count  INTEGER DEFAULT 0
  created_at  TIMESTAMPTZ DEFAULT NOW()
}

model detected_patterns {
  id              SERIAL PRIMARY KEY
  user_id         INTEGER REFERENCES users(id)
  pattern_type    VARCHAR(50)                      // 'time'|'day'|'sequence'|'category'
  description      TEXT
  confidence_score DECIMAL(4,3)
  occurrence_count INTEGER
  is_active       BOOLEAN DEFAULT TRUE
  task_ids        INTEGER[]
  metadata        JSONB
  created_at      TIMESTAMPTZ DEFAULT NOW()
}

model routine_suggestions {
  id             SERIAL PRIMARY KEY
  user_id        INTEGER REFERENCES users(id)
  pattern_id     INTEGER REFERENCES detected_patterns(id)
  status         VARCHAR(20) DEFAULT 'pending'     // 'pending'|'accepted'|'dismissed'
  presented_count INTEGER DEFAULT 0
  created_at     TIMESTAMPTZ DEFAULT NOW()
}

// ── Focus Mode ────────────────────────────────────────────────────────────────

model focus_session {
  id                  SERIAL PRIMARY KEY
  task_id             INTEGER REFERENCES task(id) ON DELETE CASCADE
  user_id             INTEGER REFERENCES users(id)
  planned_duration_seconds INTEGER
  actual_duration_seconds   INTEGER
  completed           BOOLEAN DEFAULT FALSE
  started_at          TIMESTAMPTZ DEFAULT NOW()
  ended_at            TIMESTAMPTZ
}

model user_focus_prefs {
  id                  SERIAL PRIMARY KEY
  user_id             INTEGER REFERENCES users(id) UNIQUE
  body_double_enabled  BOOLEAN DEFAULT FALSE
  ambient_style       VARCHAR(20) DEFAULT 'cafe'    // 'cafe'|'library'|'rain'
  ambient_volume      INTEGER DEFAULT 50            // 0-100
}

// ── Vault / Documents ─────────────────────────────────────────────────────────

model document {
  id                   SERIAL PRIMARY KEY
  user_id              INTEGER REFERENCES users(id)
  name                 VARCHAR(255) NOT NULL
  category             VARCHAR(100)
  s3_url               TEXT
  file_size            INTEGER
  mime_type            VARCHAR(100)
  uploaded_at          TIMESTAMPTZ DEFAULT NOW()
  expiry_date          DATE
  metadata_json        JSONB
  ai_extracted         BOOLEAN DEFAULT FALSE
  extraction_status    VARCHAR(20) DEFAULT 'none'  // 'none'|'pending'|'processing'|'done'|'failed'
  extraction_confidence JSONB
  notes                TEXT
  metadata_confirmed    BOOLEAN DEFAULT FALSE
}

model ai_extraction_usage {
  id         SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  month      DATE NOT NULL
  count      INTEGER DEFAULT 0
  updated_at TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, month)
}

// ── Notifications / Nudges ────────────────────────────────────────────────────

model nudge {
  id         SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  type       VARCHAR(50) NOT NULL                 // 'document_expiry'|'insurance_gap'|'score_drop'|'annual_review'
  title      VARCHAR(255)
  body       TEXT
  action_url VARCHAR(255)
  is_read    BOOLEAN DEFAULT FALSE
  created_at TIMESTAMPTZ DEFAULT NOW()
}

model nudge_preference {
  id       SERIAL PRIMARY KEY
  user_id  INTEGER REFERENCES users(id)
  type     VARCHAR(50) NOT NULL
  channel  VARCHAR(20) NOT NULL                 // 'push'|'buddy'|'email'|'banner'
  enabled  BOOLEAN DEFAULT TRUE
  UNIQUE(user_id, type, channel)
}

// ── Insurance ─────────────────────────────────────────────────────────────────

model insurance_policy {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  type        VARCHAR(100)                      // 'auto'|'home'|'life'|'health'|'renters'|'other'
  provider    VARCHAR(255)
  policy_num  VARCHAR(255)
  coverage    TEXT
  premium     DECIMAL(10,2)
  expiry_date DATE
  document_url TEXT
  created_at  TIMESTAMPTZ DEFAULT NOW()
  updated_at  TIMESTAMPTZ DEFAULT NOW()
}

model coverage_gaps_log {
  id          SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  gap_type   VARCHAR(100) NOT NULL
  status     VARCHAR(20) DEFAULT 'open'         // 'open'|'addressed'|'ignored'
  created_at TIMESTAMPTZ DEFAULT NOW()
  resolved_at TIMESTAMPTZ
}

// ── Ideas ─────────────────────────────────────────────────────────────────────

model idea {
  id        SERIAL PRIMARY KEY
  user_id   INTEGER REFERENCES users(id)
  title     VARCHAR(500) NOT NULL
  notes     TEXT
  created_at TIMESTAMPTZ DEFAULT NOW()
  updated_at TIMESTAMPTZ DEFAULT NOW()
}

// ── Time Blocks ───────────────────────────────────────────────────────────────

model time_block {
  id         SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  title      VARCHAR(255)
  date       DATE NOT NULL
  start_time TIME NOT NULL
  end_time   TIME NOT NULL
  task_id    INTEGER REFERENCES task(id)
  created_at TIMESTAMPTZ DEFAULT NOW()
  updated_at TIMESTAMPTZ DEFAULT NOW()
}

model work_hour_block {
  id          SERIAL PRIMARY KEY
  user_id     INTEGER REFERENCES users(id)
  day_of_week INTEGER NOT NULL                  // 0-6
  start_time  TIME NOT NULL
  end_time    TIME NOT NULL
  label       VARCHAR(100)
}

// ── Email / OAuth ─────────────────────────────────────────────────────────────

model email_connection {
  id           SERIAL PRIMARY KEY
  user_id      INTEGER REFERENCES users(id)
  email        VARCHAR(255) NOT NULL
  provider     VARCHAR(20)                       // 'gmail'|'microsoft'|'yahoo'
  access_token TEXT                              // OAuth access token
  refresh_token TEXT
  expires_at   TIMESTAMPTZ
  created_at   TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, email)
}

model linked_email {
  id         SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  email      VARCHAR(255) UNIQUE NOT NULL
  verified   BOOLEAN DEFAULT FALSE
  created_at TIMESTAMPTZ DEFAULT NOW()
}

model email_tasks_stash {
  id          SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  sender_email VARCHAR(255) NOT NULL
  subject    VARCHAR(500)
  body_preview TEXT
  expires_at TIMESTAMPTZ
  created_at TIMESTAMPTZ DEFAULT NOW()
}

model followup_email_type {
  id       SERIAL PRIMARY KEY
  type     VARCHAR(50) UNIQUE NOT NULL         // 'task_reminder'|'routine_streak'|'weekly_summary'|'follow_through'
  label    VARCHAR(100)
  description TEXT
  default_hour INTEGER DEFAULT 9
}

model user_followup_pref {
  id       SERIAL PRIMARY KEY
  user_id  INTEGER REFERENCES users(id)
  type     VARCHAR(50) NOT NULL
  enabled  BOOLEAN DEFAULT TRUE
  hour     INTEGER DEFAULT 9
  UNIQUE(user_id, type)
}

model followup_email_log {
  id         SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  type       VARCHAR(50) NOT NULL
  ref        VARCHAR(255)
  sent_at    TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, type, ref, (sent_at::date))
}

// ── Customer Inbox ─────────────────────────────────────────────────────────────

model customer_email {
  id             SERIAL PRIMARY KEY
  thread_id      VARCHAR(255) NOT NULL
  user_id        INTEGER REFERENCES users(id)
  direction      VARCHAR(20) NOT NULL            // 'inbound'|'outbound'
  from_email     VARCHAR(255)
  to_email       VARCHAR(255)
  subject        VARCHAR(500)
  body           TEXT
  resend_email_id VARCHAR(255) UNIQUE
  read_at        TIMESTAMPTZ
  created_at     TIMESTAMPTZ DEFAULT NOW()
}

// ── Contact / Support ─────────────────────────────────────────────────────────

model contact_submission {
  id         SERIAL PRIMARY KEY
  name       VARCHAR(255)
  email      VARCHAR(255)
  message    TEXT
  category   VARCHAR(50)                        // 'bug'|'account_issue'|'other'
  page_url   TEXT
  browser    TEXT
  status     VARCHAR(20) DEFAULT 'pending'     // 'pending'|'resolved'
  created_at TIMESTAMPTZ DEFAULT NOW()
}

// ── News Feed ──────────────────────────────────────────────────────────────────

model news_feed {
  id        SERIAL PRIMARY KEY
  title     VARCHAR(500) NOT NULL
  url       TEXT NOT NULL
  source    VARCHAR(100)
  content   TEXT
  published_at TIMESTAMPTZ
  fetched_at TIMESTAMPTZ DEFAULT NOW()
}

// ── Weekly Stats ──────────────────────────────────────────────────────────────

model weekly_stats {
  id                SERIAL PRIMARY KEY
  user_id           INTEGER REFERENCES users(id)
  week_start        DATE NOT NULL
  tasks_completed   INTEGER DEFAULT 0
  tasks_created     INTEGER DEFAULT 0
  total_spend_cents INTEGER DEFAULT 0
  impulse_count     INTEGER DEFAULT 0
  planned_count     INTEGER DEFAULT 0
  evening_sessions  INTEGER DEFAULT 0
  routines_completed INTEGER DEFAULT 0
  streak_days       INTEGER DEFAULT 0
  created_at        TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(user_id, week_start)
}

// ── Insight Unlocks ───────────────────────────────────────────────────────────

model insight_unlock {
  id           SERIAL PRIMARY KEY
  user_id      INTEGER REFERENCES users(id)
  insight_key VARCHAR(100) NOT NULL
  unlocked_at  TIMESTAMPTZ DEFAULT NOW()
  viewed       BOOLEAN DEFAULT FALSE
  interacted   BOOLEAN DEFAULT FALSE
  UNIQUE(user_id, insight_key)
}

// ── Partnerships ──────────────────────────────────────────────────────────────

model partnership {
  id                     SERIAL PRIMARY KEY
  inviter_id             INTEGER REFERENCES users(id)
  invitee_id             INTEGER REFERENCES users(id)
  status                 VARCHAR(20) DEFAULT 'pending'  // 'pending'|'active'|'dissolved'
  invite_token           VARCHAR(64) UNIQUE
  tandem_trial_activated_at TIMESTAMPTZ
  dissolved_at            TIMESTAMPTZ
  created_at             TIMESTAMPTZ DEFAULT NOW()
  // Partial unique index: one active partnership per user
  // CHECK: (status = 'active') → unique (inviter_id) and unique (invitee_id)
}

model partner_concern {
  id           SERIAL PRIMARY KEY
  sender_id    INTEGER REFERENCES users(id)
  receiver_id  INTEGER REFERENCES users(id)
  topic_area   VARCHAR(100)                         // coaching context only — concern_text never shown to receiver
  created_at   TIMESTAMPTZ DEFAULT NOW()
  expires_at   TIMESTAMPTZ                         // auto-expire 7 days
}

// ── iOS Waitlist ──────────────────────────────────────────────────────────────

model ios_waitlist {
  id         SERIAL PRIMARY KEY
  email      VARCHAR(255) UNIQUE NOT NULL
  created_at TIMESTAMPTZ DEFAULT NOW()
}

model lead_magnet_email {
  id         SERIAL PRIMARY KEY
  email      VARCHAR(255) UNIQUE NOT NULL
  magnet_type VARCHAR(50)                          // 'adhd-science-cheatsheet'|'daily-three-template'
  created_at TIMESTAMPTZ DEFAULT NOW()
}

// ── Event Bus ─────────────────────────────────────────────────────────────────

model analytics_event {
  id         SERIAL PRIMARY KEY
  user_id    INTEGER REFERENCES users(id)
  event_type VARCHAR(100) NOT NULL
  payload    JSONB
  created_at TIMESTAMPTZ DEFAULT NOW()
}
```

---

## Shared Components

### Frontend Service Modules (`public/js/services/`)

| File | Purpose | Used By |
|------|---------|---------|
| `plaid-service.js` | Plaid Link init, token exchange, bank status render | `money.html`, `transactions.html` |
| `values-service.js` | Values CRUD + implementation intentions | `values.html`, `app.html` |
| `ai-service.js` | Document extraction, text summarization, task suggestions | `vault.html`, `buddy.html` |

### Frontend Shared Utilities (`public/js/`)

| File | Purpose | Used By |
|------|---------|---------|
| `shared-nav.js` | Bottom nav + desktop sidebar + hamburger slide-out | **ALL 47 HTML files** |
| `shared-nav.css` | Nav styling | **ALL HTML files via shared-nav.js** |
| `analytics.js` | Event tracking (anonymous) | Multiple pages |
| `pro-gate.js` | Autopilot upgrade gating UI | Multiple pages |
| `voice-input.js` | Web Speech API + browser speech recognition | `buddy.html`, checkin pages |
| `elapsed-timer.js` | Timer for focus sessions | `app/focus.html` |
| `haptics.js` | Touch feedback + reduced-motion detection | Multiple pages |
| `touch-feedback.js` | Touch event handling | Multiple pages |
| `demo.js` | Anonymous Buddy demo session management | Landing page |
| `ios-push.js` | iOS push notification handling | Settings page |
| `biometric.js` | Biometric auth (Face ID/Touch ID) | Login page |
| `siri-shortcuts.js` | Siri shortcut integration | Settings page |

### Backend Shared Libraries (`lib/`)

| File | Purpose | Called From |
|------|---------|------------|
| `emailService.js` | Resend email delivery + email_log tracking | `routes/auth.js`, `routes/subscription.js`, `routes/buddy.js`, many others |
| `seedDefaultValues.js` | Maslow values seed for new users | `routes/auth.js` (all 4 auth paths) |
| `timezone.js` | User local date/time computation (not UTC) | `routes/tasks.js`, `routes/buddy.js`, many others |
| `task-filters.js` | `actionableDateFilter()` — "today" task scoping | `routes/tasks.js` |
| `ai-service.js` | Shared AI summarization + task suggestion (backend) | `routes/ai.js`, `routes/documents.js` |
| `documentExtraction.js` | GPT-4o document field extraction | `routes/documents.js` |
| `taskParsingService.js` | Buddy "break down" task decomposition | `routes/buddy.js` |
| `nudgeGenerator.js` | Generate alignment nudges | `routes/nudge-system.js` |
| `impulseNudgeEngine.js` | Impulse spending detection nudges | `routes/nudge-system.js` |
| `routineNudgeEngine.js` | Routine reminder nudges | `routes/routineNudges.js` |
| `patternDetection.js` | AI-detected task patterns | `routes/autoRoutines.js` |
| `auto-tagger.js` | Match task title to user value | `routes/tasks.js` |
| `buddyPatterns.js` | Buddy pattern detection logic | `routes/buddy.js` |
| `buddyContext.js` | Build Buddy system prompt context | `routes/buddy.js` |
| `polsia-ai.js` | Polsia AI client (OpenAI wrapper) | Multiple routes |
| `queryWithRetry.js` | DB query with retry + backoff | `routes/inbound-email.js` |
| `emailTemplates.js` | HTML email template builders | `routes/auth.js`, `routes/subscription.js` |
| `followupEmailTemplates.js` | Followup email templates | `routes/followupEmails.js` |
| `apns-sender.js` | APNs push notification sending | `services/NotificationService` |
| `v2LaunchCampaign.js` | One-shot v2 launch campaign | `server.js` |

### Backend Middleware (`middleware/`)

| File | Purpose | Used By |
|------|---------|---------|
| `auth.js` | `authenticateToken`, `generateToken`, `verifyToken`, `hashPassword`, `verifyPassword` | All auth-required routes |
| `proUtils.js` | `checkProStatus` (unifies Stripe sub + admin override + promo) | Most Pro-gated routes |
| `security.js` | `helmetMiddleware`, `cORS`, rate limiters | `server.js` |

### Database Layer (`db/`)

| File | Tables Owned |
|------|-------------|
| `transactions.js` | `plaid_tokens`, `transactions`, `spending_sessions`, `transaction_classifications` (v1 API) |
| `partnerships.js` | `partnerships`, `partner_concerns` |
| `email-to-tasks.js` | `linked_emails`, `email_tasks_stash` |
| `buddy-demo.js` | `buddy_demo_sessions`, `buddy_demo_turns` |
| `notifications.js` | `notification_send_log` |
| `events.js` | `analytics_event` (EventBus) |

All other `db/*.js` files are 1:1 with their tables.

### Scheduled Jobs (`jobs/` + polsia.toml)

| Job File | Trigger | Purpose |
|----------|---------|---------|
| `morningNudge.js` | Daily 8am local | Morning nudge to users who haven't checked in |
| `eveningNudge.js` | Daily 6pm local | Evening spending review reminder |
| `taskDeadlineNudge.js` | Every 15 min | Push notifications for due/overdue tasks (deduped) |
| `emailCron.js` | Scheduled via polsia.toml | Weekly summary, routine streak, follow-through emails |
| `plaidDailySync.js` | Daily | Sync transactions for all connected Plaid items |
| `buddyEngagementCron.js` | Daily | Re-engagement flow: push → day5 email → day14 email |

---

## Auth Strategy

### Current Architecture

```
User action → localStorage.getItem('fl_token') → Bearer token in Authorization header
           → middleware/auth.js:authenticateToken() → JWT verify (HMAC-SHA256)
           → req.user = { id, email, name }
```

**Token Storage**: `localStorage.getItem('fl_token')` — JWT stored client-side.
**Token Format**: `header.payload.signature` (base64url), HMAC-SHA256 signed.
**Expiry**: 30 days default, configurable per-call.
**JWT Secret**: `process.env.JWT_SECRET` — must be set in production.

**Google OAuth flows:**
1. **Redirect flow**: `GET /api/auth/google/start` → redirect to Google → `/auth/google-auth/callback` → sets JWT as query param → redirected to `/login?google_token=...`
2. **One Tap (GIS)**: `POST /api/auth/google/one-tap` → verifies `id_token` via Google tokeninfo → returns JWT directly.

**Password Reset**: SHA256-hashed token (64 hex chars) stored in `password_reset_tokens`, 1-hour expiry, single-use.

### Next.js Migration Path

**Recommended: NextAuth.js v5 with Google OAuth provider**

| Migration Item | Strategy |
|---------------|---------|
| JWT token | Replace with NextAuth session (HttpOnly cookie, not localStorage) |
| Google OAuth | Use `GoogleProvider` from NextAuth — handles callback, token exchange, session |
| Custom `authenticateToken` middleware | Replace with NextAuth `auth()` helper in Server Components and Route Handlers |
| `authenticateToken` in API Routes | Replace with NextAuth `auth()` in Route Handlers (App Router) |
| `generateToken` / `verifyToken` | Deprecated — NextAuth manages session lifecycle |
| `hashPassword` / `verifyPassword` | Keep — PBKDF2 logic is portable; NextAuth Credentials provider for email/password |
| `localStorage.getItem('fl_token')` | Replace with `useSession()` hook or Server Component session |
| Password reset tokens | Keep `password_reset_tokens` table; implement via NextAuth email flow or custom route |
| Admin auth | Custom `isAdmin` check using `session.user.isAdmin` or role-based access |

**Phased Auth Migration:**
1. Add NextAuth alongside existing auth (dual-running) — users keep existing JWT sessions
2. Implement Google OAuth via NextAuth provider
3. Migrate pages to use NextAuth session hook
4. Deprecate custom JWT once all pages migrated

---

## Phase 2–4 Dependencies

### Phase 2: Scaffold + Auth (depends on this doc)

- **Prisma schema** — copy from Section 4 above; run `prisma db push` against Neon
- **NextAuth config** — Google provider, credentials provider for email/password
- **Session storage** — Prisma adapter for NextAuth sessions
- **Auth routes** — Migrate all 13 auth endpoints from `routes/auth.js`
- **Middleware** — Replace `authenticateToken` with NextAuth `auth()`
- **Protected routes** — All `authenticateToken`-gated routes become Server Components or Route Handlers

### Phase 3: Core Features (depends on Sections 2+3)

- **Tasks tab** (`/app/tasks`) — Reactify `app.html` → `app/tasks/page.tsx`
- **Buddy tab** (`/app/buddy`) — Reactify `buddy.html`; preserve Web Speech API integration
- **Money tab** (`/app/money`) — Reactify `money.html`; preserve Plaid Link (client-side SDK)
- **Vault tab** (`/app/vault`) — Reactify `vault.html`; preserve R2 file upload (multipart)
- **All secondary pages** — Convert to Next.js route group `app/(app)/`

### Phase 4: Remaining Systems (depends on Sections 3+5)

- **Plaid integration** — `plaid-service.js` becomes a React component; `routes/plaid.js` → Route Handlers
- **AI endpoints** — `routes/ai.js` → Route Handlers; `lib/ai-service.js` → shared utility
- **Document extraction** — `lib/documentExtraction.js` → server action or Route Handler
- **Email→Tasks** — Magic link claim page → Next.js page; inbound webhook → Route Handler
- **Subscription/Stripe** — `routes/subscription.js` → Route Handlers; Stripe webhook → Route Handler
- **Scheduled jobs** — Convert to Next.js Route Handlers + polsia.toml crons pointing to them
- **In-process schedulers** — Must be removed per Architecture Mandate rule 7; all scheduled work goes in polsia.toml

---

## Constraints & Notes

1. **No Next.js code written in this phase** — this document is the deliverable
2. **Auth migration is the riskiest part** — dual-running period needed to avoid logout waves
3. **Plaid Link SDK** — client-side Plaid script loaded from `cdn.plaid.com`; must remain in browser (not SSR)
4. **Service Worker** (`sw.js`) — has `no-store` cache header (route in `routes/static-cache.js`); must be preserved
5. **`/science` page** — `no-store` cache header; inline CSS (78KB) — SSR could improve this
6. **In-process cron jobs** in `server.js` — lines 264–289 use `setTimeout` + `setInterval`; must migrate to `polsia.toml` [[crons]]
7. **AES-256-GCM encrypted Plaid tokens** — stored in `plaid_items.access_token`; Prisma must preserve as `String` (encrypted format is base64)
8. **Local timezone handling** — `lib/timezone.js` critical for all date-sensitive features; must be ported to Next.js utility
9. **Webhook endpoints without JWT** — `/api/subscription/activate` (GET) and `/api/webhooks/resend-inbound` (POST) must be handled carefully in Next.js; alternative auth methods needed

---

---

## Phase 2: Scaffolding + Auth Foundation (COMPLETE — commit `88fbf67`)

**Status:** COMPLETE (2026-05-24)

**Platform blocker:** Next.js App Router is NOT supported on Polsia (only Express.js + PostgreSQL template available via `create_instance()`). Task #1882899 blocked and reported as platform bug. Pivoted to modernizing existing Express app instead — achieves same modernization goals without framework change.

### What was delivered

| Deliverable | Status | File |
|-------------|--------|------|
| Prisma schema (40+ tables) | ✅ Done | `prisma/schema.prisma` |
| Session auth layer | ✅ Done | `lib/session.js` |
| Dual auth (session + JWT) | ✅ Done | `middleware/auth.js` |
| Session middleware in server.js | ✅ Done | `server.js` (line 148) |
| express_sessions table migration | ✅ Done | `migrations/1748120000000_express_sessions.js` |
| Session establishment in auth routes | ✅ Done | `routes/auth.js` |
| establishSession guard for test safety | ✅ Done | `middleware/auth.js` |
| Dependencies (connect-pg-simple) | ✅ Done | `package.json` |

### Sessions vs JWT migration path

1. **Session middleware** (`lib/session.js`) mounted in server.js at line 148 — all API routes have session access
2. **Dual auth middleware** (`middleware/auth.js`) checks `req.session.user` first, falls back to JWT Bearer token — fully backward compatible
3. **`establishSession(req, user)`** in middleware/auth.js — guards against missing `req.session` (test environments), called by all 4 auth flows
4. **Auth routes** (`routes/auth.js`) — establishSession called on: signup (line 164), login (after token gen), Google callback (after token gen), Google one-tap (before response). `POST /logout` added (destroys session).
5. **`express_sessions` table** created via `migrations/1748120000000_express_sessions.js`, verified live in production
6. **Frontend unchanged** — login/signup pages continue storing JWT in localStorage; sessions established server-side silently

### Test fix (commit `88fbf67`)

**Bug:** `establishSession` assigned to `req.session.user` without guarding — tests without session middleware threw `TypeError: Cannot set property user of undefined`, causing all login tests to 500. **Fix:** `if (!req.session) return;` guard at top of `establishSession`. All 162 tests now pass.

### Next steps (Phase 3)

- [ ] Phase 3A: Prisma-ify core task CRUD (replace `pool.query()` with Prisma client in `db/tasks.js` equivalent)
- [ ] Phase 3B: Convert Tasks tab page to React, served from `/app/tasks` route handler
- [ ] Phase 3C: Convert Buddy tab page to React, served from `/app/buddy` route handler

### Platform recommendation

Add Next.js template to `create_instance()` options at the platform level. The migration map scope (App Router, React frontend) cannot be delivered on Express-only infrastructure. Recommend:
- `express-postgres` (existing)
- `nextjs-postgres` (needed) — runs `next build` + serves via custom server, same Neon DB

---

*Phase 1 audit: Task #1867066 (SHA `cf565ad`) · Phase 2 complete: Task #1882899 (SHA `0ae1120`) · 2026-05-24*