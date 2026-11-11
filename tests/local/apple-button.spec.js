// @ts-check
/**
 * The Sign in with Apple button on /login and /signup at phone width.
 * Shown only when the server has Apple configured (GET /api/auth/apple/config);
 * when it is, it sits above the Google button, at least as large, and a tap
 * navigates to /api/auth/apple/start. Also: the ?apple_token= return signs in.
 *
 * Runs in either server mode; start the server with APPLE_CLIENT_ID,
 * APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (any values) to cover the
 * configured branch.
 */
const { test, expect } = require('@playwright/test');

let enabled;

test.beforeAll(async ({ request }) => {
  const r = await request.get('/api/auth/apple/config');
  expect(r.ok()).toBeTruthy();
  enabled = (await r.json()).enabled;
});

for (const [path, label] of [['/login', 'Sign in with Apple'], ['/signup', 'Sign up with Apple']]) {
  test(`${path}: Apple button matches the server's configuration`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const apple = page.locator('#appleBtn');
    if (!enabled) {
      await expect(apple).toHaveCount(0);
      return;
    }
    await expect(apple).toBeVisible();
    await expect(apple).toHaveText(label);
    const a = await apple.boundingBox();
    const g = await page.locator('#googleBtn').boundingBox();
    expect(a.y).toBeLessThan(g.y);                       // first
    expect(a.width).toBeGreaterThanOrEqual(g.width - 1);  // no smaller than Google's
    expect(a.height).toBeGreaterThanOrEqual(44);
    expect(a.x + a.width).toBeLessThanOrEqual(375);       // no overflow at 375px

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/auth/apple/start')),
      apple.click(),
    ]);
    expect(new URL(req.url()).searchParams.get('return_to')).toBe(path.slice(1));
  });
}

test('returning from Apple with ?apple_token= signs the browser in', async ({ page, request }) => {
  const r = await request.post('/api/auth/signup', {
    data: { email: `apple-return-${Date.now()}@example.com`, password: 'AppleRet!pw1', name: 'Apple Return', timezone: 'America/New_York' },
  });
  expect(r.ok(), `signup failed: ${r.status()}`).toBeTruthy();
  const { token } = await r.json();
  await page.goto(`/login?apple_token=${encodeURIComponent(token)}&apple_email=a%40example.com`);
  await expect(page.locator('#errorMsg')).toHaveText('Signed in with Apple! Redirecting...');
  expect(await page.evaluate(() => localStorage.getItem('fl_token'))).toBe(token);
  expect(page.url()).not.toContain('apple_token');
});

test('an ?apple_error= shows Apple wording, not Google’s', async ({ page }) => {
  await page.goto('/login?apple_error=verification_failed');
  await expect(page.locator('#errorMsg')).toHaveText('We couldn’t verify your Apple sign-in. Please try again.');
});
