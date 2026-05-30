# FocusLedger Engineering Playbook

> **Mandatory reference for every engineering task.** Read this before writing a line of code.

---

## 1. Pre-Flight Checklist (Run Before Writing Any Code)

### a. Prior-Work Verification
1. Open `docs/shipped-ledger.md` and scan for tasks that may already address this work.
2. If a match is found: **post the prior task ID + one-line summary and stop** — do not duplicate shipped work.
3. If partial work exists: note what was done, scope only what remains.

### b. Grep the Repo First
Search for the feature name, file name, or route path mentioned in the task:
```bash
grep -r "feature-keyword" routes/ db/ lib/ public/js/ --include="*.js" -l
```
If a recent commit touched those files, read those files before proceeding. Know what already exists.

### c. Map the Impact Surface
Before touching code, write a one-line answer to each:
- Which **routes** does this task add/modify?
- Which **db/** query functions are affected?
- Which **HTML pages** render the affected data?
- Which **shared libs** (`lib/`, `middleware/`) are in scope?

Only proceed once you have this list. It becomes your "verify" list after shipping.

---

## 2. CSS Guardrails (Lessons from /app/checkin Bug)

### a. Overflow-Hidden + Full-Height Shell
Any page that sets:
```css
body { overflow: hidden; height: 100dvh; display: flex; flex-direction: column; }
```
**must** reserve bottom space for the 60px shared-nav bar using padding on the **inner flex child**, NOT on `body`:

```css
/* WRONG — useless when body scroll is disabled */
body { padding-bottom: 60px; }

