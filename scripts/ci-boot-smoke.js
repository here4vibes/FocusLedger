#!/usr/bin/env node
'use strict';
/**
 * ci-boot-smoke.js — the integration guard the static tests can't be.
 *
 * WHY: Almost every outage this project has shipped was invisible to unit tests
 * because it only appeared once real code met a real database or a real boot:
 *   - a table/column a migration never created (budgets, expenses.updated_at, …)
 *   - a NULL-default id column that made rows uneditable
 *   - an imported-but-undefined function that threw only when called
 *   - a route file that throws at construction and takes the whole app down
 *
 * This boots the REAL server against a REAL (freshly migrated) Postgres and
 * drives the critical auth path end-to-end. If migrations didn't apply, a column
 * is missing, a route won't mount, or signup/login regress, this goes red in CI
 * instead of in production.
 *
 * Prereqs (CI sets these): DATABASE_URL points at a migrated DB, JWT_SECRET set.
 * Run:  node scripts/ci-boot-smoke.js
 * Exit: 0 = all checks passed, 1 = a check failed or the server crashed.
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.SMOKE_PORT || 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 45000;

if (!process.env.DATABASE_URL) {
  console.error('[boot-smoke] FATAL: DATABASE_URL is required');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('[boot-smoke] FATAL: JWT_SECRET is required');
  process.exit(1);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function req(method, pathname, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

async function waitForBoot(child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode} (crashed on boot)`);
    }
    try {
      const res = await fetch(BASE + '/health');
      if (res.status === 200 || res.status === 503) return; // listening
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server did not become reachable within ${BOOT_TIMEOUT_MS}ms`);
}

async function main() {
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      ALLOWED_ORIGIN: BASE,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let crashed = false;
  child.on('exit', (code) => {
    if (code && code !== 0) crashed = true;
  });

  try {
    await waitForBoot(child);
    record('server boots and mounts all routes', true, `reachable at ${BASE}`);

    // 1. Health — DB connectivity + migration table readable
    const health = await req('GET', '/health');
    record(
      'GET /health → db ok',
      health.status === 200 && health.json?.db === 'ok',
      `status=${health.status} db=${health.json?.db}`
    );

    // 2. Signup — exercises validateTimezone, budgets/app_subscription inserts,
    //    seed helpers, welcome-email path — the flow that broke in production.
    const email = `ci-smoke-${Date.now()}@example.com`;
    const password = 'Sm0keTest!pw';
    const signup = await req('POST', '/api/auth/signup', {
      body: { email, password, name: 'CI Smoke', timezone: 'America/New_York' },
    });
    const signupOk = signup.status === 201 && signup.json?.success === true && typeof signup.json?.token === 'string';
    record('POST /api/auth/signup → 201 + token', signupOk, `status=${signup.status} success=${signup.json?.success}`);

    // 3. Login — verify the account we just created authenticates
    const login = await req('POST', '/api/auth/login', { body: { email, password } });
    const loginOk = login.status === 200 && login.json?.success === true && typeof login.json?.token === 'string';
    record('POST /api/auth/login → 200 + token', loginOk, `status=${login.status} success=${login.json?.success}`);

    // 4. Authenticated read — proves a real query against a real table works
    const token = login.json?.token || signup.json?.token;
    if (token) {
      const tasks = await req('GET', '/api/tasks', { token });
      record('GET /api/tasks (authed) → not 5xx', tasks.status < 500, `status=${tasks.status}`);
    } else {
      record('GET /api/tasks (authed) → not 5xx', false, 'no token from signup/login');
    }
  } catch (err) {
    record('server boots and mounts all routes', false, err.message);
  } finally {
    child.kill('SIGTERM');
    // Give it a moment to shut down cleanly.
    await sleep(500);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n[boot-smoke] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length || crashed) {
    console.error('[boot-smoke] FAILED');
    process.exit(1);
  }
  console.log('[boot-smoke] OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('[boot-smoke] unexpected error:', err.stack || err.message);
  process.exit(1);
});
