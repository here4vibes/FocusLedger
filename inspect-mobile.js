const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('wss://connect.anchorbrowser.io/?sessionId=718e1c65-f92b-4495-8b14-db4a0c5d9cda');
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();

  await page.goto('https://focusledger.net/login');
  await page.waitForLoadState('networkidle');

  const viewportMeta = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    return meta ? meta.content : 'MISSING';
  });
  console.log('VIEWPORT_META:', viewportMeta);

  const bodyOverflow = await page.evaluate(() => {
    const style = window.getComputedStyle(document.body);
    return { overflowX: style.overflowX, overflowY: style.overflowY };
  });
  console.log('BODY_OVERFLOW:', JSON.stringify(bodyOverflow));

  const navActive = await page.evaluate(() => document.body.classList.contains('shared-nav-active'));
  console.log('SHARED_NAV_ACTIVE:', navActive);

  const navShell = await page.evaluate(() => document.body.getAttribute('data-nav-shell'));
  console.log('DATA_NAV_SHELL:', navShell);

  const bodyChildren = await page.evaluate(() => {
    const kids = [];
    for (const child of document.body.children) {
      kids.push({ tag: child.tagName, id: child.id, cls: child.className.substring(0, 60) });
    }
    return kids;
  });
  console.log('BODY_CHILDREN:', JSON.stringify(bodyChildren));

  const overflowAnalysis = await page.evaluate(() => {
    const issues = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width > window.innerWidth && style.overflowX !== 'hidden' && style.overflowX !== 'clip') {
        issues.push({
          tag: el.tagName,
          id: el.id,
          cls: el.className.substring(0, 50),
          width: Math.round(rect.width),
          vw: window.innerWidth,
          ox: style.overflowX
        });
        if (issues.length > 15) break;
      }
    }
    return issues;
  });
  console.log('OVERFLOW_ISSUES:', JSON.stringify(overflowAnalysis));

  const fixedWide = await page.evaluate(() => {
    const issues = [];
    for (const el of document.querySelectorAll('*')) {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed') {
        const rect = el.getBoundingClientRect();
        if (rect.width > window.innerWidth) {
          issues.push({ tag: el.tagName, id: el.id, cls: el.className.substring(0, 50), w: Math.round(rect.width), vw: window.innerWidth });
        }
      }
    }
    return issues;
  });
  console.log('FIXED_WIDE:', JSON.stringify(fixedWide));

  await page.screenshot({ path: 'mobile-375.png' });
  console.log('SCREENSHOT: mobile-375.png');

  await browser.disconnect();
  console.log('DONE');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });