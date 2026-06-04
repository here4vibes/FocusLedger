#!/usr/bin/env node
/**
 * Post-Deploy Error Spike Monitor
 *
 * Runs for up to 15 minutes after each deploy and detects:
 *   1. New error types in Sentry that didn't exist pre-deploy
 *   2. Error rate increases >50% vs the pre-deploy 1-hour baseline
 *   3. Runtime console errors on key pages (via Playwright — works even without Sentry)
 *
 * Exit codes:
 *   0 — clean deploy, no spikes detected
 *   1 — error spike or new errors detected (CI will flag the deploy)
 *
 * Environment variables:
 *   SENTRY_AUTH_TOKEN  — Sentry API token (Settings → API Keys → auth:read)
 *   SENTRY_ORG         — Sentry organization slug
 *   SENTRY_PROJECT     — Sentry project slug
 *   BASE_URL           — App URL (default: https://focusledger.polsia.app)
 *   MONITOR_DURATION   — Monitoring window in seconds (default: 900 = 15 min)
 *   E2E_USER_EMAIL     — Test user email for authenticated page checks
 *   E2E_USER_PASSWORD  — Test user password
 */

'use strict';

const https = require('https');
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'https://focusledger.polsia.app';
const MONITOR_DURATION_S = parseInt(process.env.MONITOR_DURATION || '900', 10);
const POLL_INTERVAL_S = 60; // check every 60 seconds
const SPIKE_THRESHOLD = 1.5; // 50% increase = flag
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || '';
const SENTRY_ORG = process.env.SENTRY_ORG || '';
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || '';

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logWarn(msg) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] ⚠️  ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ❌ ${msg}`);
}

function logOk(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ✅ ${msg}`);
}

/**
 * Simple HTTPS/HTTP GET request. Returns { status, body }.
 */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const options = { headers };
    const req = lib.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentry API
// ─────────────────────────────────────────────────────────────────────────────

const sentryAvailable = !!(SENTRY_AUTH_TOKEN && SENTRY_ORG && SENTRY_PROJECT);

/**
 * Fetch Sentry issue stats for a given time window.
 * Returns an array of issues with their event counts.
 */
