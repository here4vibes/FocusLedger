# FocusLedger Standing Engineering Rules

**Last Verified:** 2026-05-03 by Polsia Engineering Agent (Tier 2 hardening)
**All rules enforced by:** `npm run smoke` — 68 PASS, 0 FAIL as of 2026-05-03

These rules keep the app stable, discoverable, and maintainable. They are **automated**, not guidelines. Violations break CI/CD.

---

## Rule 1: Dual-Domain Verification

**Statement:** Every public route must return HTTP 200 on both `focusledger.polsia.app` (Polsia deployment) and `focusledger.net` (custom domain).

**Why:** Users may access the app via either domain. If one domain is broken while the other works, users get inconsistent behavior.

**Enforcement:** `npm run smoke` test 1 fetches `/health` on both domains.

**Domains:**
- Production: `https://focusledger.polsia.app`
- Custom: `https://focusledger.net`

---

## Rule 2: UI Entry Point Verification

**Statement:** Every route in navigation config (`nav-config.js`) must have a corresponding HTML page or server redirect.

**Why:** A route in nav but no page = broken link. Orphan pages without nav = undiscoverable dead code.

**Enforcement:** `npm run smoke` test 2 verifies every route has a page.

**How:** Update `nav-config.js` when adding routes. The config is the single source of truth.

---

## Rule 3: Bottom Nav Consistency

**Statement:** Every app page (authenticated route under `/app/*`, `/settings`, `/ideas`, etc.) must include the bottom tab bar.

**Why:** Users need a consistent way to navigate between features. Missing nav on one page breaks the mental model.

**Current Status:** Bottom nav is hardcoded in:
- `public/app.html` (lines 8629–8661)
- `public/buddy.html`
- `public/portal.html`
- `public/settings.html`
- `public/ideas.html`
- `public/vault.html`

**Enforcement:** `npm run smoke` test 3 checks that bottom nav is present on all app pages.

**Future Improvement:** Extract bottom nav into `nav-config.js` and render dynamically (Phase 2).

---

## Rule 4: CSP (Content-Security-Policy) Validation

**Statement:** All external API domains must be whitelisted in CSP `connect-src` directive.

**Why:** Without CSP whitelist, API calls silently fail (browsers block them). This prevents hard-to-debug issues like "why isn't weather loading?"

**Known Integrations:**
- Open-Meteo (weather)
- ipapi.co (geolocation)
- GNews (news feed)
- Plaid (bank sync)
- Stripe (payments)
- Google (OAuth)

**Enforcement:** `npm run smoke` test 4 parses CSP headers and verifies all known domains are present.

**File:** `middleware/security.js` (Helmet CSP config)

---

## Rule 5: Service Worker Version

**Statement:** Every service worker update must bump the version string (e.g., `fl-v18` → `fl-v19`).

**Why:** Browsers cache service workers aggressively. Without version bump, stale assets may be served, causing users to see old UI/bugs.

**Current Pattern:** Version is `fl-v<N>`, incremented with each deploy.

**Enforcement:** `npm run smoke` test 5 reads `public/sw.js` and confirms a `CACHE_VERSION` exists.

---

## Rule 6: Route Audit

**Statement:** Every Express route defined in `/routes` must either:
- Appear in `nav-config.js` navigation (most routes), OR
- Be whitelisted as intentional (e.g., OAuth callbacks, API endpoints)

**Why:** Routes that exist but aren't discoverable are maintenance debt. They're either dead code or shouldn't be in the codebase.

**Whitelisted (intentionally not in nav):**
- `/health` — Render health check
- `/api/*` — All API endpoints
- `/auth/google/callback` — OAuth redirect
- `/auth/google-auth/callback` — OAuth redirect

**Enforcement:** `npm run smoke` test 6 scans routes and flags unknowns.

---

## Rule 7: No Orphaned Routes

