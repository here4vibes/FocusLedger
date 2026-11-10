---
name: webapp-testing
description: Drive FocusLedger's pages in a local headless Chromium with Playwright to check a UI change really works — sign up a throwaway user, open the page signed in, click through, capture console errors and screenshots, and check phone and desktop widths. Use whenever you change anything in public/ or views/, a page "bounces to Home" or looks blank, or the Pre-Ship Checklist asks for a Buddy tap test or a viewport check.
---

<!--
NOTICE: Adapted from anthropics/skills, skills/webapp-testing at commit
dbd4588f9e1033efb41dad4bef2f7947c8993d44. Licensed under the Apache License 2.0
(see LICENSE.txt in this directory). Modified for FocusLedger: rewritten from
Python to Node Playwright, the bundled with_server.py helper and examples were
not copied, and the steps follow CLAUDE.md "Local browser testing".
-->

# Web App Testing (FocusLedger)

Test local pages with a short Node Playwright script. This is for checking a change by hand in a session; the CI suites (`npm run test:e2e`, `test:smoke`, `test:visual`, `test:sweep`, `test:flows`) are separate and keep their own configs.

## Before you start

- **Never point this at prod.** The proxy blocks focusledger.net anyway; test prod via GitHub Actions.
- **Never use the QA user** (`qa@focusledger.net`, id 25). Make a fresh user per run.
- Local Postgres must be up and migrated (CLAUDE.md "Local Postgres"): `pg_ctlcluster 16 main start` if the container restarted, `DATABASE_URL=postgres://fl:fl@localhost:5432/focusledger`, then `node migrate.js`.
- Run scripts from inside the repo so `require('playwright')` resolves, and write them to your scratchpad, not the repo.

## Decision tree

```
Is it a pure static page (no fetch to /api, no auth)?
├─ Yes → read the HTML for selectors, then open it through the server anyway
│        (CSP, redirects and shared-nav only behave right when served)
└─ No  → is the server running on :3999?
    ├─ No  → start it in the background (below), wait for /health
    └─ Yes → reconnaissance, then action:
             1. goto + wait for 'networkidle'
             2. screenshot and/or list buttons, links, inputs
             3. pick selectors from what rendered
             4. act, then assert on the follow-up state
```

## 1. Start the server

Run it with the Bash tool's `run_in_background`, not `&`:

```bash
PORT=3999 JWT_SECRET=x SESSION_SECRET=x DATABASE_URL=postgres://fl:fl@localhost:5432/focusledger node server.js
```

Wait until `curl -s localhost:3999/health` answers. To stop it later, find the PID whose `/proc/<pid>/environ` contains `PORT=3999`; never `pkill -f` a pattern that matches your own shell.

## 2. Make a signed-in user

Sign up once per run (repeated logins trip the auth rate limiter and pages bounce to login or Home):

```bash
curl -s -X POST localhost:3999/api/auth/signup -H 'Content-Type: application/json' \
  -H 'X-FL-Automation: e2e' \
  -d '{"email":"pw-'"$(date +%s)"'@example.test","password":"testpass123","timezone":"America/Los_Angeles"}'
# → 201 { success, token, user: { id, email, name } }
```

If the test adds more than 10 tasks, lift the free cap for that user: `UPDATE users SET admin_pro_override = true WHERE id = <id>` (local DB only).

## 3. The script

```javascript
// scratchpad/check-page.js — run with: node <path> from the repo root
const { chromium } = require('playwright');

const BASE = 'http://localhost:3999';
const { token, user } = JSON.parse(process.env.FL_SIGNUP); // the signup JSON

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },          // phone first; see step 4
    extraHTTPHeaders: { 'X-FL-Automation': 'e2e' }, // keeps the hit out of analytics
  });
  // Auth lives in localStorage under fl_token / fl_user (never `token`).
  await context.addInitScript(([t, u]) => {
    localStorage.setItem('fl_token', t);
    localStorage.setItem('fl_user', JSON.stringify(u));
  }, [token, user]);

  const page = await context.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${r.status()} ${r.url()}`); });

  await page.goto(BASE + '/app/tasks');
  await page.waitForLoadState('networkidle'); // let the page's own fetches finish first
  if (!page.url().includes('/app/tasks')) problems.push('redirected to ' + page.url());

  await page.screenshot({ path: process.env.SHOT || 'shot.png', fullPage: true });
  // ...actions: page.getByRole('button', { name: 'Add' }).click(), fill, etc.

  await browser.close();
  if (problems.length) { console.error('[webapp-test] problems:\n' + problems.join('\n')); process.exit(1); }
  console.log('[webapp-test] ok');
})().catch(e => { console.error('[webapp-test] failed:', e.message); process.exit(1); });
```

Then look at the screenshot with the Read tool. A run that "passes" with an empty page is a failure.

## 4. What to check (maps to the Pre-Ship Checklist)

- **Viewports:** phone 375, 428 and 768 (60px bottom bar, no task-card overflow, the › chevrons tappable); desktop 1280 and 1440 (200px left sidebar, no horizontal scrollbar). Overflow test: `await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)` must be `false`.
- **Buddy tap test:** on any signed-in page except Home and flow screens, tap `#fl-buddy-btn`, wait for `#bw-panel` to be visible, send a message, close with Esc. Home (`/weightless`) is the chat itself.
- **Bounce to Home or login:** usually a page reading `localStorage.token` instead of `fl_token`, or a tripped auth limiter.
- **Silent page death:** a `pageerror` on load often means an inline-script syntax error (the parse test in `__tests__/inline-scripts-parse.test.js` should also catch it).
- **Server log:** after the run, scan the server output for `does not exist`, `TypeError` or `[...] failed:` lines. A SQL error locally is a prod bug, since the local schema is prod's.

## Tips

- Prefer role and text selectors (`getByRole`, `getByText`) or ids over brittle CSS paths.
- Wait for a specific element (`page.waitForSelector`) rather than fixed timeouts.
- One script per check; close the browser in every path.
- To report results, include the screenshot path and the problems list, not the whole DOM.
