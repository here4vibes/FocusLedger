/**
 * Nav Config — Central source of truth for FocusLedger navigation
 *
 * Owns: all nav items, labels, icons, routes, visibility rules, and ordering
 * Does NOT own: authentication, actual page rendering, or feature implementation
 */

const NAV_CONFIG = {
  // ── Marketing pages (public, no auth required) ──
  marketing: [
    { label: 'Home', icon: '🏠', route: '/', visibility: 'public', type: 'landing' },
    { label: 'Pricing', icon: '💳', route: '/pricing', visibility: 'public', type: 'marketing' },
    { label: 'Story', icon: '📖', route: '/story', visibility: 'public', type: 'marketing' },
    { label: 'Changelog', icon: '📝', route: '/changelog', visibility: 'public', type: 'marketing' },
    { label: 'Contact', icon: '✉️', route: '/contact', visibility: 'public', type: 'marketing' },
    { label: 'ADHD Tax', icon: '📊', route: '/adhd-tax', visibility: 'public', type: 'marketing' },
  ],

  // ── Auth pages (public, authentication-related) ──
  auth: [
    { label: 'Login', icon: '🔑', route: '/login', visibility: 'public', type: 'auth' },
    { label: 'Sign Up', icon: '✍️', route: '/signup', visibility: 'public', type: 'auth' },
    { label: 'Forgot Password', icon: '🔍', route: '/forgot-password', visibility: 'public', type: 'auth' },
    { label: 'Reset Password', icon: '🔄', route: '/reset-password', visibility: 'public', type: 'auth' },
  ],

  // ── Bottom nav (app pages, auth required) ──
  // Order matters: appears left to right on mobile bottom nav
  bottomNav: [
    { label: 'Home', icon: '🏠', route: '/home', visibility: 'authenticated', type: 'app', id: 'tabHome' },
    { label: 'Tasks', icon: '✅', route: '/app', visibility: 'authenticated', type: 'app', id: 'tabTasks' },
    { label: 'Money', icon: '💰', route: '/money', visibility: 'authenticated', type: 'app', id: 'tabMoney' },
    { label: 'News', icon: '📰', route: '/news', visibility: 'authenticated', type: 'app', id: 'tabNews' },
    { label: 'Buddy', icon: '💬', route: '/app/buddy', visibility: 'authenticated', type: 'app', id: 'tabBuddy' },
    { label: 'More', icon: '⚙️', route: '/settings', visibility: 'authenticated', type: 'app', id: 'tabMore' },
  ],

  // ── App sub-pages (accessed via More menu or direct link) ──
  appPages: [
    { label: 'Settings', icon: '⚙️', route: '/settings', visibility: 'authenticated', type: 'app' },
    { label: 'Ideas', icon: '💡', route: '/ideas', visibility: 'authenticated', type: 'app' },
    { label: 'Values', icon: '💎', route: '/values', visibility: 'authenticated', type: 'app' },
    { label: 'Calendar', icon: '📅', route: '/calendar', visibility: 'authenticated', type: 'app' },
    { label: 'Email', icon: '📧', route: '/email', visibility: 'authenticated', type: 'app' },
    { label: 'Journal', icon: '📔', route: '/journal', visibility: 'authenticated', type: 'app' },
    { label: 'Portal', icon: '🎯', route: '/portal', visibility: 'authenticated', type: 'app' },
    { label: 'Vault', icon: '🔐', route: '/vault', visibility: 'authenticated', type: 'app' },
  ],

  // ── Admin pages (requires admin auth) ──
  admin: [
    { label: 'Admin Stats', icon: '📊', route: '/admin/stats', visibility: 'admin', type: 'admin' },
    { label: 'Admin Ideas', icon: '💡', route: '/admin/ideas', visibility: 'admin', type: 'admin' },
  ],

  // ── Legal/compliance pages (public) ──
  legal: [
    { label: 'Terms', icon: '⚖️', route: '/terms', visibility: 'public', type: 'legal' },
    { label: 'Privacy', icon: '🔒', route: '/privacy', visibility: 'public', type: 'legal' },
  ],

  // ── Utility routes (not typically in nav) ──
  // These are intentionally not in any nav menu — used by share or special flows
  utility: [
    { label: 'Share', icon: '🔗', route: '/share', visibility: 'authenticated', type: 'utility' },
    { label: 'Offline', icon: '📵', route: '/offline', visibility: 'public', type: 'utility' },
  ],

  // ── OAuth callbacks (not in nav, redirected after auth) ──
  callbacks: [
    { label: 'Google Auth Callback', route: '/auth/google-auth/callback', visibility: 'public', type: 'callback' },
    { label: 'Google Email Callback', route: '/auth/google/callback', visibility: 'public', type: 'callback' },
  ],
};

/**
 * Get all routes for smoke testing
 * @returns {Array} flat list of all routes
 */
NAV_CONFIG.getAllRoutes = function() {
  const routes = [];
  Object.keys(this).forEach(key => {
    if (Array.isArray(this[key])) {
      routes.push(...this[key].filter(item => item.route));
    }
  });
  return routes;
};

/**
 * Get routes that should appear in UI (nav items)
 * @returns {Array} routes that have visible nav links
 */
NAV_CONFIG.getNavigableRoutes = function() {
  return [
    ...this.marketing,
    ...this.auth,
    ...this.bottomNav,
    ...this.appPages,
    ...this.admin,
    ...this.legal,
  ].filter(item => item.route);
};

/**
 * Get bottom nav items only
 * @returns {Array} bottom nav items in order
 */
NAV_CONFIG.getBottomNav = function() {
  return this.bottomNav;
};

/**
 * Get all app pages (authenticated pages)
 * @returns {Array} all authenticated app pages
 */
NAV_CONFIG.getAppPages = function() {
  return [...this.bottomNav, ...this.appPages];
};

module.exports = NAV_CONFIG;
