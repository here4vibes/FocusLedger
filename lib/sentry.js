'use strict';
/**
 * Sentry for every process: the web server AND each cron job.
 *
 * Why this exists: the codebase follows "no silent failures" by catching errors
 * and logging them as console.error('[Module] …'). Sentry only sees exceptions
 * nobody caught, so it had recorded a single issue in 90 days while real
 * failures (billing bugs, failed nudges) went only to Render logs. Capturing
 * console.error turns every logged failure into a Sentry issue, with no edits
 * to the hundreds of existing catch blocks. Cron jobs run as separate
 * processes and previously had no Sentry at all.
 *
 * No-op unless SENTRY_DSN is set (CI, tests, local dev).
 */
const Sentry = require('@sentry/node');

let enabled = false;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const scrub = (v) => (typeof v === 'string' ? v.replace(EMAIL_RE, '[email]') : v);

// Group console-captured messages by their shape, not their exact text, so
// "[MorningNudge] Error processing user 42" and "… user 43" are ONE issue.
function messageFingerprint(msg) {
  return String(msg)
    .slice(0, 160)
    .replace(EMAIL_RE, '[email]')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')                       // hex ids / hashes
    .replace(/\b(?:sub|cus|cs|evt|price|prod|in|pi|ch)_(?:test_|live_)?[A-Za-z0-9]+\b/g, '#') // Stripe ids (incl. cs_live_…)
    .replace(/\d+/g, '#');
}

function beforeSend(event) {
  // Privacy: logs carry user emails; never ship them to a third party.
  if (event.message) event.message = scrub(event.message);
  if (event.logentry && event.logentry.message) event.logentry.message = scrub(event.logentry.message);
  if (event.extra && Array.isArray(event.extra.arguments)) {
    event.extra.arguments = event.extra.arguments.map(scrub);
  }
  if (event.exception && event.exception.values) {
    for (const ex of event.exception.values) ex.value = scrub(ex.value);
  }
  // Stable grouping for console messages (exceptions group by stack already).
  const msg = event.message || (event.logentry && event.logentry.message);
  if (event.logger === 'console' && msg && !event.exception) {
    event.fingerprint = ['console', messageFingerprint(msg)];
  }
  return event;
}

/**
 * @param {string} processName e.g. 'web', 'morning-nudge' — tagged on every event
 */
function initSentry(processName) {
  if (enabled || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.RENDER_GIT_COMMIT || undefined,
    tracesSampleRate: processName === 'web' ? 0.1 : 0,
    sendDefaultPii: false,
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    initialScope: { tags: { process: processName } },
    beforeSend,
  });
  enabled = true;

  // Jobs that finish naturally (event loop drains) get queued events delivered.
  let flushed = false;
  process.on('beforeExit', () => {
    if (flushed) return;
    flushed = true;
    Sentry.flush(2000).catch(() => {});
  });
}

/**
 * Exit after giving Sentry up to 2s to deliver what's queued. Use in "Fatal"
 * catch blocks where nothing runs afterwards — a bare process.exit() kills the
 * process before the error that explains the exit is sent.
 */
function flushAndExit(code) {
  if (!enabled) return process.exit(code);
  Sentry.flush(2000).finally(() => process.exit(code));
}

module.exports = { Sentry, initSentry, flushAndExit, _internal: { beforeSend, messageFingerprint } };
