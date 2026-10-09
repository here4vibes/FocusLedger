#!/usr/bin/env node
/**
 * Production signup check — can a brand-new person sign up and use the app?
 *
 * Signups were silently broken from ~2026-05-29 to 2026-10-08 (users.id had no
 * default, so new accounts were stored with id = NULL) and nobody noticed for
 * four months. This drives the real email-signup path end to end against
 * production and exits 1 if any step fails, so the scheduled workflow
 * (.github/workflows/prod-signup-check.yml) goes red the day it breaks.
 *
 * Uses a synthetic address (signup-monitor+<tag>@focusledger.net). The signup
 * route flags these as QA users (lib/monitor-accounts.js): excluded from every
 * metric, no welcome email.
 *
 * Env: BASE_URL (default https://focusledger.net), MONITOR_TAG (default: timestamp)
 */
'use strict';

const BASE = (process.env.BASE_URL || 'https://focusledger.net').replace(/\/$/, '');
const TAG = (process.env.MONITOR_TAG || String(Date.now())).toLowerCase().replace(/[^a-z0-9._-]/g, '');
const EMAIL = `signup-monitor+${TAG}@focusledger.net`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}

async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'FocusLedger-signup-monitor (+https://github.com/here4vibes/focusledger)',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

async function main() {
  console.log(`[signup-check] ${BASE} as ${EMAIL}`);

  const signup = await req('POST', '/api/auth/signup', {
    email: EMAIL,
    password: `Mon-${TAG}-${Math.random().toString(36).slice(2)}`,
    name: 'Signup Monitor',
    timezone: 'America/New_York',
  });
  const token = signup.json && signup.json.token;
  const id = signup.json && signup.json.user && signup.json.user.id;
  if (!record('signup → 201 with a token', signup.status === 201 && typeof token === 'string',
    `status=${signup.status}${signup.json && signup.json.message ? ' message=' + signup.json.message : ''}`)) return;
  // The May–Oct bug: accounts were created with id = NULL.
  if (!record('new account has a real numeric id', Number.isInteger(id) && id > 0, `id=${JSON.stringify(id)}`)) return;

  const me = await req('GET', '/api/auth/me', null, token);
  record('token identifies the same account (/api/auth/me)',
    me.status === 200 && me.json && me.json.user && me.json.user.id === id,
    `status=${me.status} id=${me.json && me.json.user && me.json.user.id}`);

  const title = `Signup monitor ${TAG}`;
  const created = await req('POST', '/api/tasks', { title }, token);
  const createdOk = created.status >= 200 && created.status < 300 && created.json && created.json.success !== false;
  record('can create a task', createdOk, `status=${created.status}`);

  const list = await req('GET', '/api/tasks', null, token);
  const tasks = (list.json && list.json.tasks) || [];
  record('task is saved and comes back', list.status === 200 && tasks.some(t => t.title === title),
    `status=${list.status} tasks=${tasks.length}`);
}

main()
  .catch(err => record('check ran without crashing', false, err.message))
  .finally(() => {
    const failed = results.filter(r => !r.ok);
    console.log(`[signup-check] ${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length || !results.length ? 1 : 0);
  });
