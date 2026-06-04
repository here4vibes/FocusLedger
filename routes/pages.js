// Owns: all static HTML page GET routes (sendFile handlers).
// Does NOT own: API endpoints, authentication logic, or file content.

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const pub = (file) => path.join(__dirname, '..', 'public', file);

// Landing page — served from views/ (not public/) so it cannot be shadowed
// by a Render persistent disk mounted at public/. Also injects Polsia slug.
const LANDING_PATH = path.join(__dirname, '..', 'views', 'index.html');
router.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  if (fs.existsSync(LANDING_PATH)) {
    let html = fs.readFileSync(LANDING_PATH, 'utf8');
    if (slug) html = html.replace('__POLSIA_SLUG__', slug);
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.type('html').send(html);
  } else {
    res.json({ message: 'Landing page not found', path: LANDING_PATH });
  }
});

// Auth pages
router.get('/login',           (_, res) => res.sendFile(pub('login.html')));
router.get('/signup',          (_, res) => res.sendFile(pub('signup.html')));
router.get('/forgot-password', (_, res) => res.sendFile(pub('forgot-password.html')));
router.get('/reset-password',  (_, res) => res.sendFile(pub('reset-password.html')));
router.get('/confirm-delete',  (_, res) => res.sendFile(pub('confirm-delete.html')));

// Install / PWA onboarding
router.get('/install',   (_, res) => res.sendFile(pub('install.html')));

// Landing page snapshot (revert point)
router.get('/landing-old', (_, res) => res.sendFile(pub('landing-old.html')));

// Marketing / informational
router.get('/pricing',   (_, res) => res.sendFile(pub('pricing.html')));
router.get('/terms',     (_, res) => res.sendFile(pub('terms.html')));
router.get('/privacy',   (_, res) => res.sendFile(pub('privacy.html')));
router.get('/adhd-tax',  (_, res) => res.sendFile(pub('adhd-tax.html')));
router.get('/contact',   (_, res) => res.sendFile(pub('contact.html')));
router.get('/story',     (_, res) => res.sendFile(pub('story.html')));
router.get('/changelog', (_, res) => res.sendFile(pub('changelog.html')));
// WHY no-store: science.html has 78KB of inline CSS. Previous deploys proved
// that browser HTTP cache + service worker can serve stale versions indefinitely,
// causing CSS overrides at the end of the file to never reach the client.
router.get('/science', (_, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(pub('science.html'));
});

// Lead magnet assets (email capture funnel deliverables)
router.get('/assets/adhd-science-cheatsheet', (_, res) => res.sendFile(pub('assets/adhd-science-cheatsheet.html')));
router.get('/assets/daily-three-template',    (_, res) => res.sendFile(pub('assets/daily-three-template.html')));

// App pages
router.get('/routines',  (_, res) => res.sendFile(pub('routines.html')));
router.get('/settings',  (_, res) => res.sendFile(pub('settings.html')));
router.get('/ideas',     (_, res) => res.sendFile(pub('ideas.html')));
router.get('/values',    (_, res) => res.sendFile(pub('values.html')));
router.get('/calendar',  (_, res) => res.sendFile(pub('calendar.html')));
router.get('/email',     (_, res) => res.sendFile(pub('email.html')));
router.get('/journal',   (_, res) => res.sendFile(pub('journal.html')));
router.get('/share',     (_, res) => res.sendFile(pub('share.html')));
router.get('/news',      (_, res) => res.sendFile(pub('news.html')));
router.get('/transactions', (_, res) => res.sendFile(pub('transactions.html')));
// /documents, /vault, /money, /buddy → redirected to /app/* canonical routes below
router.get('/checkin',           (_, res) => res.sendFile(pub('checkin-spending.html')));
router.get('/check-in/evening',   (_, res) => res.sendFile(pub('checkin-evening.html')));

// Admin
router.get('/admin/stats', (_, res) => res.sendFile(pub('admin.html')));
router.get('/admin/ideas', (_, res) => res.sendFile(pub('ideas.html')));

// OAuth callbacks
router.get('/auth/google/callback', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`/api/email/auth/callback${qs ? '?' + qs : ''}`);
});
router.get('/auth/google-auth/callback', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`/api/auth/google/callback${qs ? '?' + qs : ''}`);
});

// Life section
router.get('/app/life',              (_, res) => res.sendFile(pub('life.html')));
router.get('/app/life/vault',        (_, res) => res.sendFile(pub('vault.html')));
router.get('/app/life/insurance',    (_, res) => res.sendFile(pub('insurance.html')));
router.get('/app/life/nudges',       (_, res) => res.sendFile(pub('nudges.html')));

// Email-to-tasks magic link claim page
router.get('/link-email',      (_, res) => res.sendFile(pub('link-email.html')));

// Tandem: accountability partner invite acceptance + partner dashboard
router.get('/partner-invite',     (_, res) => res.sendFile(pub('partner-invite.html')));
router.get('/partner-dashboard',  (_, res) => res.sendFile(pub('partner-dashboard.html')));

// App dashboard + check-in flow + Accountabilibuddy + Focus Mode + SPA catch-all under /app/*

// Primary tab routes — each serves ONLY its own view (no cross-contamination)
router.get('/app/tasks',    (_, res) => res.sendFile(pub('app/tasks.html')));
router.get('/app/money',    (_, res) => res.sendFile(pub('money.html')));
router.get('/app/vault',    (_, res) => res.sendFile(pub('vault.html')));
router.get('/app/buddy',    (_, res) => res.sendFile(pub('buddy.html')));

// WHY: /app/settings must be explicit — the /app/* catch-all below would
// otherwise serve app.html (Tasks), silently breaking Stripe redirects,
// Plaid Link, and every email/link that references /app/settings.
router.get('/app/settings', (_, res) => res.sendFile(pub('settings.html')));

// /app root → redirect to /app/tasks (canonical entry point)
router.get('/app',          (_, res) => res.redirect(301, '/app/tasks'));

// Backward-compat aliases — old top-level routes kept as 301 redirects
// so bookmarks, emails, and push notifications don't break.
router.get('/money',        (_, res) => res.redirect(301, '/app/money'));
router.get('/vault',        (_, res) => res.redirect(301, '/app/vault'));
router.get('/documents',    (_, res) => res.redirect(301, '/app/vault'));
router.get('/buddy',        (_, res) => res.redirect(301, '/app/buddy'));

router.get('/app/checkin',  (_, res) => res.sendFile(pub('checkin.html')));
router.get('/app/checkin/evening', (_, res) => res.sendFile(pub('checkin-evening.html')));
router.get('/app/focus/:taskId', (_, res) => {
    // Validate taskId looks like a UUID before serving the focus page.
    // Auth + task ownership is handled client-side in the focus page.
    if (!res.headersSent) res.sendFile(pub('app/focus.html'));
});
// Task detail view — auth + ownership enforced client-side in task.html
router.get('/app/task/:taskId', (_, res) => {
    if (!res.headersSent) res.sendFile(pub('app/task.html'));
});
router.get('/app/*',        (_, res) => res.sendFile(pub('app.html')));

// Portal / command center
router.get('/portal', (_, res) => res.sendFile(pub('portal.html')));
router.get('/home',   (_, res) => res.sendFile(pub('portal.html')));

module.exports = router;
