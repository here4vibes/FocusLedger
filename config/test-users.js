/**
 * Shared test user credentials for automated testing.
 *
 * All automated tests (Playwright e2e, smoke suite) use this single user.
 * This module exports credentials — do NOT log or print these values.
 *
 * The QA user is created once via `scripts/reset-qa-user.js` before the
 * first smoke suite run. The reset script clears all user data so each
 * run starts from a clean slate without deleting the account.
 *
 * Usage:
 *   const { QA_USER } = require('./config/test-users');
 *
 * Or via environment variables (e2e setup reads from env first):
 *   E2E_USER_EMAIL=qa@focusledger.net
 *   E2E_USER_PASSWORD=<from config — never hardcode in test files>
 */

module.exports = {
  QA_USER: {
    email: 'qa@focusledger.net',
    // Password must match what reset-qa-user.js creates.
    // Use: node -e "console.log(require('./config/test-users').QA_USER.password)"
    // to retrieve — never commit plain-text passwords elsewhere.
    password: 'QA_Test_2026!FocusLedger',
    displayName: 'QA Test User',
  },
};