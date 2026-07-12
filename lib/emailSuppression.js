'use strict';
/**
 * lib/emailSuppression.js — the "reply 'no more'" opt-out mechanism.
 *
 * Owns: email_suppression reads/writes + opt-out phrase detection +
 * the marketing-template classification used by sendEmail's central guard.
 *
 * Transactional email (password reset, account deletion, unsubscribe
 * confirmations) is NEVER suppressed — a user who opted out of marketing
 * still needs to be able to reset their password.
 */

// Template types that count as marketing → suppressed for opted-out addresses.
// campaign_<id> covers the admin Campaigns tool.
const MARKETING_TEMPLATE_PATTERNS = [
  /^campaign_/i,
  /^beta_/i,
  /^weekly_nudge$/i,
  /^re_engagement$/i,
  /^buddy_reengage/i,
  /^pro_expiry_reminder$/i,
  /^v2_launch$/i,
  /^task_reminder$/i,
  /^routine_streak$/i,
  /^weekly_summary$/i,
  /^follow_through$/i,
];

function isMarketingTemplate(templateType) {
  if (!templateType) return false;
  return MARKETING_TEMPLATE_PATTERNS.some(p => p.test(templateType));
}

/**
 * Detect an opt-out request in an inbound reply.
 * Deliberately conservative: exact phrases anywhere, or a bare "no more" /
 * "stop" standing alone on the first non-empty line (our footers literally
 * instruct 'Reply "no more"'). Long chatty messages that happen to contain
 * the words mid-sentence don't trigger.
 */
function isOptOutMessage(subject, bodyText) {
  const explicit = [
    'unsubscribe', 'opt out', 'opt-out', 'remove me', 'take me off',
    'stop emailing', 'stop sending', 'no more emails',
  ];
  const haystack = `${subject || ''}\n${(bodyText || '').slice(0, 500)}`.toLowerCase();
  if (explicit.some(p => haystack.includes(p))) return true;

  // Bare "no more" / "stop" as the whole first line of the reply
  const firstLine = (bodyText || '').split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
  return /^["'“”]?(no more|stop)[."'!”]?$/i.test(firstLine);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Add an address to the suppression list (idempotent). */
async function suppressEmail(pool, email, reason, detail) {
  const clean = normalizeEmail(email);
  if (!clean || !clean.includes('@')) return false;
  await pool.query(
    `INSERT INTO email_suppression (email, reason, detail)
     VALUES ($1, $2, $3)
     ON CONFLICT ((LOWER(email))) DO NOTHING`,
    [clean, reason || 'reply_opt_out', (detail || '').slice(0, 500) || null]
  );
  console.log(`[email-suppression] suppressed ${clean} (${reason || 'reply_opt_out'})`);
  return true;
}

/** Is this address on the suppression list? */
async function isSuppressed(pool, email) {
  const clean = normalizeEmail(email);
  if (!clean) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM email_suppression WHERE LOWER(email) = $1 LIMIT 1',
    [clean]
  );
  return rows.length > 0;
}

// SQL fragment for recipient queries: excludes suppressed users.
// Usage: `WHERE ... ${NOT_SUPPRESSED_SQL('u.email')}`
function notSuppressedSql(emailColumn) {
  return `AND NOT EXISTS (
    SELECT 1 FROM email_suppression es WHERE LOWER(es.email) = LOWER(${emailColumn})
  )`;
}

module.exports = {
  isMarketingTemplate,
  isOptOutMessage,
  normalizeEmail,
  suppressEmail,
  isSuppressed,
  notSuppressedSql,
  MARKETING_TEMPLATE_PATTERNS,
};
