// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://focusledger.net';

module.exports = defineConfig({
  testDir: './tests/e2e/tests',
  globalSetup: require.resolve('./tests/e2e/global-setup.js'),

  // Run in parallel — target <5min
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'playwright-results.json' }]]
    : [['list'], ['html', { open: 'on-failure' }]],

  // Per-test timeout — generous for prod network
  timeout: 45000,

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    // ── Phase 1: Create test user + login ────────────────────────────────────
    {
      name: 'setup',
      testDir: './tests/e2e',
      testMatch: /auth\.setup\.js/,
      use: {
        ...devices['iPhone 13'],
        storageState: undefined, // no auth state at setup time
      },
    },

    // ── Phase 2a: Mobile viewport (iPhone 13 — primary user surface) ─────────
    {
      name: 'mobile',
      testDir: './tests/e2e/tests',
      dependencies: ['setup'],
      use: {
        ...devices['iPhone 13'],
        storageState: path.resolve('./tests/e2e/.auth/user.json'),
      },
    },

    // ── Phase 2b: Desktop viewport ───────────────────────────────────────────
    {
      name: 'desktop',
      testDir: './tests/e2e/tests',
      dependencies: ['setup'],
      use: {
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        storageState: path.resolve('./tests/e2e/.auth/user.json'),
        isMobile: false,
        hasTouch: false,
      },
    },
  ],
});
