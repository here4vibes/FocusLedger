# FocusLedger — Feature Roadmap

Features tagged "Coming Soon" on the landing page (as of 2026-05-15). Use this for capacity planning.

---

## Coming Soon Features

### 1. Subscription Audit — Kill Duplicates
**Landing page copy:** "Subscription audit — kill duplicates"
**What it would do:** Scan linked bank transactions (Plaid) to identify recurring merchant charges and flag likely subscriptions the user may have forgotten. Surface a list of active subscriptions with cost-per-month and allow one-tap cancellation reminders.
**Tier:** Autopilot (Pro) — requires Plaid bank sync
**Current status:** Not started. Plaid transaction data exists; no UI or detection logic built.

---

### 2. Values-Aligned Spending Reports
**Landing page copy:** "Values-aligned spending reports"
**What it would do:** A dedicated report view showing how monthly spending maps to the user's stated values. E.g., if "Family" is a top value, show how much of discretionary spending went to family activities vs. impulse categories. Trend over time, percentage breakdowns, actionable suggestions.
**Tier:** Autopilot (Pro) — requires values + expense data
**Current status:** Not started. Values alignment score exists (tasks + spending composite); this is a standalone spending-to-values report, which is separate and not built.

---

## Notes

- **Impulse spending detection** is live (Pro). It's algorithmic cross-domain pattern detection (avoidance window + spending spike correlation). It is not a real-time alert system — it surfaces via Accountabilibuddy check-in insights.
- **AI-powered task breakdown** is live but Pro-gated. Landing page now reflects this with a "Pro" badge.
- **Bank sync via Plaid** is live and Pro-gated. Landing page already labeled it as Pro.
- **No Tandem tier** is live yet. No Tandem badges have been added to the landing page.