**Statement:** If a route is defined in `nav-config.js`, it must be implemented and reachable. If a route exists but isn't in nav, it must be explicitly whitelisted.

**Why:** Broken nav links confuse users. Unreachable routes are technical debt.

**Enforcement:** `npm run smoke` test 7 verifies every nav item points to a valid route.

---

## Rule 8: Database Migration Safety

**Statement:** After a new migration runs, all database-dependent endpoints must return HTTP 200 (not 500 or connection errors).

**Why:** Migrations can fail silently in production. A broken migration means the app still starts but all DB queries fail. Users see blank pages.

**Process:**
1. Write migration in `/migrations/<timestamp>_<name>.sql`
2. Test locally: `npm run migrate`
3. Deploy
4. `npm run smoke` test 8 hits key endpoints and verifies DB connectivity

**Note:** Requires app to be running and deployed.

---

## Rule 9: No Silent Fetch Failures

**Statement:** Every `fetch()` call in client-side JavaScript must have either:
- `.catch((err) => ...)` error handler, OR
- `if (!res.ok) { ... }` check inside `.then()`

**Why:** Silent fetch failures are the #1 cause of "something's broken but the app doesn't tell the user." Users see blank content, no error message.

**Antipattern (FORBIDDEN):**
```javascript
// ❌ NO — error silently swallows
fetch('/api/tasks')
  .then(r => r.json())
  .then(data => renderTasks(data));
  // If fetch fails: nothing happens, no error shown
```

**Pattern (GOOD):**
```javascript
// ✅ YES — error is handled
fetch('/api/tasks')
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(data => renderTasks(data))
  .catch(err => showErrorToast(`Failed to load tasks: ${err.message}`));
```

**Enforcement:** `npm run smoke` test 9 greps all client JS for unhandled `fetch()` calls.

---

## Rule 10: Error Toast Coverage

**Statement:** Every HTML form must have associated JavaScript that displays user-visible feedback on failure.

**Why:** Forms that silently fail (submission happens, nothing visible) are worse than forms that don't submit. Users don't know if they succeeded or need to retry.

**Pattern:** Form handlers must include DOM updates on error (showing a message, changing button state, etc.).

**Enforcement:** `npm run smoke` test 10 checks that forms have error handling logic.

---

## Rule 11: Pro Gate Consistency

**Statement:** All Pro feature gating must use a centralized utility function. No raw `user.plan` or `user.subscription` checks scattered through the code.

**Why:** When Pro logic changes (new tier, new rule), one change point is maintainable. Scattered checks mean you miss some, causing inconsistency.

**Whitelisted Utility:** `middleware/pro-gating.js` (or similar)

**Antipattern (FORBIDDEN):**
```javascript
// ❌ NO — raw check
if (user.subscription === 'pro') { ... }
if (user.plan === 'premium') { ... }
```

**Pattern (GOOD):**
```javascript
// ✅ YES — centralized
const isPro = require('../middleware/pro-gating');
if (isPro(user)) { ... }
```

**Enforcement:** `npm run smoke` test 11 greps for raw subscription checks.

---

## Rule 12: Auth Redirect Enforcement

**Statement:** All authenticated routes (`/app/*`, `/settings`, `/ideas`, etc.) must redirect unauthenticated users to `/login`.

**Why:** Protected routes should never show app content without a valid session. Broken auth middleware = data leakage risk.

**Pattern:** Auth middleware in `server.js` or route middleware verifies JWT before rendering protected pages.

**Enforcement:** `npm run smoke` test 12 verifies auth middleware is in place.

---

## Rule 13: CSRF Protection

**Statement:** Every POST/PUT/DELETE route that modifies user data must use Bearer JWT authentication. Since this app stores JWTs in `localStorage` and sends them via the `Authorization` header, it is inherently CSRF-immune — browsers never auto-send the `Authorization` header cross-origin.

