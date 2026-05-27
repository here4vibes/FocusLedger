const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
  });
  const page = await context.newPage();

  // Log in first
  await page.goto('https://focusledger.polsia.app/');
  await page.waitForTimeout(1000);

  // Click Email tab to show email/password login
  const emailTab = page.locator('text=Email');
  if (await emailTab.isVisible()) {
    await emailTab.click();
    await page.waitForTimeout(500);
  }

  // Fill in credentials
  await page.fill('input[type="email"]', 'qa@focusledger.net');
  await page.fill('input[type="password"]', 'QA_Test_2026!FocusLedger');

  // Click Log In
  await page.click('button:has-text("Log In")');
  await page.waitForTimeout(3000);

  // Navigate to /app
  await page.goto('https://focusledger.polsia.app/app');
  await page.waitForTimeout(3000);

  // Take screenshot
  await page.screenshot({ path: '/tmp/focusledger-app-mobile.png', fullPage: false });
  console.log('Screenshot saved to /tmp/focusledger-app-mobile.png');

  // Also check the page content
  const bodyHTML = await page.evaluate(() => {
    const body = document.body;
    const main = document.querySelector('main') || document.querySelector('.dashboard');
    return {
      hasBody: !!body,
      bodyChildren: body ? body.children.length : 0,
      hasDashboard: !!document.querySelector('.dashboard'),
      hasTaskList: !!document.querySelector('.task-list'),
      taskListChildren: document.querySelector('.task-list')?.children.length || 0,
      bodyClasses: body?.className || '',
      computedStyles: window.getComputedStyle(document.querySelector('.dashboard') || body).display,
      viewportHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
  console.log('Page state:', JSON.stringify(bodyHTML, null, 2));

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});