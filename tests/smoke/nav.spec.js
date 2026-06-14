// @ts-check
/**
 * Nav color smoke tests — no auth required.
 *
 * Guards against CSS regressions where design-system.css rules bleed onto
 * the public nav (#fl-public-nav) and override its cream background.
 *
 * Run:  npx playwright test --config=playwright.smoke.config.js
 */
const { test, expect } = require('@playwright/test');

const NAVY_RGB  = 'rgb(1, 30, 92)';   // --brand-primary
const CREAM_RGB = 'rgb(250, 248, 244)'; // #fl-public-nav background (opaque equivalent)

const PUBLIC_PAGES = ['/', '/pricing', '/adhd-tax', '/science'];

for (const path of PUBLIC_PAGES) {
  test(`public nav is cream on ${path}`, async ({ page }) => {
    await page.goto(path);
    // WHY 35s: nav is JS-injected; Render cold starts can take ~30s
    await page.waitForSelector('#fl-public-nav', { timeout: 35000 });

    const bg = await page.locator('#fl-public-nav').evaluate(
      el => getComputedStyle(el).backgroundColor
    );

    // Must NOT be navy
    expect(bg, `#fl-public-nav background on ${path} should be cream, got ${bg}`).not.toBe(NAVY_RGB);

    // Must be a light/warm color (r > 200 is a reliable cream/white signal)
    const r = parseInt(bg.match(/\d+/)?.[0] ?? '0', 10);
    expect(r, `#fl-public-nav on ${path} should have red channel > 200 (cream), got r=${r}`).toBeGreaterThan(200);
  });
}

test('landing-old nav is navy (#fl-landing-nav)', async ({ page }) => {
  await page.goto('/landing-old');

  const nav = page.locator('#fl-landing-nav');
  const exists = await nav.count();
  if (!exists) {
    // Page may redirect or be gated — skip rather than fail
    test.skip();
    return;
  }

  const bg = await nav.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(NAVY_RGB);
});