**Why:** Cookie-based auth is vulnerable to CSRF. We avoid it by design. If any route ever switches to cookie-based auth, it must add explicit CSRF tokens.

**Public mutation endpoints** (intentionally unauthenticated — CSRF-exempt): `login`, `signup`, `forgot-password`, `reset-password`, `contact/submit`, `adhd-tax/capture`, analytics beacons.

**Enforcement:** `npm run smoke` Rule 13 — verifies all state-changing routes either use `authenticateToken` or are in the public-exempt list.

---

## Rule 14: No Secrets in Client Code

**Statement:** No API keys, database URLs, session secrets, or env var values may appear in any file served to browsers (`public/*.html`, `public/*.js`).

**Why:** Anything in `public/` is visible to every user. A leaked `STRIPE_SECRET_KEY` or `DATABASE_URL` is an immediate security incident.

**Forbidden patterns:** `process.env.*` references, `sk_live_*`, `sk_test_*`, `DATABASE_URL=...`, `JWT_SECRET=...` in any static file.

**Enforcement:** `npm run smoke` Rule 14 — greps all files in `public/` for credential patterns.

---

## Rule 15: SQL Injection Audit

**Statement:** Every database query must use parameterized inputs (`$1`, `$2`, ...). No raw string interpolation (`${...}`) directly inside SQL template literals.

**Why:** String interpolation in SQL allows injection attacks. The one allowed exception is dynamic column-name builders where column names come from a validated whitelist — these are downgraded to warnings, not failures.

**Known safe patterns (warnings, not failures):**
- `${updates.join(', ')}` — column list from validated whitelist in tasks, recurring, notifications routes
- `routes/journal.js ${field}` — always a hard-coded literal at all call sites
- `routes/outbound-email.js ${type}` — validated against `validTypes[]` before SQL; `${where}` — parameterized conditions only

**Enforcement:** `npm run smoke` Rule 15 — greps route files for SQL template literals with `${...}`. Direct variable interpolation → FAIL. Array-join patterns → WARN.

---

## Rule 16: Rate Limiting on Auth Endpoints

**Statement:** Login, signup, forgot-password, and reset-password must each have a dedicated rate limiter applied to the route handler.

**Why:** Without rate limiting, these endpoints are open to brute-force attacks. Login attempts, password reset token generation, and signup flows must all be throttled per IP.

**Limits:**
- `loginLimiter`: 10 requests / 15 minutes
- `signupLimiter`: 5 requests / hour
- `passwordResetLimiter`: 5 requests / 15 minutes

**File:** `middleware/security.js`

**Enforcement:** `npm run smoke` Rule 16 — verifies each auth route definition references its limiter.

---

## Rule 18: Env Var Validation on Startup

**Statement:** `server.js` must validate all required env vars before `app.listen()`. A missing required var must call `process.exit(1)` with a clear error message. A runtime failure mid-session is unacceptable.

**Required vars:**
- `DATABASE_URL` — hard fail (`process.exit(1)`)

**Soft-warn vars:**
- `JWT_SECRET` — warns but continues (uses generated fallback in dev; should hard-fail in a future hardening pass)

**Enforcement:** `npm run smoke` Rule 18 — verifies `DATABASE_URL` validation with `process.exit(1)` exists before `app.listen()`.

---

## Rule 19: Uncaught Exception Handlers

**Statement:** `server.js` must register both `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that log meaningfully. Silent crashes are unacceptable.

**Why:** Without these handlers, Node.js logs nothing useful and exits with a cryptic code. These handlers ensure Render's log capture picks up the error before process death.

**Pattern:**
```javascript
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});
```

**Enforcement:** `npm run smoke` Rule 19 — greps `server.js` for both handler registrations.

---

## Rule 27: Double-Submit Prevention

**Statement:** Every HTML form must disable its submit button immediately on first click and show a loading state until the server response is received.

**Why:** Double-submit creates duplicate records (tasks, expenses, contact submissions). Network lag makes it likely — without prevention, users click twice and both requests succeed.

**Pattern (required):**
```javascript
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';
  try {
    const res = await fetch('/api/...', { method: 'POST', ... });
    // handle response
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save';
  }
});
```

**Enforcement:** `npm run smoke` Rule 27 — checks that each HTML form page's script has `.disabled = true` and a loading text change.

---

## Running the Smoke Test

```bash
# Run all checks
npm run smoke

