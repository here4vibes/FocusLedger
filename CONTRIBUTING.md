# Contributing to FocusLedger

**Read this before writing any code.**

## Engineering Playbook

All engineering work follows the canonical playbook:

→ [`docs/engineering-playbook.md`](docs/engineering-playbook.md)

It covers:
- **Pre-flight checklist** — prior-task verification, repo grep, impact mapping
- **CSS guardrails** — mobile layout rules, safe-area insets, design tokens
- **Build checklist** — screenshots, diff summary, verification statement
- **Naming rules** — Free / Autopilot / Tandem (no Pro/Premium/Plus)
- **Self-check block** — copy-paste before every push

## Shipped Ledger

Before starting any task, check whether it was already shipped:

→ [`docs/shipped-ledger.md`](docs/shipped-ledger.md)

After shipping, add one row to the ledger before marking the task done.

## Architecture

Key invariants are in [`CLAUDE.md`](CLAUDE.md):
- `server.js` ≤ 300 lines (wiring only)
- All queries in `db/<entity>.js`
- All DDL in `migrations/`
- All "today" date math via `lib/timezone.js`
