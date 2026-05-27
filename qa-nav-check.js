/**
 * qa-nav-check.js — QA shared-nav on all target pages.
 * Uses Playwright with local Chromium (not CDP) to navigate to the deployed app.
 * Screenshots saved to ./tmp/nav-qa/
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://focusledger.polsia.app';

const PAGES = [
  '/app', '/money', '/buddy', '/settings', '/journal', '/checkin',
  '/home', '/life', '/vault', '/calendar',
];

const OUTDIR = './tmp/nav-qa';
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

async function screenshot(page, name) {
  const file = path.join(OUTDIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  Screenshot: ${file}`);
  return file;
}

async function checkPage(page, url, viewportLabel, width, height) {
  const name = `${url.replace(/\//g, '-')}_${viewportLabel}`;
  console.log(`\n[${viewportLabel} ${width}px] ${url}`);

  try {
    await page.setViewportSize({ width, height });
    await page.goto(BASE_URL + url, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(500); // let animations settle

    const info = await page.evaluate(() => {
      const nav = document.getElementById('shared-bottom-nav');
      const hamburger = document.getElementById('shared-hamburger-btn');
      const activeItems = document.querySelectorAll('.shared-nav-item.active');
      const body = document.body;
      const bodyStyle = window.getComputedStyle(body);
      const navRect = nav ? nav.getBoundingClientRect() : null;

      return {
        url: window.location.href,
        title: document.title.substring(0, 80),
        hasNav: !!nav,
        navDisplay: nav ? window.getComputedStyle(nav).display : null,
        navPosition: nav ? window.getComputedStyle(nav).position : null,
        navBottom: navRect ? navRect.bottom : null,
        hasHamburger: !!hamburger,
        hamburgerDisplay: hamburger ? window.getComputedStyle(hamburger).display : null,
        activeItemCount: activeItems.length,
        bodyPaddingBottom: bodyStyle.paddingBottom,
        bodyPaddingLeft: bodyStyle.paddingLeft,
        bodyClassList: body.className,
        windowInnerHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        visibleAtBottom: navRect ? (navRect.top < window.innerHeight) : null,
      };
    });

    console.log(`  URL: ${info.url}`);
    console.log(`  Title: ${info.title}`);
    console.log(`  Nav: ${info.hasNav} (display=${info.navDisplay}, pos=${info.navPosition})`);
    console.log(`  Nav bottom edge: ${info.navBottom}px`);
    console.log(`  Window inner height: ${info.windowInnerHeight}px`);
    console.log(`  Doc height: ${info.documentHeight}px`);
    console.log(`  Hamburger: ${info.hasHamburger} (display=${info.hamburgerDisplay})`);
    console.log(`  Active nav items: ${info.activeItemCount}`);
    console.log(`  Body padding-bottom: ${info.bodyPaddingBottom}`);
    console.log(`  Body padding-left: ${info.bodyPaddingLeft}`);
    console.log(`  Body classList: ${info.bodyClassList}`);

    await screenshot(page, name);

    // Check for common issues
    const issues = [];
    if (!info.hasNav) issues.push('MISSING: shared-bottom-nav not found');
    if (info.navDisplay === 'none') issues.push('ERROR: nav has display:none');
    if (!info.hasHamburger && width < 900) issues.push('WARNING: no hamburger on mobile');
    if (info.activeItemCount === 0) issues.push('WARNING: no active nav item');
    if (parseFloat(info.bodyPaddingBottom) === 0 && width < 900) issues.push('ERROR: no bottom padding on mobile body');
    if (navRect && navRect.bottom > window.innerHeight) issues.push('ERROR: nav clips beyond viewport');

    if (issues.length > 0) {
      console.log('  ISSUES:');
      issues.forEach(i => console.log(`    - ${i}`));
    } else {
      console.log('  Status: ✅ OK');
    }

    return { url, viewport: width, info, issues, screenshot: `${name}.png` };

  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    await screenshot(page, name + '_ERROR');
    return { url, viewport: width, error: err.message };
  }
}

async function main() {
  console.log('Launching local Chromium...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [];

  // Mobile QA
  console.log('\n=== MOBILE QA (375×812) ===');
  for (const url of PAGES) {
    const result = await checkPage(page, url, 'mobile', 375, 812);
    results.push(result);
  }

  // Desktop QA
  console.log('\n=== DESKTOP QA (900×600) ===');
  for (const url of PAGES) {
    const result = await checkPage(page, url, 'desktop', 900, 600);
    results.push(result);
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    const hasIssues = r.issues && r.issues.length > 0;
    const status = r.error ? '❌ ERROR' : hasIssues ? '⚠️ ISSUES' : '✅ OK';
    console.log(`${status} [${r.viewport}px] ${r.url}`);
    if (r.error) console.log(`  → ${r.error}`);
    if (r.issues) r.issues.forEach(i => console.log(`  → ${i}`));
  }

  const errors = results.filter(r => r.error);
  const withIssues = results.filter(r => !r.error && r.issues && r.issues.length > 0);
  const ok = results.filter(r => !r.error && (!r.issues || r.issues.length === 0));

  console.log(`\nTotal: ${results.length} | ✅ OK: ${ok.length} | ⚠️ Issues: ${withIssues.length} | ❌ Errors: ${errors.length}`);

  await browser.close();
  console.log('\nDone. Screenshots saved to ./tmp/nav-qa/');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});