# Exit codes:
# 0 = all passed
# 1 = any failures
```

**Output Format:**
```
╔════════════════════════════════════════════╗
║    FocusLedger Comprehensive Smoke Test    ║
║  Standing Engineering Rules Enforcement    ║
╚════════════════════════════════════════════╝

--- Test 1: Dual-Domain Verification ---
✅ PASS: Health check — https://focusledger.polsia.app
✅ PASS: Health check — https://focusledger.net

--- Test 2: UI Entry Point Verification ---
✅ PASS: UI Entry Point — Home (/)
✅ PASS: UI Entry Point — Tasks (/app)
...

[Summary]
✅ Passed: 47
❌ Failed: 0
⚠️  Warnings: 2
```

---

## How These Rules Prevent Production Incidents

| Incident | Prevented By |
|----------|--------------|
| Custom domain breaks (users can't access) | Rule 1 (dual-domain) |
| New feature added but no nav link (undiscoverable) | Rule 2 (UI entry points) |
| Bottom nav missing on one page (broken UX) | Rule 3 (bottom nav consistency) |
| API calls fail silently, users see blank page | Rule 4 (CSP) + Rule 9 (no silent fetches) |
| Service worker caches old buggy assets | Rule 5 (SW version) |
| Orphan routes accumulate, codebase bloats | Rule 6 & 7 (route audit) |
| Migration breaks in prod, all DB queries fail | Rule 8 (migration safety) |
| Form doesn't work, user doesn't know, retries endlessly | Rule 10 (error toasts) |
| Pro feature availability changes inconsistently | Rule 11 (pro gate consistency) |
| Unauthenticated user sees app content or crashes | Rule 12 (auth redirect) |
| CSRF attack changes user data via malicious site | Rule 13 (CSRF protection) |
| API key leaked in static JS, credentials stolen | Rule 14 (no secrets in client) |
| SQL injection via unsanitized query string | Rule 15 (SQL injection audit) |
| Brute-force login or password reset token enumeration | Rule 16 (auth rate limiting) |
| Missing env var causes silent runtime failure mid-session | Rule 18 (env var validation) |
| Unhandled rejection crashes process silently | Rule 19 (exception handlers) |
| Double-submit creates duplicate records | Rule 27 (double-submit prevention) |

---

## Adding a New Route

**Checklist:**

1. **Create the page** (`public/newfeature.html`)
2. **Add to nav-config.js:**
   ```javascript
   NAV_CONFIG.appPages.push({
     label: 'New Feature',
     icon: '✨',
     route: '/new-feature',
     visibility: 'authenticated',
     type: 'app'
   });
   ```
3. **Add Express route** (`routes/pages.js`):
   ```javascript
   router.get('/new-feature', (_, res) => res.sendFile(pub('newfeature.html')));
   ```
4. **Run tests:**
   ```bash
   npm run smoke
   npm run test
   ```
5. **Verify bottom nav is on the page** (check HTML includes `bottom-tabs`)

---

## CI/CD Integration

**Before deploying:**
```bash
npm run lint    # catches code style issues
npm run test    # unit tests
npm run smoke   # engineering rules
```

If any step fails, the deploy is blocked. No exceptions.

---

## Questions?

- **Unclear rule?** → Read the "Why" section
- **Rule is wrong?** → File an issue (process TBD)
- **Need an exception?** → Whitelist in `nav-config.js` WHITELISTED_ROUTES with comment explaining why