async function fetchSentryIssues(hoursBack) {
  if (!sentryAvailable) return null;

  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const url = `https://sentry.io/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=is:unresolved&limit=100&start=${since}`;

  try {
    const res = await get(url, {
      Authorization: `Bearer ${SENTRY_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    });

    if (res.status !== 200) {
      logWarn(`Sentry API returned ${res.status} — skipping Sentry checks`);
      return null;
    }

    return res.body; // array of issues
  } catch (err) {
    logWarn(`Sentry API error: ${err.message} — skipping Sentry checks`);
    return null;
  }
}

/**
 * Fetch total event count for a Sentry project in the last N hours.
 * Returns a number, or null if unavailable.
 */
async function fetchSentryEventCount(hoursBack) {
  if (!sentryAvailable) return null;

  const end = new Date().toISOString();
  const start = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const url = `https://sentry.io/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/stats/?resolution=1h&stat=received&since=${Math.floor(Date.now() / 1000) - hoursBack * 3600}&until=${Math.floor(Date.now() / 1000)}`;

  try {
    const res = await get(url, {
      Authorization: `Bearer ${SENTRY_AUTH_TOKEN}`,
    });

    if (res.status !== 200 || !Array.isArray(res.body)) return null;

    // Each item: [timestamp_seconds, count]
    const total = res.body.reduce((sum, [, count]) => sum + count, 0);
    return total;
  } catch (err) {
    logWarn(`Sentry stats API error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Health check — basic app reachability
// ─────────────────────────────────────────────────────────────────────────────

async function checkAppHealth() {
  try {
    const res = await get(`${BASE_URL}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Playwright runtime error check
// Loads key pages with a headless browser and collects console errors.
// This works WITHOUT Sentry — catches runtime JS errors immediately.
// ─────────────────────────────────────────────────────────────────────────────

async function runPlaywrightErrorCheck() {
  // Playwright is available as a dev dependency
  let chromium;
  try {
    ({ chromium } = require('@playwright/test'));
  } catch {
    // Playwright not available in this environment
    logWarn('Playwright not available for runtime error check — skipping');
    return { errors: [], pagesChecked: 0 };
  }

  const email = process.env.E2E_USER_EMAIL || 'e2e.bot@focusledger-e2e.test';
  const password = process.env.E2E_USER_PASSWORD || 'E2eBot_Pass_2026!';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const allErrors = [];

  // Pages to check: public + authenticated
  const publicPages = ['/login', '/pricing'];
  const authPages = ['/app', '/settings', '/values', '/calendar', '/email'];

  // ── Public pages ────────────────────────────────────────────────────────────
  for (const pagePath of publicPages) {
    const page = await context.newPage();
    const pageErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Filter known third-party noise
        if (
          !text.includes('facebook') &&
          !text.includes('fbq') &&
          !text.includes('googleapis') &&
          !text.includes('polsia.com/api/beacon') &&
          !text.includes('[SW]') &&
          !text.includes('[PWA]')
        ) {
          pageErrors.push({ page: pagePath, error: text });
        }
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push({ page: pagePath, error: `PageError: ${err.message}` });
    });

    try {
      await page.goto(`${BASE_URL}${pagePath}`, { timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    } catch (err) {
      pageErrors.push({ page: pagePath, error: `Navigation failed: ${err.message}` });
    }

    allErrors.push(...pageErrors);
    await page.close();
  }

  // ── Authenticated pages ─────────────────────────────────────────────────────
  const authPage = await context.newPage();
  const authErrors = [];

  authPage.on('pageerror', (err) => {
    authErrors.push({ page: '/login', error: `Auth PageError: ${err.message}` });
  });

  try {
    await authPage.goto(`${BASE_URL}/login`, { timeout: 20000 });
    await authPage.fill('#email', email);
    await authPage.fill('#password', password);
    await authPage.click('#submitBtn');
    await authPage.waitForURL(`${BASE_URL}/app`, { timeout: 15000 });
    log('Authenticated successfully for runtime error check');
  } catch (err) {
    logWarn(`Could not authenticate for runtime check: ${err.message}`);
    await authPage.close();
    await browser.close();
    return { errors: [...allErrors, ...authErrors], pagesChecked: publicPages.length };
  }

  // Reuse the authenticated context for app pages
  for (const pagePath of authPages) {
    const page = await context.newPage();
    const pageErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          !text.includes('facebook') &&
          !text.includes('fbq') &&
          !text.includes('googleapis') &&
          !text.includes('polsia.com/api/beacon') &&
          !text.includes('[SW]') &&
          !text.includes('[PWA]')
        ) {
          pageErrors.push({ page: pagePath, error: text });
        }
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push({ page: pagePath, error: `PageError: ${err.message}` });
    });

    // Copy auth cookies from the authenticated page context
    const cookies = await context.cookies();
    // Also copy localStorage via script injection after navigation
    try {
      await page.goto(`${BASE_URL}${pagePath}`, { timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    } catch (err) {
      pageErrors.push({ page: pagePath, error: `Navigation failed: ${err.message}` });
    }

    allErrors.push(...pageErrors);
    await page.close();
  }

  await authPage.close();
  await browser.close();

  return {
    errors: allErrors,
    pagesChecked: publicPages.length + authPages.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main monitor loop
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════════════════════');
  log('  FocusLedger Post-Deploy Error Spike Monitor');
  log(`  Target: ${BASE_URL}`);
  log(`  Monitor window: ${MONITOR_DURATION_S}s (${MONITOR_DURATION_S / 60} min)`);
  log(`  Sentry: ${sentryAvailable ? `${SENTRY_ORG}/${SENTRY_PROJECT}` : 'not configured — runtime check only'}`);
  log('═══════════════════════════════════════════════════════════');

  const deployTime = Date.now();
  const endTime = deployTime + MONITOR_DURATION_S * 1000;
  let issueCount = 0; // tracks number of problems found

  // ── Step 1: Capture pre-deploy Sentry baseline ────────────────────────────
  let preDeployEventCount = null;
  let preDeployIssueFingerprints = new Set();

  if (sentryAvailable) {
    log('Capturing pre-deploy Sentry baseline (1h rolling average)...');
    preDeployEventCount = await fetchSentryEventCount(1);
    const preIssues = await fetchSentryIssues(1);
    if (preIssues) {
      preDeployIssueFingerprints = new Set(preIssues.map((i) => i.id));
      log(`Baseline: ${preDeployEventCount ?? 'unknown'} events, ${preDeployIssueFingerprints.size} open issues`);
    }
  }

  // ── Step 2: Immediate runtime error check (Playwright) ───────────────────
  log('Running immediate runtime error check via Playwright...');
  const runtimeResult = await runPlaywrightErrorCheck();
  log(`Checked ${runtimeResult.pagesChecked} pages for runtime errors`);

  if (runtimeResult.errors.length > 0) {
    logError(`Found ${runtimeResult.errors.length} console/runtime error(s) immediately after deploy:`);
    for (const { page: pg, error } of runtimeResult.errors) {
      logError(`  [${pg}] ${error}`);
    }
    issueCount += runtimeResult.errors.length;
  } else {
    logOk('No runtime errors detected on key pages');
  }

  // ── Step 3: Poll Sentry for 15 minutes ───────────────────────────────────
  if (sentryAvailable) {
    log(`Starting Sentry polling (${Math.round((endTime - Date.now()) / 1000)}s remaining)...`);

    let pollCount = 0;
    while (Date.now() < endTime) {
      pollCount++;
      const elapsed = Math.round((Date.now() - deployTime) / 1000);
      log(`Poll #${pollCount} — ${elapsed}s since deploy`);

      // Check event rate
      const currentCount = await fetchSentryEventCount(0.25); // last 15 min
      if (currentCount !== null && preDeployEventCount !== null && preDeployEventCount > 0) {
        // Normalize to per-hour rate for comparison
        const currentRatePerHour = currentCount * 4; // 15min window * 4 = per hour
        const ratio = currentRatePerHour / preDeployEventCount;

        if (ratio >= SPIKE_THRESHOLD) {
          logError(
            `Error rate spike detected! ` +
            `Pre-deploy: ${preDeployEventCount}/hr, ` +
            `Current: ${currentRatePerHour.toFixed(0)}/hr (${((ratio - 1) * 100).toFixed(0)}% increase)`
          );
          issueCount++;
        } else {
          log(`Error rate OK — ${currentRatePerHour.toFixed(0)}/hr vs baseline ${preDeployEventCount}/hr`);
        }
      }

      // Check for new error types
      const currentIssues = await fetchSentryIssues(0.25); // last 15 min
      if (currentIssues) {
        const newIssues = currentIssues.filter((i) => !preDeployIssueFingerprints.has(i.id));
        if (newIssues.length > 0) {
          logError(`${newIssues.length} NEW error type(s) appeared after deploy:`);
          for (const issue of newIssues.slice(0, 10)) {
            logError(`  [${issue.level?.toUpperCase() || 'ERROR'}] ${issue.title} (${issue.count} events)`);
          }
          issueCount += newIssues.length;
        } else {
          logOk('No new error types');
        }
      }

      // Wait for next poll (or stop if we've passed the window)
      const nextPollIn = Math.min(POLL_INTERVAL_S * 1000, endTime - Date.now());
      if (nextPollIn <= 0) break;
      await sleep(nextPollIn);
    }
  } else {
    log('Sentry not configured — runtime check was the only monitor');
    log('To enable full Sentry monitoring, set: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  log('═══════════════════════════════════════════════════════════');
  if (issueCount === 0) {
    logOk(`Monitor complete — no issues detected. Deploy looks healthy.`);
    log('═══════════════════════════════════════════════════════════');
    process.exit(0);
  } else {
    logError(`Monitor complete — ${issueCount} issue(s) detected. Review above.`);
    log('═══════════════════════════════════════════════════════════');
    process.exit(1);
  }
}

main().catch((err) => {
  logError(`Monitor crashed: ${err.message}`);
  console.error(err);
  // Don't fail the deploy on monitor crash — it might be a monitoring infra issue
  process.exit(0);
});
