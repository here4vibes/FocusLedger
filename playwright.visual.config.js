// @ts-check
/**
 * Playwright configuration for visual regression screenshot testing.
 *
 * Captures screenshots at mobile (375px) and desktop (1280px) viewports
 * for all key pages and compares against stored baselines.
 *
 * Threshold: 0.5% pixel difference allowed (flags layout drift, z-index issues,
 * missing elements, off-screen renders — the "dead button" pattern).
 *
 * Run locally:        npx playwright test --config=playwright.visual.config.js
 * Update baselines:   npx playwright test --config=playwright.visual.config.js --update-snapshots
 */

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://focusledger.polsia.app';

module.exports = defineConfig({
  testDir: './tests/visual',
  globalSetup: require.resolve('./tests/e2e/global-setup.js'),

  // Visual tests run sequentially to avoid race conditions on screenshot writes
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0, // no retries — we want exact comparisons
  workers: 1,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'visual-report' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'visual-report' }]],

  timeout: 45000,

  // Screenshot comparison settings
  expect: {
    // 0.5% pixel difference threshold across the full page
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      // Anti-aliasing tolerance
      threshold: 0.2,
      animations: 'disabled',
    },
  },

  use: {
    baseURL: BASE_URL,
    // Load auth state so authenticated pages render correctly
    storageState: path.resolve('./tests/e2e/.auth/user.json'),
    trace: 'off',
    screenshot: 'off', // managed by the tests explicitly
    // Disable animations so screenshots are deterministic
    reducedMotion: 'reduce',
  },

  projects: [
    // ── Phase 0: Auth setup (same as e2e — reuse the same auth file) ──────────
    {
      name: 'visual-setup',
      testDir: './tests/e2e',
      testMatch: /auth\.setup\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: undefined,
      },
    },

    // ── Mobile: 375px viewport (iPhone SE / smallest common mobile) ───────────
    {
      name: 'visual-mobile',
      testDir: './tests/visual',
      dependencies: ['visual-setup'],
      use: {
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        storageState: path.resolve('./tests/e2e/.auth/user.json'),
      },
    },

    // ── Desktop: 1280px viewport ──────────────────────────────────────────────
    {
      name: 'visual-desktop',
      testDir: './tests/visual',
      dependencies: ['visual-setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        storageState: path.resolve('./tests/e2e/.auth/user.json'),
      },
    },
  ],

  // Baseline snapshots stored in the repo alongside the tests
  snapshotDir: './tests/visual/snapshots',
  snapshotPathTemplate:
    '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}',
});
