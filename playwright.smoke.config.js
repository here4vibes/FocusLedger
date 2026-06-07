// @ts-check
/**
 * Playwright config for CSS/layout smoke tests.
 * No auth required — targets public (unauthenticated) pages only.
 *
 * Runs against both production URLs:
 *   - https://focusledger.net       (custom domain)
 *   - https://focusledger-mwn3.onrender.com  (Render native URL / staging)
 *
 * Override either with env vars:
 *   PRIMARY_URL=https://focusledger.net
 *   RENDER_URL=https://focusledger-mwn3.onrender.com
 *
 * Run locally:  npx playwright test --config=playwright.smoke.config.js
 */
const { defineConfig, devices } = require('@playwright/test');

const PRIMARY_URL = process.env.PRIMARY_URL || 'https://focusledger.net';
const RENDER_URL  = process.env.RENDER_URL  || 'https://focusledger-mwn3.onrender.com';

module.exports = defineConfig({
  testDir: './tests/smoke',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  timeout: 20000,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'smoke-report' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'smoke-report' }]],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // ── focusledger.net ───────────────────────────────────────────────────────
    {
      name: 'primary-mobile',
      // WHY: iPhone 13 device defaults to WebKit which is not installed in CI.
      // Chromium with mobile viewport gives equivalent layout coverage.
      use: { ...devices['iPhone 13'], browserName: 'chromium', baseURL: PRIMARY_URL },
    },
    {
      name: 'primary-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: PRIMARY_URL },
    },

    // ── focusledger-mwn3.onrender.com ─────────────────────────────────────────
    {
      name: 'render-mobile',
      // WHY: same as primary-mobile — Chromium instead of WebKit for CI compatibility.
      use: { ...devices['iPhone 13'], browserName: 'chromium', baseURL: RENDER_URL },
    },
    {
      name: 'render-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: RENDER_URL },
    },
  ],
});
