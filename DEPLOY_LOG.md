# FocusLedger Deploy Log

---

## 2026-05-04 — Engineering Ethos Audit (Task #1360225)

### Objective
Full codebase audit against the Engineering Ethos (constraints drive creativity). Identify and fix violations across three levels: product, engineering, and scope.

---

### Violations Found & Fixed

#### 1. Security: Debug Logs in Auth Route ✅ FIXED
**File:** `routes/auth.js`
**Violation:** 6 debug `console.log` statements left in production login flow:
- Logged the email address of every login attempt
- Logged whether the user account exists (user enumeration oracle)
- Logged whether the password was valid — **authentication oracle** (most severe)
- Logged user IDs and Google auth redirect URLs

**Why it matters:** An attacker with log access could enumerate which emails have accounts and correlate with password validity. This violates OWASP authentication guidance.

**Fix:** Removed all 6 debug logs from the `/api/auth/login` and `/api/auth/google/start` handlers. Meaningful errors (`console.error`) were left intact.

---

#### 2. Rule 11 (Pro Gate): admin_pro_override Bypass in Recurring Tasks ✅ FIXED
**File:** `routes/recurring.js` (POST `/api/recurring/tasks`)
**Violation:** Free-tier limit checks for recurring tasks and task creation used raw SQL queries against `app_subscription` **inside a database transaction**. These bypassed the `admin_pro_override` field entirely — admin users would incorrectly hit the 2-recurring-task and 10-active-task limits.

**Root cause:** The transaction used a `client` (not `pool`), so the `checkIsPro`/`proUtils` utilities couldn't be called. The developer worked around this by querying the subscription table directly, but forgot the admin override.

**Fix:** Move the Pro status check (`isPro(userId)`) **before** the transaction starts. The `isPro()` helper already existed in the file — it calls `checkIsPro(pool, userId)` which correctly checks `admin_pro_override` first. The pre-computed result is then used inside the transaction, replacing both raw subscription queries.

**Before:**
```javascript
// Inside transaction — misses admin_pro_override
const subResult = await client.query('SELECT plan, status FROM app_subscription WHERE user_id = $1 ...', [userId]);
const userIsPro = sub.plan === 'pro' && sub.status === 'active';
```

**After:**
```javascript
// Before transaction — uses checkIsPro which respects admin_pro_override
const userIsPro = await isPro(userId);
// ... then used inside transaction without any raw subscription query
```

---

#### 3. Scope: Dead One-Time Migration Scripts ✅ FIXED
**Files deleted (8 total):**
- `add-privacy-statement.js` — modified `public/index.html`, already applied
- `check-scripts.js` — debug utility that printed package.json scripts
- `remove-credibility.js` — removed lines from `public/index.html`, already applied
- `remove-credibility-js.js` — same purpose as above, redundant
- `scripts/add-support-tab.js` — added Support tab to admin.html, already applied
- `scripts/debug-footer.js` — one-time debug check for bugReportBtn in app.html
- `scripts/fix-footer.js` — one-time footer HTML fix, already applied
- `scripts/patch-html-pwa.js` — one-time PWA meta tag patch, already applied

None were referenced in `package.json`. All were one-time mutations already reflected in the HTML files they targeted.

---

### What Passes (No Action Needed)

- **Rule 1 (Dual-Domain):** Both domains are live and healthy
- **Rule 2 (UI Entry Points):** All nav routes have HTML pages
- **Rule 3 (Bottom Nav):** All app pages have bottom nav
- **Rules 4, 5, 6, 7:** CSP, service worker, route audit — clean
- **Rules 8–10:** Migration safety, silent fetches, error toasts — clean
- **Rule 12:** Auth redirect enforcement in place
- **Rules 13–16, 18–19, 27:** CSRF, secrets scan, SQL injection, rate limiters, env vars, crash handlers, double-submit — all passing (68 smoke checks)
- **server.js:** 179 lines — well under 300-line cap
- **Free tier 10-task cap:** Enforced in `routes/tasks.js` POST via `checkIsPro` + active count query

---

### Known Ongoing Warnings (Not Failures)
- **Rule 11 smoke check reports warnings** for `routes/subscription.js` (raw `sub.plan === 'pro'` check) — this is the subscription display endpoint itself, which legitimately reads raw subscription data to render the user's plan status. This is correct behavior, not a Rule 11 violation.
- **`checkIsPro` in `middleware/auth.js` marked DEPRECATED** — points to `proUtils.checkProStatus`. Multiple routes still use `checkIsPro`. Both functions produce identical results; the deprecation is a migration guide not yet completed. Low urgency.

---

## Feature Recommendations (Engineering Ethos Alignment)

Based on the principle: **constraints drive creativity, productivity, and deeper problem-solving.**

Review and prioritize before next sprint. These are recommendations only — not committed.

---

### Features to ADD (Missing Constraints)

| Feature | Where | Why |
|---------|-------|-----|
| **Task title character cap (150 chars)** | `routes/tasks.js` + `public/app.html` | No max enforced. ADHD users benefit from forced brevity. Short title = actionable task. Long title = unclear scope. |
| **Idea capture cap (280 chars)** | `routes/ideas.js` + `public/ideas.html` | Ideas should be quick captures, not essays. A character limit enforces the "quick capture" pattern. |
| **Free tier task count display** | `public/app.html` task list header | Show "5 / 10 tasks used" badge. Makes the constraint visible and motivating rather than a surprise wall. |
| **Due date relative display** | Task list renders | Show "Tomorrow" / "Friday" / "in 3 days" instead of ISO dates. Reduces cognitive parsing load for ADHD brains. |
| **Time block minimum duration (15 min)** | `routes/time-blocks.js` | No minimum enforced. Sub-15-minute blocks are noise, not planning. Enforce at API level. |

---

### Features to REMOVE or SIMPLIFY

| Feature | File Size | Concern |
|---------|-----------|---------|
| **Email integration** | `routes/email.js` — 60KB, ~1,600 lines | Largest route by 3x. Full inbox management inside FocusLedger adds cognitive load rather than removing it. Unless active user demand exists, scope this down to email-to-task capture only (the high-value ADHD use case). |
| **AI Suggestions separate route** | `routes/ai-suggestions.js` — 20KB | Overlaps with `routes/tasks.js` POST `/suggest-steps`. Two routes doing AI task breakdown. Consider consolidating — one endpoint, one behavior. |
| **Values Alignment Score** | `routes/alignment-score.js` — 20KB | Quantifying "values alignment" as a daily score adds metacognition overhead. ADHD users benefit from doing, not scoring. Consider: remove the score, keep the check-in prompt. |
| **Alignment Nudges** | `routes/alignment-nudges.js` — 15KB | Separate nudge system from the task nudges in `routes/tasks.js`. Two nudge systems = maintenance complexity. Could be simplified or merged. |
| **Document Vault** | `public/vault.html`, `routes/` | No dedicated route handler visible in audit. If it uses a generic file upload pattern, verify it has active usage before investing. |

---

*Recommendations are for review — implement only after confirming user demand and scoping tightly.*

---