/* CORRECT — pad the scrollable inner container */
#mainContent {
  padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  flex: 1;
}
```

Root cause: with `overflow: hidden` on body, `body { padding-bottom }` is invisible. The padding must live on the scrollable child.

### b. Fixed-Position Bottom UI
Any element pinned to the bottom of the viewport must include safe-area inset:
```css
.bottom-bar {
  bottom: 0;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
```
Never hardcode a pixel value for the safe area — different iPhone notch sizes vary.

### c. Color Tokens — No Hardcoded Hex
Use `public/css/design-system.css` tokens for all text and background colors. Never write hardcoded hex values inline:
```css
/* WRONG */
color: #1a1a2e;
background: #ffffff;

/* CORRECT */
color: var(--text-primary);
background: var(--bg-surface);
```
If a new token is needed, add it to `design-system.css` first.

### d. Mobile Viewport Requirement
Before claiming any UI task done, verify at both:
- **375 × 667** (iPhone SE — smallest supported)
- **390 × 844** (iPhone 14 — primary target)

Checklist per viewport:
- [ ] No content clipped by bottom nav
- [ ] No horizontal scroll introduced
- [ ] Touch targets ≥ 44px
- [ ] Input fields visible when keyboard is open

---

## 3. Build Checklist (Required Before Marking Done)

Every engineering task must satisfy all of the following before `complete_task` is called:

### a. Screenshot Requirement
- Mobile screenshot (375px wide) of the change
- Desktop screenshot (1280px wide) of the change
- If backend-only: state explicitly "no UI surface" in completion summary

### b. Diff Summary
List every file touched, with a one-line description of what changed:
```
routes/buddy.js       — added timezone-aware date filter
db/expenses.js        — getTodaySpend now uses getUserLocalDate()
public/money.html     — today-spend widget shows local date
```

### c. Verification Statement
Write out which pages/flows were manually or programmatically verified:
> "Verified: `/app/checkin` on mobile (375px) — input visible above nav. `/app/buddy` unaffected."

### d. Shipped-Ledger Update
Append one row to `docs/shipped-ledger.md` **before pushing**:
```
| task_id | YYYY-MM-DD | One-line summary | files/touched.js | /pages/affected |
```

---

## 4. Naming Rules

These are the **only valid plan names** in FocusLedger. Use them verbatim in all UI copy, emails, error messages, and code comments:

| Tier | Name | Price |
|------|------|-------|
| Free tier | **Free** | $0 |
| Paid tier 1 | **Autopilot** | $9.99/mo |
| Paid tier 2 | **Tandem** | $14.99/mo |

**Never use**: Pro, Premium, Plus, Starter, Basic, Advanced, or any variant.

Applies to:
- Plan badge labels (`plan_label` in API responses)
- Email copy
- Pricing page
- Feature gate error messages (`"Upgrade to Autopilot to unlock..."`)
- Database values and code comments

---

## 5. Architecture Reminders (Short Form)

Full rules live in `CLAUDE.md`. Key invariants:

| Rule | What it means |
|------|---------------|
| `server.js` ≤ 300 lines | Wiring only — no business logic |
| All queries in `db/<entity>.js` | No `pool.query()` in routes or lib |
| All DDL in `migrations/` | No `CREATE TABLE` in runtime files |
| All endpoints in `routes/<name>.js` | No `app.get()` in server.js |
| `lib/timezone.js` for all date math | No `new Date()` UTC comparisons for "today" |
| `lib/task-filters.js` for task queries | One source of truth for actionable-date filter |

---

## 6. Self-Check Block (Copy-Paste Before Every Push)

```bash
{ [ -f server.js ] && [ "$(wc -l < server.js)" -gt 300 ] && echo "FAIL: server.js > 300 lines"; } || echo "PASS: server.js LOC"
{ [ -f CLAUDE.md ] && [ "$(wc -l < CLAUDE.md)" -le 150 ] && echo "PASS: CLAUDE.md ≤ 150 lines"; } || echo "FAIL: CLAUDE.md missing or > 150 lines"
{ [ ! -f server.js ] || node --check server.js; } && { [ ! -d routes ] || find routes -type f -name '*.js' -exec node --check {} \;; } && echo "PASS: syntax" || echo "FAIL: syntax"
{ grep -lnE 'new Pool\(|pool\.query\(' $(git ls-files '*.js' | grep -v '^db/') 2>/dev/null && echo "FAIL: raw SQL outside db/"; } || echo "PASS: db/ encapsulation"
```

All four must print PASS before pushing.

---

## 7. Default Seed Data: Canonical Values (Invariant)

Every new FocusLedger user account **must** be seeded with the following 8 values on first signup, in this exact order. This is a documented product invariant — do not change names, order, or omit entries without updating the backfill migration and this section.

| Rank | Name | Maslow Tier | Icon | Color |
|------|------|-------------|------|-------|
| 1 | Health | Physiological | 🏃 | `#5BA4A4` |
| 2 | Security | Safety | 🏠 | `#3E7CB1` |
| 3 | Relationships | Belonging | ❤️ | `#E07A5F` |
| 4 | Growth | Esteem | 🌱 | `#c9a84c` |
| 5 | Creativity | Self-actualization | 🎨 | `#9B72CF` |
| 6 | Autonomy | Self-actualization | ⚡ | `#E09A3C` |
| 7 | Learning | Esteem/growth | 📚 | `#02287a` |
| 8 | Money | Security | 💰 | `#2E7D32` |

**Implementation files:**
- `lib/seedDefaultValues.js` — source of truth for the array; called fire-and-forget on every auth path
- `routes/auth.js` — calls `seedDefaultValues()` on: password signup, password login, Google OAuth callback (new + returning), Google One Tap (new + returning)
- `migrations/1749050000000_backfill_canonical_values.js` — one-shot backfill for pre-seeding users; idempotent
- `__tests__/seed-default-values.test.js` — regression test; asserts 8 values in exact name+rank order

**Rules:**
- All values are user-editable (rename, reorder, delete) — none are locked/system-only.
- The seeder is idempotent: if a user already has ≥1 value, nothing is inserted.
- The AI task-suggestion ranker (`routes/buddy.js → scoreTasks()`) weights value-aligned tasks at 25% of the composite score.
- Never add a new auth path without calling `seedDefaultValues(pool, userId)` at the end.

---

*Last updated: 2026-05-21 · Task #1747801*
