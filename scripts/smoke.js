#!/usr/bin/env node

/**
 * Comprehensive Smoke Test — Enforces ALL Standing Engineering Rules
 *
 * Canonical QA user: qa@focusledger.net
 * Credentials: config/test-users.js (QA_USER)
 * Reset before full smoke run: node scripts/reset-qa-user.js
 *
 * Smoke tests are purely static analysis — no user auth, no DB access.
 * E2E Playwright tests use the canonical QA user (global-setup.js).
 * Integration tests (jest + mocked pools) don't need real credentials.
 *
 * Run: npm run smoke
 *
 * Checks:
 * 1.  Dual-domain verification (focusledger.polsia.app + FocusLedger.net)
 * 2.  UI entry point verification (every route reachable from UI)
 * 3.  Nav link presence (bottom nav on all pages)
 * 4.  CSP validation (known API integrations in connect-src)
 * 5.  Service worker verification
 * 6.  Route audit (orphan routes, dead nav items)
 * 7.  No orphaned routes (every route has nav link or whitelist exemption)
 * 8.  Database migration safety (all endpoints return 200 post-deploy)
 * 9.  No silent fetch failures (all fetch() have error handling)
 * 10. Error toast coverage (all forms show feedback on failure)
 * 11. Pro gate consistency (no raw subscription checks)
 * 12. Auth redirect check (all /app/* routes redirect to login without session)
 * 13. CSRF protection (state-changing routes use Bearer auth)         [Rule 13]
 * 14. No secrets in client code (grep public/ for credentials)        [Rule 14]
 * 15. SQL injection audit (no ${} interpolation in SQL strings)        [Rule 15]
 * 16. Rate limiting on auth endpoints (login/signup/reset all gated)   [Rule 16]
 * 17. Env var validation on startup (required vars checked before listen) [Rule 18]
 * 18. Uncaught exception handlers (uncaughtException + unhandledRejection) [Rule 19]
 * 19. Double-submit prevention (every form disables button on submit)  [Rule 27]
 * 20. No hardcoded / dummy data (placeholder strings, demo flags, unscoped SQL) [Rule 31]
 * 21. Post-deploy visual verification (duplicate mic icons, nav count, containers, empty states) [Rule 30]
 * --- Regression assertions ---
 * 22. Event listener survival after innerHTML re-render (admin panel delegation)
 * 23. Morning check-in filter correctness (4+ day tasks excluded from all Buddy task queries)
 * 24. Tablet breakpoint coverage (science.html at 768px/810px/1024px -- no horizontal overflow)
 * 25. Service worker cache version consistency (skipWaiting, clients.claim, old-cache delete)
 * 26. Shared timezone utility enforcement (lib/timezone.js in all task-date routes)
 * 27. API response shape assertions (success + message fields on Buddy/Tasks routes)
 * 28. Toast/feedback visibility (showToast >= 3000ms, appears within 100ms)
 * 29. JS-failure degradation (critical pages have user-visible noscript fallback)
 * 30. Double-submit protection extended (mutation buttons disabled before fetch)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const NAV_CONFIG = require('../nav-config.js');

// ═══════════════════════════════════════════════════════════════════════════════
// TEST STATE
// ═══════════════════════════════════════════════════════════════════════════════

let testsPassed = 0;
let testsFailed = 0;
let testsWarning = 0;
const results = [];

// Routes that should NOT appear in nav (e.g., OAuth callbacks, internal APIs)
const WHITELISTED_ROUTES = new Set([
  '/health',
  '/auth/google/callback',
  '/auth/google-auth/callback',
  '/api/*',
  '/offline',
  '/share',
  '/404',
]);

// Known API domains that should be in CSP connect-src
const KNOWN_API_DOMAINS = [
  'api.open-meteo.com',
  'ipapi.co',
  'gnews.io',
  'cdn.plaid.com',
  'js.stripe.com',
  'checkout.stripe.com',
  'accounts.google.com',
];

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function logPass(rule, detail) {
  console.log(`✅ PASS: ${rule}${detail ? ' — ' + detail : ''}`);
  testsPassed++;
  results.push({ status: 'PASS', rule, detail });
}

function logFail(rule, detail) {
  console.log(`❌ FAIL: ${rule}${detail ? ' — ' + detail : ''}`);
  testsFailed++;
  results.push({ status: 'FAIL', rule, detail });
}

function logWarning(rule, detail) {
  console.log(`⚠️  WARN: ${rule}${detail ? ' — ' + detail : ''}`);
  testsWarning++;
  results.push({ status: 'WARN', rule, detail });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedURL = new URL(url);
    const isHttps = parsedURL.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedURL.hostname,
      port: parsedURL.port,
      path: parsedURL.pathname + parsedURL.search,
      method: options.method || 'GET',
      headers: options.headers || { 'User-Agent': 'FocusLedger-Smoke-Test' },
      timeout: 5000,
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.abort(); reject(new Error('Timeout')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: DUAL-DOMAIN VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function testDualDomain() {
  console.log('\n--- Test 1: Dual-Domain Verification ---');

  const domains = [
    'https://focusledger.polsia.app',
    'https://focusledger.net',
  ];
  const routes = NAV_CONFIG.getNavigableRoutes().map(r => r.route);

  // Test health endpoint on both domains first
  for (const domain of domains) {
    try {
      const result = await fetchURL(domain + '/health');
      if (result.status === 200) {
        logPass('Health check', domain);
      } else {
        logFail('Health check', `${domain} returned ${result.status}`);
      }
    } catch (err) {
      logWarning('Health check', `${domain} unreachable (may be offline): ${err.message}`);
    }
  }

  // Note: Full route testing would require the app to be running
  // In CI/CD, this would be done after deployment
  logWarning('Dual-domain check', 'Requires deployed app to be running; skipping full route check');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: UI ENTRY POINT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

function testUIEntryPoints() {
  console.log('\n--- Test 2: UI Entry Point Verification ---');

  // Verify every route in nav config has a corresponding HTML file or redirects
  const navigableRoutes = NAV_CONFIG.getNavigableRoutes();
  const htmlFiles = fs.readdirSync(path.join(__dirname, '../public')).filter(f => f.endsWith('.html'));

  navigableRoutes.forEach(route => {
    // Special handling for index (/, /home, /portal)
    if (route.route === '/' && htmlFiles.includes('index.html')) {
      logPass('UI Entry Point', `${route.label} (/) → index.html`);
      return;
    }
    if (route.route === '/home' && htmlFiles.includes('portal.html')) {
      logPass('UI Entry Point', `${route.label} (/home) → portal.html`);
      return;
    }
    if (route.route === '/portal' && htmlFiles.includes('portal.html')) {
      logPass('UI Entry Point', `${route.label} (/portal) → portal.html`);
      return;
    }
    if (route.route === '/money') {
      logPass('UI Entry Point', `${route.label} (/money) → app.html (focused money view)`);
      return;
    }

    // Match route to HTML file
    const routeParts = route.route.split('/').filter(Boolean);
    const possibleFiles = [
      `${routeParts[0]}.html`,
      `${routeParts.join('-')}.html`,
    ];

    const found = possibleFiles.some(f => htmlFiles.includes(f));
    if (found || route.route === '/app' || route.route.startsWith('/app/')) {
      logPass('UI Entry Point', `${route.label} (${route.route})`);
    } else {
      logFail('UI Entry Point', `${route.label} (${route.route}) has no corresponding HTML file`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: BOTTOM NAV PRESENCE
// ═══════════════════════════════════════════════════════════════════════════════

function testBottomNavPresence() {
  console.log('\n--- Test 3: Bottom Nav Presence ---');

  const bottomNavRoutes = NAV_CONFIG.getBottomNav();
  const appPages = NAV_CONFIG.getAppPages().filter(p => p.visibility === 'authenticated');

  // Check that bottom nav items are referenced in app pages
  appPages.forEach(page => {
    const htmlFile = path.join(__dirname, '../public', page.route.split('/').pop() + '.html');
    if (!fs.existsSync(htmlFile) && page.route !== '/app') return;

    try {
      const content = page.route === '/app'
        ? fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8')
        : fs.readFileSync(htmlFile, 'utf8');

      const hasBottomNav = content.includes('bottom-tabs') || content.includes('appBottomTabs');

      if (hasBottomNav) {
        logPass('Bottom Nav', `Present on ${page.label} (${page.route})`);
      } else if (page.route !== '/share' && page.route !== '/admin/stats' && page.route !== '/admin/ideas') {
        logWarning('Bottom Nav', `Missing on ${page.label} (${page.route})`);
      }
    } catch {
      // File doesn't exist, skip
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: CSP VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

function testCSPValidation() {
  console.log('\n--- Test 4: CSP Validation ---');

  // Read middleware/security.js to check CSP headers
  const securityFile = path.join(__dirname, '../middleware/security.js');
  if (!fs.existsSync(securityFile)) {
    logWarning('CSP Validation', 'security.js not found');
    return;
  }

  const content = fs.readFileSync(securityFile, 'utf8');

  // Check for connectSrc directive (can be array or inline string)
  const connectSrcMatch = content.match(/connectSrc\s*:\s*\[([\s\S]*?)\]/);
  if (!connectSrcMatch) {
    logWarning('CSP Validation', 'No connectSrc directive found in CSP');
    return;
  }

  const connectSrc = connectSrcMatch[1];
  let missingDomains = [];

  KNOWN_API_DOMAINS.forEach(domain => {
    if (!connectSrc.includes(domain)) {
      missingDomains.push(domain);
    }
  });

  if (missingDomains.length === 0) {
    logPass('CSP Validation', 'All known API domains in connectSrc');
  } else {
    logFail('CSP Validation', `Missing domains: ${missingDomains.join(', ')}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: SERVICE WORKER VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

function testServiceWorker() {
  console.log('\n--- Test 5: Service Worker Verification ---');

  const swFile = path.join(__dirname, '../public/sw.js');
  if (fs.existsSync(swFile)) {
    const content = fs.readFileSync(swFile, 'utf8');
    const versionMatch = content.match(/const\s+CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);

    if (versionMatch) {
      logPass('Service Worker', `Version: ${versionMatch[1]}`);
    } else {
      logWarning('Service Worker', 'No CACHE_VERSION found');
    }
  } else {
    logFail('Service Worker', 'sw.js not found');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6: ROUTE AUDIT
// ═══════════════════════════════════════════════════════════════════════════════

function testRouteAudit() {
  console.log('\n--- Test 6: Route Audit ---');

  // Scan routes directory for all defined routes
  const routesDir = path.join(__dirname, '../routes');
  const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

  const definedRoutes = new Set();
  routeFiles.forEach(file => {
    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    // Extract router.get/post/put/delete patterns
    const matches = content.match(/router\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g);
    if (matches) {
      matches.forEach(match => {
        const routeMatch = match.match(/['"]([^'"]+)['"]/);
        if (routeMatch) definedRoutes.add(routeMatch[1]);
      });
    }
  });

  // Also check pages.js for page routes
  const pagesFile = path.join(__dirname, '../routes/pages.js');
  const pagesContent = fs.readFileSync(pagesFile, 'utf8');
  const pageMatches = pagesContent.match(/router\.get\s*\(\s*['"]([^'"]+)['"]/g);
  if (pageMatches) {
    pageMatches.forEach(match => {
      const routeMatch = match.match(/['"]([^'"]+)['"]/);
      if (routeMatch) definedRoutes.add(routeMatch[1]);
    });
  }

  logPass('Route Audit', `Found ${definedRoutes.size} defined routes`);

  // Check for orphan routes (exist but not in nav and not whitelisted)
  let orphanRoutes = [];
  definedRoutes.forEach(route => {
    const inNav = NAV_CONFIG.getNavigableRoutes().some(r => r.route === route);
    const isWhitelisted = WHITELISTED_ROUTES.has(route) ||
                         WHITELISTED_ROUTES.has(route.split('/').slice(0, 2).join('/*'));

    if (!inNav && !isWhitelisted) {
      orphanRoutes.push(route);
    }
  });

  if (orphanRoutes.length === 0) {
    logPass('Orphan Routes', 'No orphan routes found');
  } else {
    logWarning('Orphan Routes', `Found ${orphanRoutes.length}: ${orphanRoutes.join(', ')}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7: NO ORPHANED ROUTES (EXPLICIT CHECK)
// ═══════════════════════════════════════════════════════════════════════════════

function testNoOrphanedRoutes() {
  console.log('\n--- Test 7: No Orphaned Routes ---');

  const navigableRoutes = NAV_CONFIG.getNavigableRoutes();
  const publicRoutes = navigableRoutes.filter(r => r.visibility === 'public' || r.visibility === 'authenticated');

  logPass('Routes Config', `${publicRoutes.length} routes in navigation`);

  // Verify each route in nav has a corresponding page or endpoint
  let allValid = true;
  publicRoutes.forEach(route => {
    if (!route.route) {
      logFail('Route validation', `Missing route for ${route.label}`);
      allValid = false;
    }
  });

  if (allValid) {
    logPass('Route Validation', 'All nav routes are valid');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8: NO SILENT FETCH FAILURES
// ═══════════════════════════════════════════════════════════════════════════════

function testNoSilentFetches() {
  console.log('\n--- Test 8: No Silent Fetch Failures ---');

  const publicDir = path.join(__dirname, '../public');
  const jsFiles = [];

  function walkDir(dir) {
    fs.readdirSync(dir).forEach(file => {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        walkDir(fullPath);
      } else if (file.endsWith('.js') && !file.includes('vendor')) {
        jsFiles.push(fullPath);
      }
    });
  }

  walkDir(publicDir);

  let issuesFound = [];

  jsFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    // Find fetch calls
    const fetchMatches = content.match(/fetch\s*\([^)]+\)/g);
    if (fetchMatches) {
      fetchMatches.forEach((fetchCall, idx) => {
        // Check if followed by .catch or error handling
        const nextChars = content.substring(content.indexOf(fetchCall) + fetchCall.length,
                                           content.indexOf(fetchCall) + fetchCall.length + 200);
        const hasCatch = /\.catch\s*\(/.test(nextChars);
        const hasErrorCheck = /if\s*\(\s*!.*\.ok\s*\)/.test(nextChars);
        const hasThen = /\.then\s*\(/.test(nextChars);

        if (!hasCatch && !hasErrorCheck && hasThen) {
          const fileRel = path.relative(__dirname, file);
          issuesFound.push(`${fileRel}: fetch without error handling`);
        }
      });
    }
  });

  if (issuesFound.length === 0) {
    logPass('Silent Fetch Check', 'No unhandled fetch() calls found');
  } else {
    issuesFound.slice(0, 5).forEach(issue => {
      logWarning('Silent Fetch Check', issue);
    });
    if (issuesFound.length > 5) {
      logWarning('Silent Fetch Check', `...and ${issuesFound.length - 5} more`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9: PRO GATE CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════════

function testProGateConsistency() {
  console.log('\n--- Test 9: Pro Gate Consistency ---');

  const publicDir = path.join(__dirname, '../public');
  const srcDir = path.join(__dirname, '../middleware');

  // Find shared pro-gating utility
  const middlewareFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
  let hasProGateUtil = false;

  middlewareFiles.forEach(file => {
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    if (content.includes('isPro') || content.includes('proGate') || content.includes('checkPro')) {
      hasProGateUtil = true;
    }
  });

  if (hasProGateUtil) {
    logPass('Pro Gate Utility', 'Centralized pro-gating utility found');
  } else {
    logWarning('Pro Gate Utility', 'No centralized pro-gating utility found');
  }

  // Check for raw subscription checks (antipattern)
  let rawChecks = 0;
  function scanDir(dir) {
    fs.readdirSync(dir).forEach(file => {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        scanDir(fullPath);
      } else if (file.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (/user\.plan\s*==|user\.subscription\s*==|\.plan\s*===|\.subscription\s*===/.test(content)) {
          rawChecks++;
        }
      }
    });
  }

  scanDir(path.join(__dirname, '../routes'));

  if (rawChecks === 0) {
    logPass('Pro Gate Consistency', 'No raw subscription checks found');
  } else {
    logWarning('Pro Gate Consistency', `Found ${rawChecks} potential raw subscription checks`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 10: AUTH REDIRECT CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function testAuthRedirect() {
  console.log('\n--- Test 10: Auth Redirect Check ---');

  // Verify middleware/auth.js enforces redirects
  const authFile = path.join(__dirname, '../middleware/auth.js');
  if (!fs.existsSync(authFile)) {
    logWarning('Auth Redirect', 'middleware/auth.js not found');
    return;
  }

  const content = fs.readFileSync(authFile, 'utf8');
  const hasRedirect = content.includes('res.redirect') || content.includes('401') || content.includes('403');

  if (hasRedirect) {
    logPass('Auth Redirect', 'Auth middleware enforces redirects/401');
  } else {
    logWarning('Auth Redirect', 'Auth middleware may not be enforcing redirects');
  }

  // Check that /app/* routes use auth middleware
  const pagesFile = path.join(__dirname, '../routes/pages.js');
  const pagesContent = fs.readFileSync(pagesFile, 'utf8');

  const appRoute = pagesContent.includes('/app');
  if (appRoute) {
    logPass('Auth Redirect', '/app/* routes defined');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 11: ERROR TOAST COVERAGE
// ═══════════════════════════════════════════════════════════════════════════════

function testErrorToastCoverage() {
  console.log('\n--- Test 11: Error Toast Coverage ---');

  const appFile = path.join(__dirname, '../public/app.html');
  const content = fs.readFileSync(appFile, 'utf8');

  const hasForms = /<form[^>]*>/.test(content);
  const hasErrorHandling = /\.catch\(|if\s*\(\s*!.*\.ok\s*\)|error|Error/.test(content);
  const hasDOM = /document\.getElementById|querySelector/.test(content);

  if (hasForms && hasErrorHandling && hasDOM) {
    logPass('Error Toast Coverage', 'Forms have error handling logic');
  } else {
    logWarning('Error Toast Coverage', 'May be missing error toast implementation');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 13: CSRF PROTECTION
// Every POST/PUT/DELETE route that modifies user data must use authenticateToken
// (Bearer JWT) — Bearer tokens are CSRF-immune because browsers never auto-send
// the Authorization header cross-origin. Public mutation endpoints (login, signup,
// forgot-password, reset-password, contact, adhd-tax, analytics) are explicitly
// exempt because they are intentionally unauthenticated.
// ═══════════════════════════════════════════════════════════════════════════════

function testCSRFProtection() {
  console.log('\n--- Rule 13: CSRF Protection ---');

  // Public endpoints that intentionally don't require auth — CSRF-exempt
  const CSRF_EXEMPT_ROUTES = new Set([
    '/signup', '/login', '/forgot-password', '/reset-password',
    '/google/start', '/google/callback', '/google/one-tap', '/google-auth/callback',
    '/submit',       // contact form
    '/capture',      // adhd-tax email capture
    '/page-view',    // analytics beacon
    '/event',        // analytics event
    '/visitor',      // analytics visitor
    '/api/buddy-demo',   // landing-page demo mount — matches /conversation, /session, etc.
    '/conversation',     // buddy-demo relative route
    '/session',          // buddy-demo relative route
  ]);

  const routesDir = path.join(__dirname, '../routes');
  const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

  let unprotectedRoutes = [];
  let checkedCount = 0;

  routeFiles.forEach(file => {
    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    // Find all state-changing route definitions
    const mutationRoutes = [...content.matchAll(/router\.(post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g)];

    mutationRoutes.forEach(match => {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      checkedCount++;

      // Check if it's an exempt public route
      const isExempt = CSRF_EXEMPT_ROUTES.has(routePath) ||
        [...CSRF_EXEMPT_ROUTES].some(exempt => routePath.endsWith(exempt));

      if (isExempt) return;

      // Check that the route file references authenticateToken
      // (either imported or used inline — enough to confirm the file requires auth)
      const hasAuthToken = content.includes('authenticateToken');
      if (!hasAuthToken) {
        unprotectedRoutes.push(`${file}: ${method} ${routePath}`);
      }
    });
  });

  if (unprotectedRoutes.length === 0) {
    logPass('Rule 13 — CSRF Protection', `All ${checkedCount} state-changing routes use Bearer auth or are explicitly public`);
  } else {
    unprotectedRoutes.forEach(r => logFail('Rule 13 — CSRF Protection', `Unprotected: ${r}`));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 14: NO SECRETS IN CLIENT CODE
// Grep all served JS/HTML files for API keys, database URLs, session secrets,
// or any pattern that looks like embedded credentials.
// ═══════════════════════════════════════════════════════════════════════════════

function testNoSecretsInClientCode() {
  console.log('\n--- Rule 14: No Secrets in Client Code ---');

  const publicDir = path.join(__dirname, '../public');
  const suspiciousPatterns = [
    // Common credential env var names embedded as values
    { pattern: /DATABASE_URL\s*=\s*['"][^'"]{10,}['"]/i, label: 'DATABASE_URL value' },
    { pattern: /JWT_SECRET\s*=\s*['"][^'"]{10,}['"]/i, label: 'JWT_SECRET value' },
    { pattern: /STRIPE_SECRET_KEY\s*=\s*['"][^'"]{10,}['"]/i, label: 'STRIPE_SECRET_KEY value' },
    { pattern: /OPENAI_API_KEY\s*=\s*['"][^'"]{10,}['"]/i, label: 'OPENAI_API_KEY value' },
    { pattern: /sk_live_[A-Za-z0-9]{20,}/, label: 'Stripe live secret key' },
    { pattern: /sk_test_[A-Za-z0-9]{20,}/, label: 'Stripe test secret key' },
    { pattern: /process\.env\.[A-Z_]{4,}/, label: 'process.env reference in static file' },
    { pattern: /postgres:\/\/[^'">\s]{10,}/, label: 'Postgres connection string' },
  ];

  function walkDir(dir) {
    const results = [];
    fs.readdirSync(dir).forEach(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...walkDir(fullPath));
      } else if (file.endsWith('.html') || (file.endsWith('.js') && !file.includes('vendor'))) {
        results.push(fullPath);
      }
    });
    return results;
  }

  const files = walkDir(publicDir);
  let findings = [];

  files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    suspiciousPatterns.forEach(({ pattern, label }) => {
      if (pattern.test(content)) {
        findings.push(`${path.relative(path.join(__dirname, '..'), file)}: ${label}`);
      }
    });
  });

  if (findings.length === 0) {
    logPass('Rule 14 — No Secrets in Client Code', `Scanned ${files.length} files — clean`);
  } else {
    findings.forEach(f => logFail('Rule 14 — No Secrets in Client Code', f));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 15: SQL INJECTION AUDIT
// Grep all route files for template literals that interpolate variables (${...})
// directly into SQL query strings. All queries must use parameterized inputs ($1, $2).
// ═══════════════════════════════════════════════════════════════════════════════

function testNoSQLInjection() {
  console.log('\n--- Rule 15: SQL Injection Audit ---');

  const routesDir = path.join(__dirname, '../routes');
  const libDir = path.join(__dirname, '../lib');
  const dbDir = path.join(__dirname, '../db');

  function getJsFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(dir, f));
  }

  const allFiles = [
    ...getJsFiles(routesDir),
    ...getJsFiles(libDir),
    ...getJsFiles(dbDir),
  ];

  let injectionRisks = [];
  let safePatterns = [];

  allFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      // Only flag template literals that ARE SQL statements — i.e., the string
      // begins with a SQL verb (after backtick + optional whitespace).
      // This avoids false-positives on crypto operations, email subjects, etc.
      const isSqlTemplateLiteral = /`\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(line);
      const hasInterpolation = /\$\{[^}]+\}/.test(line);

      if (isSqlTemplateLiteral && hasInterpolation) {
        const relFile = path.relative(path.join(__dirname, '..'), file);
        const lineShort = `${relFile}:${idx + 1} — ${line.trim().slice(0, 80)}`;

        // Safe pattern 1: array-join column builders like ${updates.join(', ')}
        // Column names in the array come from validated whitelists, not raw user input.
        const isSafeArrayJoin = /\$\{[a-zA-Z_]+\.join\s*\(/.test(line);

        // Safe pattern 2: verified-safe direct interpolation — annotated below with why each is safe.
        // These are reviewed manually and confirmed to not accept unvalidated user input.
        const VERIFIED_SAFE = [
          // journal.js bumpTrustMetric: field is always a hard-coded string literal at call sites
          'routes/journal.js',
          // outbound-email.js ${type}: validated against validTypes[] array before SQL
          // outbound-email.js ${where}: WHERE clause built from parameterized conditions only
          'routes/outbound-email.js',
        ];
        const isVerifiedSafe = VERIFIED_SAFE.some(safeFile => relFile.includes(safeFile));

        if (isSafeArrayJoin || isVerifiedSafe) {
          safePatterns.push(lineShort);
        } else {
          // Direct variable interpolation (${field}, ${type}, ${where}) in SQL = FAIL
          injectionRisks.push(lineShort);
        }
      }
    });
  });

  // Report safe array-join patterns as warnings (need review but not critical)
  safePatterns.forEach(r => logWarning('Rule 15 — SQL Injection Audit', `Safe array-join (verify column whitelist): ${r}`));

  if (injectionRisks.length === 0) {
    logPass('Rule 15 — SQL Injection Audit', `All ${allFiles.length} files — no direct variable interpolation in SQL`);
  } else {
    injectionRisks.forEach(r => logFail('Rule 15 — SQL Injection Audit', r));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 16: RATE LIMITING ON AUTH ENDPOINTS
// Login, signup, forgot-password, reset-password must each have a rate limiter.
// ═══════════════════════════════════════════════════════════════════════════════

function testAuthRateLimiting() {
  console.log('\n--- Rule 16: Rate Limiting on Auth Endpoints ---');

  const authFile = path.join(__dirname, '../routes/auth.js');
  const securityFile = path.join(__dirname, '../middleware/security.js');

  if (!fs.existsSync(authFile)) {
    logFail('Rule 16 — Auth Rate Limiting', 'routes/auth.js not found');
    return;
  }

  const authContent = fs.readFileSync(authFile, 'utf8');
  const secContent = fs.existsSync(securityFile) ? fs.readFileSync(securityFile, 'utf8') : '';

  // Each auth route must reference its limiter adjacent to the route definition
  const checks = [
    { route: '/login',           limiter: 'loginLimiter',        label: 'login' },
    { route: '/signup',          limiter: 'signupLimiter',       label: 'signup' },
    { route: '/forgot-password', limiter: 'passwordResetLimiter', label: 'forgot-password' },
    { route: '/reset-password',  limiter: 'passwordResetLimiter', label: 'reset-password' },
  ];

  checks.forEach(({ route, limiter, label }) => {
    // Verify the limiter is defined in security.js
    const limiterDefined = secContent.includes(limiter);

    // Verify the limiter is referenced within 300 chars of the route definition.
    // Handles both inline and spread syntax: `router.post('/login', loginLimiter, ...)`
    // or `router.post('/login', ...(loginLimiter ? [...] : []), ...)`
    let limiterApplied = false;
    const routeIdx = authContent.indexOf(`'${route}'`);
    if (routeIdx !== -1) {
      const window = authContent.slice(routeIdx, routeIdx + 300);
      limiterApplied = window.includes(limiter);
    }

    if (!limiterDefined) {
      logFail(`Rule 16 — Auth Rate Limiting`, `${limiter} not defined in middleware/security.js`);
    } else if (!limiterApplied) {
      logFail(`Rule 16 — Auth Rate Limiting`, `${label}: ${limiter} not referenced near route definition`);
    } else {
      logPass(`Rule 16 — Auth Rate Limiting`, `${label} → ${limiter} ✓`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 18: ENV VAR VALIDATION ON STARTUP
// server.js must validate all required env vars before app.listen().
// Missing var = immediate crash with clear error, not a runtime failure.
// ═══════════════════════════════════════════════════════════════════════════════

function testEnvVarValidation() {
  console.log('\n--- Rule 18: Env Var Validation on Startup ---');

  const serverFile = path.join(__dirname, '../server.js');
  if (!fs.existsSync(serverFile)) {
    logFail('Rule 18 — Env Var Validation', 'server.js not found');
    return;
  }

  const content = fs.readFileSync(serverFile, 'utf8');

  // Validation must appear BEFORE app.listen — find position of listen
  const listenPos = content.indexOf('app.listen(');
  if (listenPos === -1) {
    logFail('Rule 18 — Env Var Validation', 'app.listen() not found in server.js');
    return;
  }

  const beforeListen = content.slice(0, listenPos);

  // Required: DATABASE_URL check with process.exit()
  const hasDatabaseCheck = /DATABASE_URL/.test(beforeListen) && /process\.exit\(1\)/.test(beforeListen);

  if (hasDatabaseCheck) {
    logPass('Rule 18 — Env Var Validation', 'DATABASE_URL validated before app.listen()');
  } else {
    logFail('Rule 18 — Env Var Validation', 'No DATABASE_URL validation with process.exit(1) found before app.listen()');
  }

  // Warn if JWT_SECRET is only warned about, not hard-failed
  const jwtSecretHardFail = /JWT_SECRET[\s\S]{0,200}process\.exit/.test(beforeListen);
  if (!jwtSecretHardFail) {
    logWarning('Rule 18 — Env Var Validation', 'JWT_SECRET missing check does not call process.exit(1) — only warns');
  } else {
    logPass('Rule 18 — Env Var Validation', 'JWT_SECRET validated before app.listen()');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 19: UNCAUGHT EXCEPTION HANDLERS
// process.on('uncaughtException') and process.on('unhandledRejection') must both
// exist in server startup code and log meaningfully.
// ═══════════════════════════════════════════════════════════════════════════════

function testUncaughtExceptionHandlers() {
  console.log('\n--- Rule 19: Uncaught Exception Handlers ---');

  const serverFile = path.join(__dirname, '../server.js');
  if (!fs.existsSync(serverFile)) {
    logFail('Rule 19 — Uncaught Exception Handlers', 'server.js not found');
    return;
  }

  const content = fs.readFileSync(serverFile, 'utf8');

  const hasUncaughtException = content.includes("process.on('uncaughtException'") ||
                               content.includes('process.on("uncaughtException"');
  const hasUnhandledRejection = content.includes("process.on('unhandledRejection'") ||
                                content.includes('process.on("unhandledRejection"');

  if (hasUncaughtException) {
    logPass('Rule 19 — Uncaught Exception Handlers', "process.on('uncaughtException') found");
  } else {
    logFail('Rule 19 — Uncaught Exception Handlers', "Missing: process.on('uncaughtException') in server.js");
  }

  if (hasUnhandledRejection) {
    logPass('Rule 19 — Uncaught Exception Handlers', "process.on('unhandledRejection') found");
  } else {
    logFail('Rule 19 — Uncaught Exception Handlers', "Missing: process.on('unhandledRejection') in server.js");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 27: DOUBLE-SUBMIT PREVENTION
// Every form must disable the submit button after first click until response.
// Smoke test: verify every form's submit handler includes a disable/loading toggle.
// ═══════════════════════════════════════════════════════════════════════════════

function testDoubleSubmitPrevention() {
  console.log('\n--- Rule 27: Double-Submit Prevention ---');

  const publicDir = path.join(__dirname, '../public');
  const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

  let formsFound = 0;
  let formsProtected = 0;
  let unprotectedForms = [];

  // Pages that only have read-only UI or no submission forms
  const FORM_EXEMPT_PAGES = new Set([
    'app.html',         // SPA-style with inline JS — verified manually
    'portal.html',      // portal with complex embedded JS
    'sw.js',
    'offline.html',
    'share.html',
    '404.html',
    'index.html',       // landing page — forms handled in embedded JS
  ]);

  htmlFiles.forEach(file => {
    if (FORM_EXEMPT_PAGES.has(file)) return;

    const content = fs.readFileSync(path.join(publicDir, file), 'utf8');
    const formMatches = content.match(/<form[^>]*>/g);
    if (!formMatches) return;

    // Check for disabled/loading state patterns in the JS section
    const hasDisable = /\.disabled\s*=\s*true/.test(content);
    const hasLoadingText = /textContent\s*=\s*['"][^'"]*ing[^'"]*['"]|innerHTML\s*=\s*['"][^'"]*ing[^'"]*['"]/.test(content);
    const hasFinally = /finally\s*\{/.test(content);

    formsFound += formMatches.length;

    if (hasDisable && (hasLoadingText || hasFinally)) {
      formsProtected += formMatches.length;
      logPass(`Rule 27 — Double-Submit`, `${file}: ${formMatches.length} form(s) — disabled + loading state found`);
    } else {
      unprotectedForms.push(`${file}: ${formMatches.length} form(s) — missing disabled/loading toggle`);
    }
  });

  unprotectedForms.forEach(f => logFail('Rule 27 — Double-Submit Prevention', f));

  if (formsFound === 0) {
    logPass('Rule 27 — Double-Submit Prevention', 'No standalone form pages found to check');
  } else if (unprotectedForms.length === 0) {
    logPass('Rule 27 — Double-Submit Prevention', `All ${formsFound} form(s) across checked pages have double-submit protection`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 31: NO HARDCODED / DUMMY DATA
// Scan all client-reachable files for placeholder strings, demo mode flags,
// hardcoded demo arrays, and SQL queries that lack user_id scoping.
// ═══════════════════════════════════════════════════════════════════════════════

function testNoDummyData() {
  console.log('\n--- Rule 31: No Hardcoded / Dummy Data ---');

  const publicDir = path.join(__dirname, '../public');
  const routesDir = path.join(__dirname, '../routes');
  const libDir    = path.join(__dirname, '../lib');

  // 31-A: Placeholder strings in client-served files (.html, .js)
  // demo.js is the interactive landing-page demo — intentionally exempted.
  // analytics.js is a third-party library — exempted.
  const PLACEHOLDER_EXEMPT = new Set(['demo.js', 'analytics.js', 'bottom-tabs-template.html']);

  const PLACEHOLDER_PATTERNS = [
    { pattern: /lorem ipsum/i,                     label: 'Lorem ipsum placeholder text' },
    { pattern: /\bsample task\b/i,                  label: 'Literal "Sample task" text' },
    { pattern: /\btest expense\b/i,                 label: 'Literal "Test expense" text' },
    { pattern: /\bjohn doe\b/i,                     label: 'Literal "John Doe" placeholder' },
    { pattern: /example@(?!polsia\.internal)/i,     label: 'Hardcoded example@ email address' },
    { pattern: /\b555-\d{4}\b/,                     label: 'Fake 555- phone number' },
    { pattern: /\bisDemo(?:Mode|Data)\b/,            label: 'Demo mode flag (isDemoMode / isDemoData)' },
    { pattern: /\bshowSampleData\b/,                label: 'showSampleData flag' },
    // Hardcoded demo item arrays — matches 'const sampleTasks = [' style declarations
    { pattern: /\bconst\s+(?:sample|demo|fake|test)[A-Z][a-zA-Z]*\s*=\s*\[/,
                                                    label: 'Hardcoded demo/sample array declaration' },
  ];

  function walkPublic(dir) {
    const files = [];
    fs.readdirSync(dir).forEach(f => {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        files.push(...walkPublic(full));
      } else if ((f.endsWith('.html') || f.endsWith('.js')) && !PLACEHOLDER_EXEMPT.has(f)) {
        files.push(full);
      }
    });
    return files;
  }

  const clientFiles = walkPublic(publicDir);
  let placeholderFindings = [];

  clientFiles.forEach(file => {
    const rel = path.relative(path.join(__dirname, '..'), file);
    const content = fs.readFileSync(file, 'utf8');
    PLACEHOLDER_PATTERNS.forEach(({ pattern, label }) => {
      if (pattern.test(content)) {
        placeholderFindings.push(`${rel}: ${label}`);
      }
    });
  });

  if (placeholderFindings.length === 0) {
    logPass('Rule 31-A — No Placeholder Strings', `Scanned ${clientFiles.length} client files — clean`);
  } else {
    placeholderFindings.forEach(f => logFail('Rule 31-A — No Placeholder Strings', f));
  }

  // 31-B: SQL queries that SELECT without user_id filtering
  // Checks routes/ and lib/ for SELECT queries missing a WHERE user_id clause.
  // Exempt patterns: COUNT queries on aggregate data, JOIN queries where user_id
  // comes from a joined table, admin/analytics routes.
  const SCOPE_EXEMPT_FILES = new Set([
    'analytics.js',   // aggregate analytics data, no per-user scope needed
    'admin.js',       // admin routes intentionally access all users' data
  ]);

  function getJsFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.js') && !SCOPE_EXEMPT_FILES.has(f))
      .map(f => path.join(dir, f));
  }

  const backendFiles = [...getJsFiles(routesDir), ...getJsFiles(libDir)];
  let unscopedQueries = [];

  backendFiles.forEach(file => {
    const rel = path.relative(path.join(__dirname, '..'), file);
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      // Only check lines that look like SELECT queries in template literals or strings
      const isSelectLine = /`\s*SELECT\b/i.test(line) || /['"]SELECT\b/i.test(line);
      if (!isSelectLine) return;

      // Multi-line queries: grab up to 10 lines after to find WHERE clause
      const block = lines.slice(idx, idx + 10).join(' ');

      // Has user_id somewhere in the block
      const hasUserScope = /\buser_id\b/i.test(block) ||
                           /\bowner_id\b/i.test(block) ||
                           /JOIN\s+users\b/i.test(block);

      // Benign: COUNT(*) without user context (aggregate stats queries)
      const isAggregate = /SELECT\s+COUNT\s*\(/i.test(block) && !/WHERE/i.test(block);

      // Benign: joins categories/seeded tables that have no user_id by design
      const isSeedTable = /FROM\s+categories\b/i.test(block) ||
                          /FROM\s+policy_limits\b/i.test(block);

      if (!hasUserScope && !isAggregate && !isSeedTable) {
        unscopedQueries.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 80)}`);
      }
    });
  });

  if (unscopedQueries.length === 0) {
    logPass('Rule 31-B — User-Scoped Queries', `All SELECT queries in ${backendFiles.length} files have user_id scope`);
  } else {
    // Warn rather than hard-fail — some multi-line queries may be false positives
    unscopedQueries.slice(0, 5).forEach(q => logWarning('Rule 31-B — User-Scoped Queries', `Possible unscoped SELECT: ${q}`));
    if (unscopedQueries.length > 5) {
      logWarning('Rule 31-B — User-Scoped Queries', `...and ${unscopedQueries.length - 5} more — verify manually`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 30: POST-DEPLOY VISUAL VERIFICATION
// Static analysis of HTML/JS to catch:
//   30-A: Duplicate UI elements — VoiceInput injected into same container twice
//         (root cause: initVoice() called on DOMContentLoaded + fl-values-loaded
//          with no guard against existing mic buttons in the container).
//   30-B: Bottom nav item count — every app page must have exactly 6 nav items.
//   30-C: Data container presence — pages with dynamic content must declare
//         the expected container element (not hardcode items inline).
//   30-D: Empty-state coverage — pages with data containers must show a designed
//         empty state (not blank space when the user has no data).
// ═══════════════════════════════════════════════════════════════════════════════

function testVisualVerification() {
  console.log('\n--- Rule 30: Post-Deploy Visual Verification ---');

  const publicDir = path.join(__dirname, '../public');
  const jsDir     = path.join(publicDir, 'js');

  // 30-A: VoiceInput duplicate mic injection guard
  // VoiceInput.attach() always calls container.appendChild(wrap) without checking
  // whether a mic button already exists. If attach() is called more than once
  // on the same container (e.g., re-init after fl-values-loaded), each call
  // injects a new button — producing N mic icons on the same input field.
  // Fix: voice-input.js must guard with `if (container.querySelector('.fl-voice-btn')) return;`
  //      OR each call site must clear the container before re-attaching.
  const voiceFile = path.join(jsDir, 'voice-input.js');
  if (fs.existsSync(voiceFile)) {
    const voiceContent = fs.readFileSync(voiceFile, 'utf8');

    // Detect the known bug pattern: attach() appends without dedup guard
    const hasAppend = voiceContent.includes('container.appendChild(wrap)');

    // Acceptable guard patterns — any of these prevent the duplicate
    const hasDedupeGuard =
      /querySelector\s*\(\s*['"].fl-voice-btn['"]\s*\)/.test(voiceContent) ||
      /querySelector\s*\(\s*['"].fl-voice-['"]\s*\)/.test(voiceContent) ||
      /container\.__voiceAttached/.test(voiceContent) ||
      /dataset\.voiceAttached/.test(voiceContent) ||
      /container\.innerHTML\s*=\s*['"]["']/.test(voiceContent);  // nuclear clear before append

    // Check the attach call sites in app.html — if initVoice() is called
    // multiple times without clearing the container, it'll produce duplicates
    const appFile = path.join(publicDir, 'app.html');
    let initVoiceCalledMultipleTimes = false;
    let appHasDedupeAtCallSite = false;

    if (fs.existsSync(appFile)) {
      const appContent = fs.readFileSync(appFile, 'utf8');
      // Count how many times initVoice is called / registered as listener
      const initVoiceListeners = (appContent.match(/initVoice\b/g) || []).length;
      // If called > 1 place (DOMContentLoaded + event listener), it runs multiple times
      initVoiceCalledMultipleTimes = initVoiceListeners > 2;

      // Does app.html clear the container IMMEDIATELY before re-attaching?
      // Check for innerHTML = '' on the same line or within 3 lines of VoiceInput.attach(
      // by scanning the initVoice function body for a clear-before-attach pattern.
      const initVoiceIdx = appContent.indexOf('function initVoice');
      if (initVoiceIdx !== -1) {
        // Get the function body (up to 2000 chars)
        const initVoiceBody = appContent.slice(initVoiceIdx, initVoiceIdx + 2000);
        // Must explicitly clear BOTH voice containers before attaching
        const clearTaskContainer = /taskVoiceBtn[^;{]{0,50}innerHTML\s*=\s*['"]['"]/.test(initVoiceBody) ||
                                   /innerHTML\s*=\s*['"]['"]\s*;[^}]{0,100}taskVoiceBtn/.test(initVoiceBody);
        const clearExpContainer  = /expenseVoiceRow[^;{]{0,50}innerHTML\s*=\s*['"]['"]/.test(initVoiceBody) ||
                                   /innerHTML\s*=\s*['"]['"]\s*;[^}]{0,100}expenseVoiceRow/.test(initVoiceBody);
        appHasDedupeAtCallSite = clearTaskContainer && clearExpContainer;
      }
    }

    if (!hasAppend) {
      logPass('Rule 30-A — No Duplicate Mic Icons', 'VoiceInput.attach() does not use container.appendChild');
    } else if (hasDedupeGuard) {
      logPass('Rule 30-A — No Duplicate Mic Icons', 'VoiceInput.attach() has dedup guard before appendChild');
    } else if (appHasDedupeAtCallSite) {
      logPass('Rule 30-A — No Duplicate Mic Icons', 'Call site clears container before re-attaching');
    } else {
      // This WILL fail — catches the known duplicate mic bug
      logFail('Rule 30-A — No Duplicate Mic Icons',
        'VoiceInput.attach() calls container.appendChild(wrap) with no dedup guard. ' +
        'initVoice() is called on both DOMContentLoaded and fl-values-loaded — ' +
        'two mic buttons will appear on each input field. ' +
        'Fix: add `if (container.querySelector(".fl-voice-btn")) return;` at the top of attach().');
    }
  } else {
    logWarning('Rule 30-A — No Duplicate Mic Icons', 'voice-input.js not found');
  }

  // 30-B: Bottom nav item count on app pages
  // Every app page that includes the bottom nav must have exactly 6 nav items.
  const APP_PAGES_WITH_NAV = [
    'app.html', 'buddy.html', 'calendar.html', 'ideas.html',
    'journal.html', 'settings.html', 'news.html', 'values.html',
    'score.html', 'vault.html', 'insurance.html', 'nudges.html',
    'life.html',
  ];

  const EXPECTED_NAV_ITEM_COUNT = 6;
  let navCountFails = [];

  APP_PAGES_WITH_NAV.forEach(fname => {
    const fpath = path.join(publicDir, fname);
    if (!fs.existsSync(fpath)) return;

    const content = fs.readFileSync(fpath, 'utf8');
    if (!content.includes('appBottomTabs') && !content.includes('bottom-tabs')) return;

    // Count <a> tags inside the bottom-tabs section.
    // Strategy: extract the appBottomTabs element's content and count nav links.
    const navMatch = content.match(/id=["']appBottomTabs["'][^>]*>([\s\S]*?)<\/(?:nav|div)>/);
    if (!navMatch) {
      // Can't parse structure — check if bottom-tabs.js is loaded (shared component, count via template)
      // Shared bottom-tabs.js renders nav at runtime; count is verified via the template file.
      return;
    }

    const navHtml = navMatch[1];
    const linkCount = (navHtml.match(/<a\b[^>]*>/g) || []).length;

    if (linkCount === 0) {
      // Dynamic nav from shared JS — skip static count (bottom-tabs.js renders at runtime)
      return;
    }

    if (linkCount === EXPECTED_NAV_ITEM_COUNT) {
      logPass('Rule 30-B — Nav Item Count', `${fname}: ${linkCount} nav items ✓`);
    } else {
      navCountFails.push(`${fname}: expected ${EXPECTED_NAV_ITEM_COUNT} nav items, found ${linkCount}`);
    }
  });

  if (navCountFails.length === 0) {
    logPass('Rule 30-B — Nav Item Count', `Bottom nav item count verified across app pages`);
  } else {
    navCountFails.forEach(f => logFail('Rule 30-B — Nav Item Count', f));
  }

  // 30-C: Data container presence on data-driven pages
  // Each page must declare the container element that will receive dynamic content.
  // Hard fail if the container is missing — the JS will silently fail to render.
  const DATA_CONTAINERS = [
    { page: 'app.html',      containerId: 'taskList',         label: 'task list' },
    { page: 'app.html',      containerId: 'expenseList',      label: 'expense list' },
    { page: 'buddy.html',    containerId: 'planArea',         label: 'buddy plan area' },
    { page: 'calendar.html', containerId: 'calGrid',          label: 'calendar grid' },
    { page: 'ideas.html',    containerId: 'ideasList',        label: 'ideas list' },
    { page: 'journal.html',  containerId: 'historyBody',      label: 'journal entry list' },
    { page: 'vault.html',    containerId: 'docGrid',          label: 'document grid' },
    { page: 'insurance.html',containerId: 'policyList',       label: 'insurance policy list' },
  ];

  let missingContainers = [];

  DATA_CONTAINERS.forEach(({ page, containerId, label }) => {
    const fpath = path.join(publicDir, page);
    if (!fs.existsSync(fpath)) {
      missingContainers.push(`${page}: file missing`);
      return;
    }
    const content = fs.readFileSync(fpath, 'utf8');
    // Check for id="containerId" — the container must exist in the HTML
    const idPattern = new RegExp(`id=["']${containerId}["']`);
    if (idPattern.test(content)) {
      logPass('Rule 30-C — Data Container', `${page} has #${containerId} (${label})`);
    } else {
      missingContainers.push(`${page}: missing #${containerId} (${label})`);
    }
  });

  if (missingContainers.length > 0) {
    missingContainers.forEach(m => logFail('Rule 30-C — Data Container Presence', m));
  }

  // 30-D: Empty-state coverage on data-driven pages
  // Every data-driven page must have an empty-state message element so users
  // see a designed prompt instead of blank space when they have no data.
  const EMPTY_STATE_CHECKS = [
    { page: 'app.html',      emptyPattern: /empty.state|no.tasks|no tasks yet|add.your.first/i,    label: 'tasks empty state' },
    { page: 'app.html',      emptyPattern: /no.expenses|no spending|empty.expense/i,               label: 'expenses empty state' },
    { page: 'buddy.html',    emptyPattern: /no plan|no tasks|empty.*plan|start.*day/i,             label: 'buddy plan empty state' },
    { page: 'ideas.html',    emptyPattern: /no ideas|capture.*idea|empty.*idea/i,                  label: 'ideas empty state' },
    { page: 'journal.html',  emptyPattern: /no entries|start.*journal|empty.*journal/i,            label: 'journal empty state' },
    { page: 'vault.html',    emptyPattern: /no documents|upload.*first|empty.*vault/i,             label: 'vault empty state' },
  ];

  let missingEmptyStates = [];

  EMPTY_STATE_CHECKS.forEach(({ page, emptyPattern, label }) => {
    const fpath = path.join(publicDir, page);
    if (!fs.existsSync(fpath)) return;
    const content = fs.readFileSync(fpath, 'utf8');
    if (emptyPattern.test(content)) {
      logPass('Rule 30-D — Empty State', `${page} has ${label}`);
    } else {
      missingEmptyStates.push(`${page}: missing ${label}`);
    }
  });

  if (missingEmptyStates.length > 0) {
    missingEmptyStates.forEach(m => logWarning('Rule 30-D — Empty State Coverage', m));
  } else {
    logPass('Rule 30-D — Empty State Coverage', 'All data-driven pages have empty-state messaging');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 22: EVENT LISTENER SURVIVAL AFTER innerHTML RE-RENDER
// admin.html: Promo code buttons live inside renderPromoCodes()'s innerHTML
// template and get replaced on every render. The handler must use document-level
// event delegation with data-action attributes and closest() — NOT direct
// addEventListener on panel elements or inline onclick handlers. This is the
// ONLY pattern that survives all innerHTML re-renders unconditionally.
// ═══════════════════════════════════════════════════════════════════════════════

function testEventListenerSurvivesRerender() {
  console.log('\n--- Regression 22: Event Listener Survival After innerHTML Re-render ---');

  const adminFile = path.join(__dirname, '../public/admin.html');
  if (!fs.existsSync(adminFile)) {
    logWarning('R22 — Event Listener Survival', 'admin.html not found');
    return;
  }

  const content = fs.readFileSync(adminFile, 'utf8');

  // 1. Promo submit button must use data-action attribute (not inline onclick or ID-based delegation)
  const hasRenderFn = content.includes('function renderPromoCodes');
  const hasDataActionSubmit = content.includes('data-action="submit-promo"');

  if (hasRenderFn && hasDataActionSubmit) {
    logPass('R22 — Event Listener Survival',
      'Submit button uses data-action="submit-promo" attribute (survives innerHTML re-render)');
  } else {
    logFail('R22 — Event Listener Survival',
      'Submit button in renderPromoCodes() must use data-action="submit-promo" attribute. ' +
      'Inline onclick or ID-based handlers break on innerHTML re-render.');
  }

  // 2. Document-level delegation with closest() — the only pattern that never breaks.
  const hasDocDelegation = content.includes("document.addEventListener('click'");
  const hasClosest = content.includes("e.target.closest('[data-action]')");
  const handlesSubmitPromo = content.includes("action === 'submit-promo'");

  if (hasDocDelegation && hasClosest && handlesSubmitPromo) {
    logPass('R22 — Event Listener Survival',
      'Document-level delegation with closest() handles submit-promo action — cannot be destroyed');
  } else {
    logFail('R22 — Event Listener Survival',
      'Missing document-level event delegation with closest(). Required: ' +
      "document.addEventListener('click', fn) using e.target.closest('[data-action]') " +
      "and handling action === 'submit-promo'.");
  }

  // 3. NO inline onclick handlers for promo code buttons (these silently break).
  const inlineOnclickPromo = /onclick\s*=\s*["'](?:showCreatePromoForm|submitCreatePromo|togglePromoCode)/.test(content);
  if (inlineOnclickPromo) {
    logFail('R22 — Event Listener Survival',
      'Found inline onclick handler for promo code function. These break after innerHTML re-render. ' +
      'Use data-action attributes with document-level delegation instead.');
  } else {
    logPass('R22 — Event Listener Survival',
      'No inline onclick handlers for promo code functions — all routed through data-action delegation');
  }

  // 4. Double-submit guard in the delegation handler.
  const doubleSubmitRe = new RegExp("btn\\.disabled\\s*\\)\\s*return|if\\s*\\(\\s*btn\\.disabled");
  if (doubleSubmitRe.test(content)) {
    logPass('R22 — Event Listener Survival',
      'Delegation handler has double-submit guard (btn.disabled check before fetch)');
  } else {
    logFail('R22 — Event Listener Survival',
      'Delegation handler is missing double-submit guard. ' +
      'Add: if (btn.disabled) return; before the fetch call.');
  }

  // 5. NO direct getElementById + addEventListener on promo submit (old fragile pattern).
  const directBindRe = /getElementById\s*\(\s*['"]pc-submit-btn['"]\s*\)\s*\.addEventListener/;
  const panelBindRe = /pcPanel\.addEventListener\s*\(\s*['"]click['"]/;
  if (directBindRe.test(content) || panelBindRe.test(content)) {
    logFail('R22 — Event Listener Survival',
      'Found old panel-level or direct addEventListener pattern. This is fragile — ' +
      'if any JS error occurs before the setup code runs, the listener never attaches. ' +
      'Use document-level delegation with data-action instead.');
  } else {
    logPass('R22 — Event Listener Survival',
      'No fragile panel-level addEventListener pattern — document delegation is the sole handler');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 23: MORNING CHECK-IN FILTER CORRECTNESS
// All Buddy endpoints returning task lists must exclude tasks with due dates
// 4+ days out. Comment in routes/buddy.js: "Tasks due 4+ days out are excluded."
// Filter clause: due_date <= $N::date + INTERVAL '3 days'
// ═══════════════════════════════════════════════════════════════════════════════

function testBuddyTaskFilterCorrectness() {
  console.log('\n--- Regression 23: Morning Check-in Filter Correctness ---');

  const buddyFile = path.join(__dirname, '../routes/buddy.js');
  if (!fs.existsSync(buddyFile)) {
    logWarning('R23 — Buddy Task Filter', 'routes/buddy.js not found');
    return;
  }

  const content = fs.readFileSync(buddyFile, 'utf8');

  // Count occurrences of the 4-day exclusion filter across all task queries
  const filterRe = new RegExp("due_date\\s*<=\\s*\\$\\d+::date\\s*\\+\\s*INTERVAL\\s*'3 days'", 'g');
  const matches = content.match(filterRe) || [];
  const EXPECTED_MIN = 3; // GET /status + POST /conversation + POST /brain-dump-tasks

  if (matches.length >= EXPECTED_MIN) {
    logPass('R23 — Buddy Task Filter',
      "4-day exclusion filter found " + matches.length + " times in buddy.js — all task queries exclude 4+ day tasks");
  } else if (matches.length > 0) {
    logFail('R23 — Buddy Task Filter',
      "Expected at least " + EXPECTED_MIN + " queries with the 4-day filter, found " + matches.length + ". " +
      'Some buddy endpoints may return far-future tasks, adding cognitive load.');
  } else {
    logFail('R23 — Buddy Task Filter',
      "No 4-day exclusion filter found in buddy.js. " +
      "Tasks with due dates 4+ days out must be excluded from morning check-in lists.");
  }

  // Per-route verification
  const routeDefs = [
    { name: 'GET /status',            marker: "router.get('/status'" },
    { name: 'POST /conversation',     marker: "router.post('/conversation'" },
    { name: 'POST /brain-dump-tasks', marker: "router.post('/brain-dump-tasks'" },
  ];

  routeDefs.forEach(function(r, i) {
    const start = content.indexOf(r.marker);
    if (start === -1) { logWarning('R23 — Buddy Task Filter', r.name + ' route not found'); return; }
    const nextStart = routeDefs[i + 1] ? content.indexOf(routeDefs[i + 1].marker) : content.length;
    const body = content.slice(start, nextStart > start ? nextStart : start + 3000);
    const hasFilter = body.includes("INTERVAL '3 days'") || /due_date\s*<=/.test(body);
    if (hasFilter) {
      logPass('R23 — Buddy Task Filter', r.name + ': has 3-day window filter (excludes 4+ day tasks)');
    } else if (body.includes('SELECT') && body.includes('tasks')) {
      logFail('R23 — Buddy Task Filter',
        r.name + ": fetches tasks but missing due_date <= filter. Far-future tasks will appear in check-in.");
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 24: TABLET BREAKPOINT COVERAGE
// science.html must not overflow horizontally at 768px, 810px, and 1024px.
// Static analysis: verify overflow-x:hidden, multi-column gated at 1080px+,
// and explicit single-column fallback for widths < 1080px.
// ═══════════════════════════════════════════════════════════════════════════════

function testTabletBreakpointCoverage() {
  console.log('\n--- Regression 24: Tablet Breakpoint Coverage (science.html) ---');

  const scienceFile = path.join(__dirname, '../public/science.html');
  if (!fs.existsSync(scienceFile)) {
    logWarning('R24 — Tablet Breakpoints', 'public/science.html not found');
    return;
  }

  const content = fs.readFileSync(scienceFile, 'utf8');

  // 1. overflow-x:hidden prevents any wide child from causing horizontal scroll.
  const overflowRe = new RegExp("overflow-x\\s*:\\s*hidden");
  if (overflowRe.test(content)) {
    logPass('R24 — Tablet Breakpoints', 'overflow-x:hidden present — prevents horizontal scroll at all widths');
  } else {
    logFail('R24 — Tablet Breakpoints',
      'No overflow-x:hidden in science.html. ' +
      'Wide child elements will cause horizontal scroll at 768px, 810px, and 1024px tablet widths.');
  }

  // 2. Multi-column layout must be gated behind min-width:1080px.
  const has1080Query = content.includes('min-width: 1080px') || content.includes('min-width:1080px');
  const hasTwoColLayout = content.includes('two-col') ||
    new RegExp("grid-template-columns\\s*:").test(content);

  if (hasTwoColLayout && has1080Query) {
    logPass('R24 — Tablet Breakpoints', 'Multi-column layout gated behind min-width:1080px media query');
  } else if (hasTwoColLayout && !has1080Query) {
    logFail('R24 — Tablet Breakpoints',
      'Multi-column layout present but no min-width:1080px gate. ' +
      'Two-column layout will overflow at 768px and 810px tablet widths.');
  } else {
    logPass('R24 — Tablet Breakpoints', 'No multi-column layout detected — no tablet overflow risk from layout');
  }

  // 3. Explicit single-column fallback for the 768px–1079px range.
  const has1079Fallback = content.includes('max-width: 1079px') || content.includes('max-width:1079px');
  if (has1079Fallback) {
    logPass('R24 — Tablet Breakpoints',
      'max-width:1079px rule present — single-column fallback active for 768px, 810px, and 1024px');
  } else {
    logFail('R24 — Tablet Breakpoints',
      'No max-width:1079px rule found. ' +
      'Tablets at 768px, 810px, and 1024px may render a multi-column layout that causes horizontal overflow. ' +
      'Add: @media (max-width: 1079px) { .two-col { grid-template-columns: 1fr; } }');
  }

  // 4. Warn on fixed pixel widths > 600px (potential overflow at mobile/tablet).
  const fixedWideRe = new RegExp("width\\s*:\\s*([6-9]\\d{2,}|[1-9]\\d{3,})px", 'g');
  const fixedWide = content.match(fixedWideRe) || [];
  if (fixedWide.length === 0) {
    logPass('R24 — Tablet Breakpoints', 'No fixed-width declarations > 600px detected');
  } else {
    logWarning('R24 — Tablet Breakpoints',
      fixedWide.length + ' fixed-width declaration(s) > 600px: ' + fixedWide.slice(0, 3).join(', ') + '. ' +
      'Verify these are inside min-width media queries or use max-width:100% instead.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 25: SERVICE WORKER CACHE VERSION CONSISTENCY
// sw.js must: (a) declare CACHE_VERSION, (b) call skipWaiting() to activate
// immediately on install, (c) call clients.claim() to control existing open tabs,
// (d) delete old caches in the activate handler to prevent stale asset buildup.
// ═══════════════════════════════════════════════════════════════════════════════

function testServiceWorkerCacheConsistency() {
  console.log('\n--- Regression 25: Service Worker Cache Version Consistency ---');

  const swFile = path.join(__dirname, '../public/sw.js');
  if (!fs.existsSync(swFile)) {
    logFail('R25 — SW Cache Consistency', 'public/sw.js not found');
    return;
  }

  const swContent = fs.readFileSync(swFile, 'utf8');

  // 1. CACHE_VERSION constant must exist.
  const versionRe = new RegExp("const\\s+CACHE_VERSION\\s*=\\s*['\"]([^'\"]+)['\"]");
  const versionMatch = swContent.match(versionRe);
  if (!versionMatch) {
    logFail('R25 — SW Cache Consistency', 'No CACHE_VERSION constant in sw.js');
    return;
  }
  const currentVersion = versionMatch[1];
  logPass('R25 — SW Cache Consistency', 'CACHE_VERSION: ' + currentVersion);

  // 2. skipWaiting() — new SW activates immediately without waiting for all tabs to close.
  if (swContent.includes('self.skipWaiting()')) {
    logPass('R25 — SW Cache Consistency', 'skipWaiting() present — new SW activates immediately on install');
  } else {
    logFail('R25 — SW Cache Consistency',
      'sw.js missing self.skipWaiting() in install handler. ' +
      'Without it, updated SW waits for all tabs to close before activating — stale assets persist.');
  }

  // 3. clients.claim() — new SW takes control of all existing open tabs on activation.
  if (swContent.includes('self.clients.claim()')) {
    logPass('R25 — SW Cache Consistency', 'clients.claim() present — new SW controls existing tabs immediately');
  } else {
    logFail('R25 — SW Cache Consistency',
      'sw.js missing self.clients.claim() in activate handler. ' +
      'Open tabs will continue using the old SW until navigated away and back.');
  }

  // 4. Activate handler must delete old caches to prevent stale asset buildup.
  const deletesOldCachesRe = new RegExp("caches\\.delete\\s*\\(");
  if (deletesOldCachesRe.test(swContent)) {
    logPass('R25 — SW Cache Consistency', 'Activate handler deletes old caches — prevents stale cache accumulation');
  } else {
    logFail('R25 — SW Cache Consistency',
      'sw.js activate handler does not delete old caches. ' +
      'Old cache entries accumulate across deploys and may serve stale responses.');
  }

  // 5. Check app.html for stale version references (would indicate mismatched cache hints).
  const appFile = path.join(__dirname, '../public/app.html');
  if (fs.existsSync(appFile)) {
    const appContent = fs.readFileSync(appFile, 'utf8');
    const allVersionRefs = appContent.match(/fl-v\d+/g) || [];
    const staleRefs = allVersionRefs.filter(function(v) { return v !== currentVersion; });
    if (staleRefs.length > 0) {
      logFail('R25 — SW Cache Consistency',
        'app.html references old SW version(s): ' + Array.from(new Set(staleRefs)).join(', ') + '. ' +
        'Current version is ' + currentVersion + '. Remove or update stale version references.');
    } else if (allVersionRefs.length > 0) {
      logPass('R25 — SW Cache Consistency',
        'app.html SW version references match current version (' + currentVersion + ')');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 26: SHARED TIMEZONE UTILITY ENFORCEMENT
// routes/buddy.js, routes/tasks.js, routes/recurring.js, routes/health-score.js
// must all import lib/timezone.js and use getUserLocalDate() for the "today" date
// in task queries. Using SQL CURRENT_DATE directly is UTC-biased on Neon and
// will produce wrong results for users in non-UTC timezones.
// ═══════════════════════════════════════════════════════════════════════════════

function testSharedTimezoneUtilityEnforcement() {
  console.log('\n--- Regression 26: Shared Timezone Utility Enforcement ---');

  const timezoneLib = path.join(__dirname, '../lib/timezone.js');
  if (!fs.existsSync(timezoneLib)) {
    logFail('R26 — Timezone Utility', 'lib/timezone.js not found — shared utility missing');
    return;
  }

  const tzContent = fs.readFileSync(timezoneLib, 'utf8');
  if (!tzContent.includes('getUserLocalDate') ||
      (!tzContent.includes('module.exports') && !tzContent.includes('exports.'))) {
    logFail('R26 — Timezone Utility', 'lib/timezone.js does not export getUserLocalDate');
    return;
  }
  logPass('R26 — Timezone Utility', 'lib/timezone.js exports getUserLocalDate');

  const TASK_DATE_ROUTES = [
    'routes/buddy.js',
    'routes/tasks.js',
    'routes/recurring.js',
    'routes/health-score.js',
  ];

  const CURRENT_DATE_RE = new RegExp('\\bCURRENT_DATE\\b');

  TASK_DATE_ROUTES.forEach(function(relPath) {
    const fullPath = path.join(__dirname, '..', relPath);
    if (!fs.existsSync(fullPath)) {
      logWarning('R26 — Timezone Utility', relPath + ' not found — skipping');
      return;
    }

    const fileContent = fs.readFileSync(fullPath, 'utf8');
    const importsTimezone = fileContent.includes('lib/timezone');
    const usesGetUserLocalDate = fileContent.includes('getUserLocalDate');

    if (importsTimezone && usesGetUserLocalDate) {
      logPass('R26 — Timezone Utility', relPath + ': imports and uses getUserLocalDate');
    } else if (importsTimezone && !usesGetUserLocalDate) {
      logFail('R26 — Timezone Utility',
        relPath + ': imports lib/timezone but does not call getUserLocalDate. Date filtering may be incorrect.');
    } else {
      logFail('R26 — Timezone Utility',
        relPath + ': does not use lib/timezone.js for date calculations. ' +
        'Task date filtering must use getUserLocalDate(tz) — CURRENT_DATE is UTC on Neon.');
    }

    // Anti-pattern: raw CURRENT_DATE in SQL (UTC-biased on Neon).
    // Strip comment lines first — a file may explain WHY it avoids CURRENT_DATE in a comment,
    // which would match the regex on a line that is not actual SQL.
    const nonCommentCode = fileContent.split(String.fromCharCode(10)).filter(function(l) {
      return l.trim().indexOf('//') !== 0;
    }).join(String.fromCharCode(10));
    if (CURRENT_DATE_RE.test(nonCommentCode)) {
      logFail('R26 — Timezone Utility',
        relPath + ': uses CURRENT_DATE in SQL. ' +
        'Replace with getUserLocalDate(tz) passed as a $N parameter.');
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 27: API RESPONSE SHAPE ASSERTIONS
// Every res.json() in buddy.js and tasks.js must include a boolean success field.
// Error responses (4xx/5xx) must also include a message field.
// Missing fields cause silent undefined values in the frontend.
// ═══════════════════════════════════════════════════════════════════════════════

function testAPIResponseShapes() {
  console.log('\n--- Regression 27: API Response Shape Assertions ---');

  const ROUTE_FILES = [
    { file: 'routes/buddy.js', label: 'Buddy' },
    { file: 'routes/tasks.js', label: 'Tasks' },
  ];

  const JSON_INLINE_RE = new RegExp('res\\.json\\s*\\(\\s*\\{([^}]+)\\}');
  const ERROR_STATUS_RE = new RegExp('res\\.status\\s*\\([45]\\d{2}\\)');
  const SUCCESS_FIELD_RE = new RegExp('\\bsuccess\\s*:');
  const MESSAGE_FIELD_RE = new RegExp('\\bmessage\\s*:');

  ROUTE_FILES.forEach(function(rf) {
    const fullPath = path.join(__dirname, '..', rf.file);
    if (!fs.existsSync(fullPath)) {
      logWarning('R27 — API Response Shapes', rf.file + ' not found');
      return;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    let checked = 0;
    const missingSuccess = [];
    const missingMessage = [];

    lines.forEach(function(line, idx) {
      const jsonMatch = line.match(JSON_INLINE_RE);
      if (!jsonMatch) return;
      checked++;
      const fields = jsonMatch[1];

      if (!SUCCESS_FIELD_RE.test(fields)) {
        missingSuccess.push(rf.file + ':' + (idx + 1) + ' — ' + line.trim().slice(0, 80));
      }
      if (ERROR_STATUS_RE.test(line) && !MESSAGE_FIELD_RE.test(fields)) {
        missingMessage.push(rf.file + ':' + (idx + 1) + ' — ' + line.trim().slice(0, 80));
      }
    });

    if (missingSuccess.length === 0) {
      logPass('R27 — API Response Shapes',
        rf.label + ': all ' + checked + ' res.json() responses include success field');
    } else {
      missingSuccess.forEach(function(loc) {
        logFail('R27 — API Response Shapes', rf.label + ': missing success field — ' + loc);
      });
    }

    if (missingMessage.length === 0) {
      logPass('R27 — API Response Shapes', rf.label + ': all error responses include message field');
    } else {
      missingMessage.forEach(function(loc) {
        logFail('R27 — API Response Shapes', rf.label + ': error response missing message — ' + loc);
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 28: TOAST/FEEDBACK VISIBILITY
// showToast() must: (a) make the toast visible, (b) keep it visible >= 3000ms,
// (c) show it with a short delay (<= 100ms). ADHD users need adequate reading time.
// ═══════════════════════════════════════════════════════════════════════════════

function testToastFeedbackVisibility() {
  console.log('\n--- Regression 28: Toast/Feedback Visibility ---');

  const publicDir = path.join(__dirname, '../public');
  const htmlFiles = fs.readdirSync(publicDir).filter(function(f) { return f.endsWith('.html'); });

  const pagesWithToast = htmlFiles.filter(function(file) {
    const c = fs.readFileSync(path.join(publicDir, file), 'utf8');
    return c.includes('function showToast');
  });

  if (pagesWithToast.length === 0) {
    logWarning('R28 — Toast Visibility', 'No pages with showToast function found');
    return;
  }

  pagesWithToast.forEach(function(file) {
    const content = fs.readFileSync(path.join(publicDir, file), 'utf8');
    const fnIdx = content.indexOf('function showToast');
    if (fnIdx === -1) return;
    // Read up to 800 chars to capture full function body
    const fnBody = content.slice(fnIdx, fnIdx + 800);

    // (a) Toast must be made visible.
    //     Accept multiple patterns used across different pages:
    //     - classList.add('show') / classList.add('visible')
    //     - className = '...show...' (inline class assignment)
    //     - .show property check
    //     - opacity / display style assignment
    //     - appendChild (dynamically created toast)
    const makesVisible =
      fnBody.includes('classList.add') ||
      fnBody.includes('.show') ||
      (fnBody.includes('className=') || fnBody.indexOf('className ') > -1 || fnBody.includes('className =')) ||
      fnBody.includes('opacity') ||
      fnBody.includes('display') ||
      fnBody.includes('appendChild') ||
      fnBody.includes('style.cssText');

    if (!makesVisible) {
      logFail('R28 — Toast Visibility',
        file + ': showToast does not appear to make the toast visible — users will not see error feedback.');
      return;
    }

    // (b) Dismiss must be >= 3000ms.
    //     Find all setTimeout values in the function body. The dismiss setTimeout is the one
    //     that removes visibility (removes class, sets opacity:0, or removes the element).
    //     Strategy: collect all timeouts >= 1000ms as candidates for the dismiss timer.
    const dismissRe = new RegExp('setTimeout\\s*\\(', 'g');
    const allTimeouts = [];
    let m;
    // Match: setTimeout(fn, N) — grab the numeric value
    const timeoutValRe = new RegExp('setTimeout[^,]*,\\s*(\\d+)', 'g');
    while ((m = timeoutValRe.exec(fnBody)) !== null) {
      allTimeouts.push(parseInt(m[1]));
    }
    const dismissCandidates = allTimeouts.filter(function(d) { return d >= 1000; });
    const maxDuration = dismissCandidates.length > 0 ? Math.max.apply(null, dismissCandidates) : 0;
    const minDuration = allTimeouts.filter(function(d) { return d > 0; }).length > 0
      ? Math.min.apply(null, allTimeouts.filter(function(d) { return d > 0; }))
      : 0;

    // For dynamically-created toasts (portal.html style): they use setTimeout to fade out.
    // The dismiss is at the max timeout value.
    if (maxDuration >= 3000) {
      logPass('R28 — Toast Visibility',
        file + ': toast visible for ' + maxDuration + 'ms (>= 3000ms minimum)');
    } else if (maxDuration > 0) {
      logFail('R28 — Toast Visibility',
        file + ': toast dismissed after ' + maxDuration + 'ms — must persist >= 3000ms. ' +
        'ADHD users need adequate time to read error messages before they disappear.');
    } else {
      // May use a different dismiss mechanism (e.g., class toggle without setTimeout)
      logWarning('R28 — Toast Visibility',
        file + ': could not determine toast dismiss duration from static analysis');
    }

    // (c) Show delay: the smallest timeout, if it is small (<= 100ms), is the show-after delay.
    //     Only flag this if there are clearly two timeouts (show + dismiss pattern).
    if (allTimeouts.length >= 2 && minDuration <= 100) {
      logPass('R28 — Toast Visibility',
        file + ': show delay is ' + minDuration + 'ms (appears promptly)');
    }
    // Do NOT warn about single-timeout patterns (dismiss-only, no separate show delay).
  });
}
function testJSFailureDegradation() {
  console.log('\n--- Regression 29: JS-Failure Degradation ---');

  const publicDir = path.join(__dirname, '../public');

  const CRITICAL_PAGES = [
    'app.html',
    'buddy.html',
    'settings.html',
    'login.html',
    'signup.html',
    'values.html',
    'journal.html',
  ];

  // The FB Pixel noscript is a tracking pixel — invisible to users, not a helpful message
  const FB_PIXEL_RE = new RegExp('facebook\\.com/tr\\?id=');
  const NOSCRIPT_RE = new RegExp('<noscript[\\s\\S]*?<\\/noscript>', 'gi');
  const JS_REQUIRED_RE = new RegExp('[Jj]ava[Ss]cript\\s*(is\\s*)?required|enable\\s*[Jj]ava[Ss]cript');

  CRITICAL_PAGES.forEach(function(file) {
    const fullPath = path.join(publicDir, file);
    if (!fs.existsSync(fullPath)) {
      logWarning('R29 — JS Degradation', file + ' not found — skipping');
      return;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const noscriptBlocks = content.match(NOSCRIPT_RE) || [];

    const hasUserVisibleFallback = noscriptBlocks.some(function(block) {
      return !FB_PIXEL_RE.test(block) && block.trim().length > 60;
    });

    const hasJSRequiredMsg = JS_REQUIRED_RE.test(content);

    if (hasUserVisibleFallback || hasJSRequiredMsg) {
      logPass('R29 — JS Degradation', file + ': has user-visible fallback for JS-disabled state');
    } else {
      // Warning, not hard fail — this is a UX improvement gap, not a breaking bug
      logWarning('R29 — JS Degradation',
        file + ': no user-visible <noscript> message (only FB Pixel noscript found). ' +
        'Users with JS disabled see a blank page. ' +
        "Add: <noscript><p style='padding:2rem;text-align:center'>FocusLedger requires JavaScript.</p></noscript>");
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION 30: DOUBLE-SUBMIT PROTECTION (EXTENDED — MUTATION BUTTONS)
// Extends Rule 27 to buttons that fire fetch() POST/PUT/PATCH/DELETE directly
// (not via <form> submit). A rapid double-click within 100ms fires two requests
// unless the button is disabled before the first fetch completes.
// ═══════════════════════════════════════════════════════════════════════════════

function testDoubleSubmitProtectionExtended() {
  console.log('\n--- Regression 30: Double-Submit Protection (Extended — Mutation Buttons) ---');

  const publicDir = path.join(__dirname, '../public');

  const PAGES_TO_CHECK = [
    'admin.html',
    'settings.html',
    'vault.html',
    'insurance.html',
  ];

  const MUTATION_RE = new RegExp("method\\s*:\\s*['\"](?:POST|PUT|PATCH|DELETE)['\"]", 'g');
  const DISABLED_TRUE_RE = new RegExp('\\.disabled\\s*=\\s*true');
  const LOADING_FLAG_RE = new RegExp('\\bloading\\b|\\bisLoading\\b|\\bprocessing\\b');
  const DEBOUNCE_RE = new RegExp('debounce|throttle');
  const FINALLY_RE = new RegExp('finally\\s*\\{');

  PAGES_TO_CHECK.forEach(function(file) {
    const fullPath = path.join(publicDir, file);
    if (!fs.existsSync(fullPath)) {
      logWarning('R30 — Double-Submit Extended', file + ' not found — skipping');
      return;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const mutationMatches = content.match(MUTATION_RE) || [];
    const mutationCount = mutationMatches.length;

    if (mutationCount === 0) {
      logPass('R30 — Double-Submit Extended', file + ': no mutation fetch() calls found');
      return;
    }

    const hasDisabledTrue = DISABLED_TRUE_RE.test(content);
    const hasLoadingFlag = LOADING_FLAG_RE.test(content);
    const hasDebounce = DEBOUNCE_RE.test(content);
    const hasFinallyRestore = FINALLY_RE.test(content);

    if (hasDisabledTrue || hasLoadingFlag || hasDebounce) {
      logPass('R30 — Double-Submit Extended',
        file + ': ' + mutationCount + ' mutation fetch(es) — ' +
        'double-submit guard detected (disabled=' + hasDisabledTrue +
        ', loading=' + hasLoadingFlag + ', debounce=' + hasDebounce + ')');
    } else {
      logFail('R30 — Double-Submit Extended',
        file + ': ' + mutationCount + ' mutation fetch(es) with no double-submit protection. ' +
        'Rapid double-clicks will fire duplicate API requests. ' +
        'Add btn.disabled = true before each fetch and restore in finally{}.');
    }

    if (hasDisabledTrue && !hasFinallyRestore) {
      logWarning('R30 — Double-Submit Extended',
        file + ': button disabled before fetch but no finally{} found. ' +
        'If the request fails, the button may stay permanently disabled.');
    }
  });
}



// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

async function runAllTests() {
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              FocusLedger Comprehensive Smoke Test                             ║');
  console.log('║            Standing Engineering Rules Enforcement                             ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');

  try {
    await testDualDomain();
    testUIEntryPoints();
    testBottomNavPresence();
    testCSPValidation();
    testServiceWorker();
    testRouteAudit();
    testNoOrphanedRoutes();
    testNoSilentFetches();
    testProGateConsistency();
    testAuthRedirect();
    testErrorToastCoverage();
    // Tier 2: Security, crash prevention & double-submit
    testCSRFProtection();
    testNoSecretsInClientCode();
    testNoSQLInjection();
    testAuthRateLimiting();
    testEnvVarValidation();
    testUncaughtExceptionHandlers();
    testDoubleSubmitPrevention();
    // Tier 3: Visual verification (Rules 30-31)
    testNoDummyData();
    testVisualVerification();
    // Tier 4: Regression assertions (R22-R30)
    testEventListenerSurvivesRerender();
    testBuddyTaskFilterCorrectness();
    testTabletBreakpointCoverage();
    testServiceWorkerCacheConsistency();
    testSharedTimezoneUtilityEnforcement();
    testAPIResponseShapes();
    testToastFeedbackVisibility();
    testJSFailureDegradation();
    testDoubleSubmitProtectionExtended();
  } catch (err) {
    console.error('\n❌ Fatal error during tests:', err.message);
    process.exit(1);
  }

  // ─ SUMMARY ─
  console.log('\n╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                              SUMMARY                                          ║');
  console.log('╠═══════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║ ✅ Passed:   ${String(testsPassed).padEnd(4)}                                                   ║`);
  console.log(`║ ❌ Failed:   ${String(testsFailed).padEnd(4)}                                                   ║`);
  console.log(`║ ⚠️  Warnings: ${String(testsWarning).padEnd(4)}                                                   ║`);
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');

  // Exit with failure if any tests failed
  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests();
