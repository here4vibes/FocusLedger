#!/usr/bin/env node
'use strict';
/**
 * ci-api-sweep.js — GET every parameterless /api route as a signed-in user.
 *
 * WHY: the from-scratch migrated schema is a copy of production's (the genesis
 * baseline was generated from prod's information_schema), so a SQL error here
 * is a production bug. The first run of this sweep found 20 routes querying
 * columns prod never had (buddy_conversations.content, users.given_name,
 * tasks.archived, buddy_checkins.type, …), TEXT columns compared as booleans,
 * a router that read an unset req.pool, and a route shadowed by "/:id".
 * Many routes catch the error, log it and still answer 200, so the server's
 * log output is checked as well as the status code.
 *
 * How it works:
 *   1. Discovers routes by parsing server.js for `app.use('/api…', require('./routes/x'))`
 *      and each route file for `<router>.get('/path'` with no `:param`, `*` or regex.
 *   2. Boots the real server, signs up a fresh user, GETs each route with its token.
 *   3. Fails on: a 5xx other than 503 (503 = feature not configured locally,
 *      e.g. missing OAuth env vars), a network error, or a logged error line
 *      matching ERROR_PATTERNS that no ALLOWLIST entry explains.
 *
 * ~160 routes at 150ms apart stays well under the 300 req / 15 min global limiter.
 *
 * Prereqs (CI sets these): DATABASE_URL points at a migrated DB, JWT_SECRET set.
 * Run:  node scripts/ci-api-sweep.js        (npm run test:sweep)
 * Exit: 0 = every route clean, 1 = a route failed or the server didn't boot.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, requireEnv, startServer, unexplainedErrors } = require('./ci-harness');

const PORT = process.env.SWEEP_PORT || 3112;
const REQUEST_TIMEOUT_MS = 15000;
const GAP_MS = 150; // lets the route's async logging land before the next request

requireEnv('api-sweep');

/** Parameterless GET routes, as full paths, from server.js mounts + route files. */
function discoverRoutes() {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routes = new Set();
  const mountRe = /app\.use\(\s*'(\/api[^']*)'\s*,\s*require\('\.\/routes\/([^']+)'\)/g;
  for (const [, mount, file] of server.matchAll(mountRe)) {
    const routeFile = path.join(ROOT, 'routes', file.replace(/\.js$/, '') + '.js');
    if (!fs.existsSync(routeFile)) continue;
    const src = fs.readFileSync(routeFile, 'utf8');
    for (const [, sub] of src.matchAll(/\b\w+\.get\(\s*['"`](\/[^'"`]*)['"`]/g)) {
      if (/[:*(]/.test(sub)) continue; // needs an id, wildcard or regex
      routes.add(mount + (sub === '/' ? '' : sub));
    }
  }
  return [...routes].sort();
}

async function main() {
  const routes = discoverRoutes();
  console.log(`[api-sweep] ${routes.length} parameterless GET routes discovered`);

  const failures = [];
  let server = null;
  try {
    server = await startServer(PORT);
    const BASE = server.base;

    const signup = await fetch(BASE + '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `ci-sweep-${Date.now()}@example.com`,
        password: 'Sw33pTest!pw',
        name: 'CI Sweep',
        timezone: 'America/New_York',
      }),
    });
    const token = (await signup.json().catch(() => ({}))).token;
    if (!token) throw new Error(`signup failed (status ${signup.status}), cannot sweep authed routes`);
    await sleep(1500); // signup's fire-and-forget work (seeding, welcome email) logs here

    const signupErrors = unexplainedErrors(server.drainLogs());
    if (signupErrors.length) failures.push({ route: 'POST /api/auth/signup', status: signup.status, errors: signupErrors });

    for (const route of routes) {
      let status;
      try {
        const res = await fetch(BASE + route, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = res.status;
        await res.text();
      } catch (err) {
        status = `network error: ${err.message}`;
      }
      await sleep(GAP_MS);

      const errors = unexplainedErrors(server.drainLogs());
      const badStatus = typeof status !== 'number' || (status >= 500 && status !== 503);
      if (badStatus || errors.length) failures.push({ route, status, errors });
    }
  } catch (err) {
    failures.push({ route: '(setup)', status: 'n/a', errors: [err.message] });
  } finally {
    if (server) await server.stop();
  }

  for (const f of failures) {
    console.log(`❌ ${f.status} ${f.route}`);
    for (const line of f.errors.slice(0, 3)) console.log(`     ${line.trim().slice(0, 300)}`);
  }
  console.log(`\n[api-sweep] ${routes.length} routes swept, ${failures.length} failed`);
  if (failures.length) {
    console.error('[api-sweep] FAILED');
    process.exit(1);
  }
  console.log('[api-sweep] OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('[api-sweep] unexpected error:', err.stack || err.message);
  process.exit(1);
});
