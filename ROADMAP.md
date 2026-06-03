# FocusLedger — Feature Roadmap

Last updated: 2026-06-03

---

## In Progress (current sprint)

| # | Feature | Est. |
|---|---------|------|
| #2080559 | Refactor bottom nav bar (mobile) | 4h |
| #1837228 | Momentum Score (0–100) — salutogenic, no shame copy | 3h |
| #1837227 | Implementation Intentions Builder | 4h |
| #1810936 | Fresh Start — one-tap day reset | 2h |
| #1810949 | Buddy personality modes (Gentle/Direct/Hype) | 2h |
| #1902705 | Geographic signup gating (USA + EU) | 3h |

---

## Backlog — Not Started

### Subscription Audit — Kill Duplicates
Scan Plaid transactions to surface forgotten recurring charges. Show cost/month per merchant, one-tap cancellation reminder. Tier: Autopilot. Plaid data exists; detection logic and UI not built.

### Values-Aligned Spending Reports
Report view mapping monthly spend to stated user values (e.g. "Family" value → % spent on family activities). Trend over time. Tier: Autopilot. Values + expense data exists; report not built.

### Full QA Sweep (#1858979)
End-to-end manual QA across all 4 tabs + Buddy + Vault + Settings on mobile and desktop.

### Conversion Funnel Analysis (#1858986)
Analyse signup → free → Autopilot drop-off points using analytics_events data.

### End-to-end QA — Money tab + Plaid (#1950298)
Dedicated QA pass on Plaid sync, expense categorisation, impulse detection, and bill task creation.

---

## Shipped — Core Features

| Feature | Tier | Notes |
|---------|------|-------|
| Tasks with AI breakdown (step splitter) | Free + Autopilot | Live |
| Due dates, recurring tasks, task notes | Free | Live |
| Quick-Add FAB with natural language dates | Free | Shipped 2026-05-26 |
| Task card tap-to-expand + recurring settings | Free | Shipped 2026-05-27 |
| Compact task cards with value tag badges | Free | Shipped 2026-05-27 |
| "I'm stuck" substep flow | Autopilot | Live |
| Routines + routine streaks | Free | Live |
| Routine templates (5 pre-built) | Free | Live |
| Routine nudges | Autopilot | Live |
| AI pattern detection → routine suggestions | Autopilot | Live |
| Focus Mode (deep-work timer) | Autopilot | Live |
| Body Double + Ambient Layer (café/library/rain) | Autopilot | Live |
| Movement / micro-break prompts (90-min trigger) | Autopilot | Shipped 2026-05-27 |
| Buddy (Accountabilibuddy) — morning + evening check-ins | Autopilot | Live |
| Buddy daily 3-task plan (V2A) | Autopilot | Live |
| Buddy mid-day check-ins (V2B) | Autopilot | Live |
| Buddy coaching conversation mode (V3) | Autopilot | Live |
| Buddy demo (anonymous, no login) | Free | Live |
| Bank sync via Plaid | Autopilot | Live |
| Impulse spending detection + Buddy surfacing | Autopilot | Live |
| Bill detection → auto task creation | Autopilot | Live |
| Expense categorisation | Free + Autopilot | Live |
| Document Vault (Life section) | Autopilot | Live |
| AI document extraction (25/month cap) | Autopilot | Live |
| Insurance gap detection | Autopilot | Live |
| Values system + daily alignment check-ins | Free + Autopilot | Live |
| Progressive Insights (tiered unlock) | Autopilot | Live |
| Time-blindness task estimation + calibration | Autopilot | Live |
| Tandem (accountability partner) — invite + 14-day trial | Tandem | Live |
| Partner dashboard + concern signals | Tandem | Live |
| Email-to-tasks (verified sender addresses) | Autopilot | Live |
| Follow-up emails (task reminder, streak, weekly, follow-through) | Autopilot | Live |
| Promo codes + redemption | Admin | Live |
| Push notifications — web (VAPID) + iOS (APNs) | Autopilot | Live |
| Google OAuth signup/login | All | Live |
| Password auth + reset flow | All | Live |
| Admin dashboard | Internal | Live |
| Two-way customer email inbox | Internal | Live |
| ADHD Tax Calculator (public tool + lead capture) | Marketing | Live |
| Science Cheat Sheet + Daily Three Template (lead magnets) | Marketing | Live |
| iOS waitlist | Marketing | Live |
| Pricing page (Free / Autopilot / Tandem) | Marketing | Updated 2026-06-03 |
| Landing page hero | Marketing | Updated 2026-06-03 |
| Health check endpoint (DB ping) | Infra | Shipped 2026-06-03 |
| Design system (CSS tokens, dark mode, focus rings, reduced-motion) | Infra | Shipped 2026-05 |

---

## Known Issues

| Issue | Status |
|-------|--------|
| Settings page subscription/usage stuck on "Loading..." | Fixed (2026-06-03) — PlaidService ReferenceError blocked script block |
| Stripe payment links (old product IDs) | Fixed (2026-06-03) — updated across 7 files |
| `render.yaml` ran `npm run migrate` on every deploy | Fixed — removed; Neon schema managed manually |
