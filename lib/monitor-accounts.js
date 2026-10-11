'use strict';
/**
 * Synthetic signup-monitor accounts (scripts/prod-signup-check.js, run by
 * .github/workflows/prod-signup-check.yml). They exercise the real signup path
 * in production, so they must never count as users or receive email.
 * Only this exact address shape qualifies: signup-monitor+<tag>@focusledger.net
 */
const MONITOR_EMAIL_RE = /^signup-monitor\+[a-z0-9._-]{1,64}@focusledger\.net$/i;

function isMonitorEmail(email) {
  return typeof email === 'string' && MONITOR_EMAIL_RE.test(email.trim());
}

module.exports = { isMonitorEmail, MONITOR_EMAIL_RE };
