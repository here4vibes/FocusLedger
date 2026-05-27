# FocusLedger

Focus on what matters. Track tasks, spending, and values alignment.

**Live:** https://focusledger.polsia.app

---

## Requirements

- Node.js 18+
- PostgreSQL database (Neon recommended)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | Secret for JWT signing (set in production) |
| `PLAID_CLIENT_ID` | optional | Plaid bank sync (PRO feature) |
| `PLAID_SECRET` | optional | Plaid bank sync (PRO feature) |
| `ADMIN_EMAILS` | optional | Comma-separated admin emails (e.g. `admin@example.com,owner@example.com`) |
| `PORT` | optional | Server port (default: 3000) |

## Local Development

```bash
npm install
DATABASE_URL="postgresql://..." JWT_SECRET="your-secret" npm run dev
```

## Running Tests

Tests use Jest with mocked database connections — no real DB needed.

```bash
# Install dependencies first
npm install

# Run all tests
npm test

# Watch mode (re-runs on file change)
npm run test:watch
```

**What's tested:**
- `auth.middleware.test.js` — JWT generation/validation, password hashing, Pro status check
- `auth.routes.test.js` — Signup, login, duplicate email, case-insensitive login
- `tasks.routes.test.js` — CRUD, 10-task free limit, step-toggle regression
- `values.routes.test.js` — CRUD, value_name insert regression
- `expenses.routes.test.js` — Add expense, budget remaining calculation regression
- `subscription.routes.test.js` — Pro gating (Stripe + admin override), task limits
- `ideas.routes.test.js` — Submit/list ideas, admin email check regression

## Pre-Deploy Gate

The Render build runs `npm test` before migrating or starting the server:

```
npm install && npm test && npm run migrate
```

If any test fails, the deploy aborts — broken code never ships.

## Deployment

Production deploys go through Render (auto-configured via `render.yaml`).

Migrations run automatically during the build phase before the server starts.
