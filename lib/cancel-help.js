'use strict';
/**
 * Short "how to cancel <merchant>" steps for the Weightless subscription panel.
 * The model is told never to give contact details, and we strip any that slip
 * through: a wrong phone number or URL is worse than general directions. Any
 * failure (AI budget, API error, too little left after filtering) falls back
 * to general steps, so the user always gets something they can act on.
 */
const { complete } = require('./claude-client');

const CONTACT_RE = /(https?:|www\.|\.com\b|\.net\b|\.org\b|@|\b1[-.\s]?8\d\d\b|\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})/i;

function generalSteps(name) {
  return [
    `Open the ${name} app or website and sign in.`,
    'Go to Account or Settings, then Subscription, Billing or Plan.',
    'Choose Cancel and follow it to the end. Keep the confirmation email or a screenshot.',
    'Paying through Apple or Google? Cancel it in the App Store or Google Play instead.',
  ];
}

function searchUrl(name) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(`how to cancel ${name} subscription`);
}

const SYSTEM = [
  'You give short, practical steps for cancelling a subscription, for someone with ADHD.',
  'Rules:',
  '- 3 or 4 steps, one per line, no numbering, no preamble, each under 20 words.',
  '- NEVER include phone numbers, URLs, website addresses, or email addresses.',
  '- Name specific menus only if you are confident they exist; otherwise say "account or billing settings".',
  '- The name comes from a bank statement and may be cryptic. If you know what service it is, say so in the first step.',
  '- If billed through Apple or Google, say to cancel in the App Store or Google Play.',
].join('\n');

/**
 * @returns {Promise<{steps: string[], source: 'ai'|'general', search_url: string}>}
 */
async function cancelHelp(name, { completeFn = complete } = {}) {
  const clean = String(name || '').slice(0, 80).trim() || 'this service';
  const base = { search_url: searchUrl(clean) };
  try {
    const text = await completeFn({
      system: SYSTEM,
      messages: [{ role: 'user', content: `How do I cancel my ${clean} subscription?` }],
      maxTokens: 220,
    });
    const steps = String(text || '').split('\n')
      .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(l => l && !CONTACT_RE.test(l))
      .slice(0, 4);
    if (steps.length >= 2) return { ...base, steps, source: 'ai' };
    console.warn('[CancelHelp] AI steps unusable after filtering; using general steps | merchant:', clean);
  } catch (e) {
    console.error('[CancelHelp] AI steps failed:', e.message, '| merchant:', clean);
  }
  return { ...base, steps: generalSteps(clean), source: 'general' };
}

module.exports = { cancelHelp, generalSteps, searchUrl, CONTACT_RE };
