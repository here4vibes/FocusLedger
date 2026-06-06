// @ts-check
/**
 * Playwright config for CSS/layout smoke tests.
 * No auth required — targets public (unauthenticated) pages only.
 *
 * Run:           npx playwright test --config=playwright.smoke.config.js
 * Against local: BASE_URL=http://localhost:3000 npx playwright test --config=playwright.smoke.config.js
 */
const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://focusledger.polsia.app';

module.exports = defineConfig({
  testDir: './tests/smoke',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 20000,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'smoke-report' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'smoke-report' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
