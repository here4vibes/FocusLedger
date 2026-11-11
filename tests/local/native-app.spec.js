// @ts-check
/**
 * Inside the iOS app (App Store guideline 3.1.1) nothing sells a plan: no
 * price, no checkout or upgrade button, no link to pricing, and the Meta Pixel
 * never loads. Checked at phone width (375px) on Settings, /pricing and Home,
 * two ways: the user-agent token the shell appends, and a stubbed Capacitor
 * bridge with a plain Safari user agent. A browser still gets the upgrade UI.
 *
 * Run against a local server: see playwright.local.config.js.
 */
const { test, expect } = require('@playwright/test');

const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const APP_UA = SAFARI_UA.replace(' Version/18.0', '').replace(' Safari/604.1', '') + ' FocusLedgerApp/1.0';

// Anything that prices or sells a plan: "$x/mo", "$x/year", or one of our
// price points. (Spending examples such as "$47 at Target" are not offers.)
const PRICE_RE = /\$\s?\d+(\.\d{2})?\s*(\/|per)\s*(mo|yr|month|year)|\b(8\.33|9\.95|14\.95|99\.95|149\.95)\b/i;
const CTA_RE = /upgrade|switch to autopilot|unlock (with|tandem)|subscribe|see autopilot|billed (monthly|annually)/i;

let token;
let user;

test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/auth/signup', {
    data: { email: `native-app-${Date.now()}@example.com`, password: 'N4tiveApp!pw', name: 'Native App', timezone: 'America/New_York' },
  });
  expect(r.ok(), `signup failed: ${r.status()}`).toBeTruthy();
  const body = await r.json();
  token = body.token;
  user = body.user || {};
});

/** A signed-in page in one of: 'ua' (app user agent), 'capacitor' (stubbed bridge), 'browser'. */
async function openContext(browser, mode) {
  const context = await browser.newContext({
    userAgent: mode === 'ua' ? APP_UA : SAFARI_UA,
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders: { 'X-FL-Automation': 'local-e2e' },
  });
  await context.addInitScript(([t, u, stubCapacitor]) => {
    localStorage.setItem('fl_token', t);
    localStorage.setItem('fl_user', JSON.stringify(u));
    if (stubCapacitor) {
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} };
    }
  }, [token, user, mode === 'capacitor']);
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  return { context, page, requests };
}

/** Text a user can actually see (hidden elements excluded). */
async function visibleText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function expectNothingForSale(page, requests) {
  const text = await visibleText(page);
  // Report the offending lines, not the whole page.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  expect(lines.filter((l) => PRICE_RE.test(l)), 'visible prices').toEqual([]);
  expect(lines.filter((l) => CTA_RE.test(l)), 'visible upgrade or checkout CTAs').toEqual([]);
  const links = await page.$$eval('a[href]', (as) => as
    .filter((a) => a.offsetParent !== null)
    .map((a) => a.getAttribute('href'))
    .filter((h) => /^\/pricing|stripe\.com/.test(h || '')));
  expect(links, 'visible links to pricing or Stripe').toEqual([]);
  expect(requests.filter((u) => /facebook\.(net|com)/.test(u)), 'Meta Pixel requests').toEqual([]);
}

for (const mode of ['ua', 'capacitor']) {
  test.describe(`iOS app detected by ${mode === 'ua' ? 'user agent' : 'the Capacitor bridge'}`, () => {
    test('Settings shows the plan, with nothing to buy', async ({ browser }) => {
      const { context, page, requests } = await openContext(browser, mode);
      await page.goto('/app/settings');
      await expect(page.locator('#subContent')).toBeVisible();
      await expect(page.locator('#subContent .plan-badge')).toHaveText('FREE');
      await expect(page.locator('#nativePlanNote')).toHaveText('You’re on the Free plan.');
      await expect(page.locator('#subContent .btn-upgrade')).toHaveCount(0);
      await expect(page.locator('#promoSection')).toBeHidden();
      // Let the Tandem and bank sections finish rendering before reading the page.
      await page.waitForLoadState('networkidle');
      // The upgrade modal cannot be opened, even by code that still calls it.
      await page.evaluate(() => window.openUpgradeModal());
      await expect(page.locator('#upgradeModal')).toBeHidden();
      await expectNothingForSale(page, requests);
      await context.close();
    });

    test('/pricing is not part of the app: it lands on the login page', async ({ browser }) => {
      const { context, page, requests } = await openContext(browser, mode);
      await context.addInitScript(() => localStorage.removeItem('fl_token')); // signed out, so /login stays put
      await page.goto('/pricing');
      await page.waitForURL(/\/login$/);
      await page.waitForLoadState('networkidle');
      await expectNothingForSale(page, requests);
      await context.close();
    });

    test('Home (/weightless) has nothing to buy', async ({ browser }) => {
      const { context, page, requests } = await openContext(browser, mode);
      await page.goto('/weightless');
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(/\/weightless/);
      await expectNothingForSale(page, requests);
      await context.close();
    });

    test('the other app and sign-in pages have nothing to buy either', async ({ browser }) => {
      const { context, page, requests } = await openContext(browser, mode);
      const pages = ['/app/tasks', '/app/money', '/app/money/bills', '/transactions', '/app/life', '/routines',
        '/email', '/story', '/science', '/contact', '/login', '/signup'];
      for (const path of pages) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await test.step(path, () => expectNothingForSale(page, requests));
      }
      // The Pro gate (bank sync, email, documents…) states the fact and offers nothing.
      await page.goto('/app/money');
      await page.addScriptTag({ url: '/js/pro-gate.js' });
      await page.evaluate(() => window.FLProGate.show({ feature: 'Bank Sync', description: 'Connect your bank.' }));
      await expect(page.locator('#flPgTitle')).toHaveText('Bank Sync isn’t included in your current plan');
      await expect(page.locator('#flPgCta')).toHaveCount(0);
      await expectNothingForSale(page, requests);
      await context.close();
    });

    test('checkout cannot start from the page', async ({ browser }) => {
      const { context, page } = await openContext(browser, mode);
      await page.goto('/app/settings');
      await expect(page.locator('#subContent')).toBeVisible();
      await page.evaluate(() => window.PricingService.checkout('autopilot', 'monthly'));
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/\/app\/settings/);
      if (mode === 'ua') {
        // Defense in depth: the server refuses too.
        const status = await page.evaluate(async (t) => {
          const r = await fetch('/api/subscription/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
            body: JSON.stringify({ plan: 'autopilot', billing: 'monthly' }),
          });
          return { status: r.status, body: await r.json() };
        }, token);
        expect(status.status).toBe(403);
        expect(status.body.code).toBe('NATIVE_APP_PURCHASE_UNAVAILABLE');
      }
      await context.close();
    });
  });
}

test('a browser still gets the upgrade button, the pricing page and the Pixel snippet', async ({ browser }) => {
  const { context, page } = await openContext(browser, 'browser');
  await page.goto('/app/settings');
  await expect(page.locator('#subContent .btn-upgrade')).toBeVisible();
  await expect(page.locator('#promoSection')).toBeVisible();
  await page.goto('/pricing');
  await expect(page).toHaveURL(/\/pricing$/);
  expect(await visibleText(page)).toMatch(PRICE_RE);
  expect(await page.evaluate(() => typeof window.fbq === 'function' && window.fbq.version)).toBe('2.0');
  await context.close();
});
