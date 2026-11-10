// @ts-check
/**
 * Playwright config for browser tests against a LOCAL server (not prod).
 * Start one first, e.g.:
 *   PORT=3995 JWT_SECRET=x SESSION_SECRET=x DATABASE_URL=... node server.js
 * then: LOCAL_BASE_URL=http://127.0.0.1:3995 npm run test:local
 * (PW_CHROMIUM_PATH points at a preinstalled Chromium when there is one.)
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/local',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: [['list']],
  use: {
    baseURL: process.env.LOCAL_BASE_URL || 'http://127.0.0.1:3995',
    // Our own automation: analytics drops it (lib/analytics-filter.js).
    extraHTTPHeaders: { 'X-FL-Automation': 'local-e2e' },
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
