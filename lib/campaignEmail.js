'use strict';
/**
 * lib/campaignEmail.js — Branded shell + mini-markdown for admin-drafted
 * campaign emails. The admin writes plain text; this renders the same
 * navy/gold shell as the beta blast so every campaign looks consistent.
 *
 * Mini-markdown supported in the body:
 *   blank line          → paragraph break
 *   **bold**            → <strong>
 *   [label](https://…)  → link
 *   {name}              → recipient's first name
 */

function esc(s) {
  return String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// Escape first, then re-introduce ONLY our whitelisted markup.
function miniMarkdown(text) {
  let t = esc(text);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" style="color:#011e5c;font-weight:600;">$1</a>');
  return t
    .split(/\n\s*\n/)
    .map(p => `<p style="font-size:16px;margin:0 0 14px;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * @param {{ firstName?: string, subject: string, body: string }} opts
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderCampaign({ firstName, subject, body }) {
  const name = (firstName || 'there').split(' ')[0];
  const personalized = String(body || '').replace(/\{name\}/g, name);
  const bodyHtml = miniMarkdown(personalized);

  const html = `
  <div style="max-width:560px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141416;line-height:1.6;padding:24px;">
    <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#f0b429;font-weight:700;margin-bottom:16px;">FocusLedger</div>
    ${bodyHtml}
    <div style="margin:22px 0;">
      <a href="https://focusledger.net/app"
         style="display:inline-block;background:#011e5c;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;">
        Open FocusLedger
      </a>
    </div>
    <p style="font-size:12px;color:#aaa;border-top:1px solid #eee;padding-top:12px;margin:18px 0 0;">
      You’re getting this because you have a FocusLedger account.
      Reply &ldquo;no more&rdquo; and we’ll never email you again.
    </p>
  </div>`;

  const text = personalized
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    + '\n\nOpen FocusLedger: https://focusledger.net/app'
    + '\n\nYou\'re getting this because you have a FocusLedger account. Reply "no more" and we\'ll never email you again.';

  return { subject, html, text };
}

// Audience → SQL WHERE fragment (users table alias u). QA always excluded.
const AUDIENCES = {
  all:         '',
  active_30:   "AND u.last_active_at >= NOW() - INTERVAL '30 days'",
  inactive_30: "AND (u.last_active_at IS NULL OR u.last_active_at < NOW() - INTERVAL '30 days')",
};

module.exports = { renderCampaign, miniMarkdown, AUDIENCES };
