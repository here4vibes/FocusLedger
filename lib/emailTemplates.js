'use strict';
/**
 * lib/emailTemplates.js — HTML email template builders.
 * Each function returns { subject, html, text } ready for sendEmail().
 *
 * NOTE: welcomeTemplate, passwordResetTemplate, passwordResetGoogleOnlyTemplate,
 * accountDeletionTemplate, proWelcomeTemplate and v2LaunchTemplate were imported
 * by routes but had gone missing from this file — so password reset, account
 * deletion, Pro welcome and the v2 launch campaign all threw
 * "<template> is not a function" at call time. Restored here with a shared,
 * inline-styled shell (email clients require inline CSS).
 */

const BRAND_NAVY = '#0c1b40';
const BRAND_ACCENT = '#2f6df0';
const APP_URL = (process.env.APP_URL || 'https://focusledger.net').replace(/\/$/, '');
// CAN-SPAM physical postal address for marketing footers. Override via env.
const MAILING_ADDRESS = process.env.MAILING_ADDRESS || 'FocusLedger, 2261 Market St #4978, San Francisco, CA 94114';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Wrap body HTML in a branded, mobile-friendly shell.
 * @param {string} bodyHtml  — inner HTML (already escaped where needed)
 * @param {string} [footerHtml] — optional footer block (e.g. marketing opt-out)
 */
function shell(bodyHtml, footerHtml = '') {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(12,27,64,0.08);">
        <tr><td style="background:${BRAND_NAVY};padding:22px 28px;">
          <span style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#ffffff;letter-spacing:0.2px;">FocusLedger</span>
        </td></tr>
        <tr><td style="padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c2540;">
          ${bodyHtml}
        </td></tr>
        ${footerHtml ? `<tr><td style="padding:0 28px 24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#8a92a6;">${footerHtml}</td></tr>` : ''}
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="border-radius:10px;background:${BRAND_ACCENT};">
    <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(label)}</a>
  </td></tr></table>`;
}

// Honored opt-out mechanism: inbound "no more" replies are processed by the
// email suppression flow. Included on every marketing send for CAN-SPAM.
function marketingFooter() {
  return `You're receiving this because you have a FocusLedger account.
    To stop marketing emails, just reply <strong>"no more"</strong> to this message and we'll take you off the list.
    <br><br>${esc(MAILING_ADDRESS)}`;
}

// ── Transactional ──────────────────────────────────────────────────────────

function welcomeTemplate({ name }) {
  const subject = `Welcome to FocusLedger, ${name || 'friend'}`;
  const html = shell(`
    <p style="margin:0 0 14px;">Hi ${esc(name || 'there')},</p>
    <p style="margin:0 0 14px;">Welcome to FocusLedger — your ADHD-native command center for tasks, money, and momentum, all in one tab.</p>
    <p style="margin:0 0 14px;">Here's the fastest way to feel the difference: open the app, dump whatever's on your mind, and let Buddy help you sort it into a plan.</p>
    ${button(`${APP_URL}/app`, 'Open FocusLedger')}
    <p style="margin:14px 0 0;">We built this for brains like ours. Glad you're here.</p>`);
  const text = `Hi ${name || 'there'},\n\nWelcome to FocusLedger — your ADHD-native command center for tasks, money, and momentum.\n\nOpen the app and let Buddy help you turn a brain-dump into a plan: ${APP_URL}/app\n\nGlad you're here.`;
  return { subject, html, text };
}

function passwordResetTemplate({ name, resetUrl }) {
  const subject = `Reset your FocusLedger password`;
  const html = shell(`
    <p style="margin:0 0 14px;">Hi ${esc(name || 'there')},</p>
    <p style="margin:0 0 14px;">We got a request to reset your FocusLedger password. Tap the button below to choose a new one. This link expires in 1 hour.</p>
    ${button(resetUrl, 'Reset password')}
    <p style="margin:14px 0 0;color:#8a92a6;font-size:13px;">If you didn't ask for this, you can safely ignore this email — your password won't change.</p>`);
  const text = `Hi ${name || 'there'},\n\nWe got a request to reset your FocusLedger password. Open this link to choose a new one (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't ask for this, ignore this email — your password won't change.`;
  return { subject, html, text };
}

function passwordResetGoogleOnlyTemplate({ name }) {
  const subject = `Signing in to FocusLedger`;
  const html = shell(`
    <p style="margin:0 0 14px;">Hi ${esc(name || 'there')},</p>
    <p style="margin:0 0 14px;">You asked to reset your password, but your FocusLedger account signs in with <strong>Google</strong> — there's no password to reset.</p>
    <p style="margin:0 0 14px;">Just use "Continue with Google" on the sign-in page and you're in.</p>
    ${button(`${APP_URL}/login`, 'Go to sign in')}`);
  const text = `Hi ${name || 'there'},\n\nYou asked to reset your password, but your account signs in with Google — there's no password to reset. Use "Continue with Google" on the sign-in page:\n\n${APP_URL}/login`;
  return { subject, html, text };
}

function accountDeletionTemplate({ confirmUrl }) {
  const subject = `Confirm your FocusLedger account deletion`;
  const html = shell(`
    <p style="margin:0 0 14px;">We received a request to permanently delete your FocusLedger account.</p>
    <p style="margin:0 0 14px;"><strong>This cannot be undone.</strong> All your tasks, money data, and history will be erased. To confirm, tap below within 24 hours.</p>
    ${button(confirmUrl, 'Confirm deletion')}
    <p style="margin:14px 0 0;color:#8a92a6;font-size:13px;">If you didn't request this, do nothing — your account stays exactly as it is, and this link will expire.</p>`);
  const text = `We received a request to permanently delete your FocusLedger account.\n\nThis cannot be undone. To confirm, open this link within 24 hours:\n\n${confirmUrl}\n\nIf you didn't request this, do nothing — your account stays as it is and the link expires.`;
  return { subject, html, text };
}

function proWelcomeTemplate({ name, billingCycle }) {
  const cycle = billingCycle === 'annual' || billingCycle === 'yearly' ? 'annual' : 'monthly';
  const subject = `You're on FocusLedger Autopilot 🚀`;
  const html = shell(`
    <p style="margin:0 0 14px;">Hi ${esc(name || 'there')},</p>
    <p style="margin:0 0 14px;">Your ${esc(cycle)} FocusLedger Autopilot plan is active. Thank you for backing what we're building.</p>
    <p style="margin:0 0 14px;">You've unlocked the full toolkit — bank sync, AI task breakdown, document extraction, and the whole Buddy coaching layer.</p>
    ${button(`${APP_URL}/app`, 'Jump back in')}
    <p style="margin:14px 0 0;">Reply to this email any time — a real person (with ADHD) reads it.</p>`);
  const text = `Hi ${name || 'there'},\n\nYour ${cycle} FocusLedger Autopilot plan is active — thank you. You've unlocked bank sync, AI task breakdown, document extraction, and the full Buddy coaching layer.\n\nJump back in: ${APP_URL}/app\n\nReply any time — a real person reads it.`;
  return { subject, html, text };
}

// ── Marketing (opt-out footer required) ────────────────────────────────────

function v2LaunchTemplate({ name }) {
  const subject = `FocusLedger is back — and it's a whole new thing`;
  const html = shell(`
    <p style="margin:0 0 14px;">Hi ${esc(name || 'there')},</p>
    <p style="margin:0 0 14px;">You signed up for FocusLedger early — thank you for the patience. We rebuilt it into what it should have been from the start: an ADHD-native command center where tasks, money, and momentum finally live in one place.</p>
    <p style="margin:0 0 14px;">What's new:</p>
    <ul style="margin:0 0 14px;padding-left:20px;">
      <li style="margin-bottom:6px;"><strong>Buddy</strong> — an AI coach that turns a brain-dump into a doable daily plan.</li>
      <li style="margin-bottom:6px;"><strong>Money on autopilot</strong> — bank sync plus impulse-spend detection.</li>
      <li style="margin-bottom:6px;"><strong>Daily Reveal</strong> — a small, science-backed reason to come back each morning.</li>
    </ul>
    <p style="margin:0 0 14px;">Come see what changed.</p>
    ${button(`${APP_URL}/app`, 'Open the new FocusLedger')}`,
    marketingFooter());
  const text = `Hi ${name || 'there'},\n\nYou signed up for FocusLedger early — thank you. We rebuilt it into an ADHD-native command center where tasks, money, and momentum live in one place.\n\nWhat's new:\n- Buddy: an AI coach that turns a brain-dump into a doable daily plan\n- Money on autopilot: bank sync plus impulse-spend detection\n- Daily Reveal: a small, science-backed reason to come back each morning\n\nCome see: ${APP_URL}/app\n\nTo stop marketing emails, reply "no more" to this message.\n${MAILING_ADDRESS}`;
  return { subject, html, text };
}

// ── Existing ───────────────────────────────────────────────────────────────

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
function para(html) { return `<p style="margin:0 0 14px;">${html}</p>`; }

// Marketing sends (see lib/emailSuppression.js) — every one carries the opt-out footer.
// Voice: shame-free. No "we miss you", no counting the days someone was away.

function weeklyNudgeTemplate({ name, tasksCompleted = 0, tasksDueThisWeek = 0 }) {
  const done = Number(tasksCompleted) || 0;
  const due = Number(tasksDueThisWeek) || 0;
  const subject = done > 0 ? `${plural(done, 'thing')} done last week` : 'A fresh week in FocusLedger';
  const doneLine = done > 0
    ? `You finished <strong>${plural(done, 'task')}</strong> last week. That counts, whatever else happened.`
    : `New week, clean slate. Nothing to catch up on, just pick a first thing.`;
  const dueLine = due > 0
    ? `${plural(due, 'task')} ${due === 1 ? 'has' : 'have'} a date this week. Buddy can help you pick the one to start with.`
    : `Nothing has a due date this week, so you get to choose what matters.`;
  const html = shell(`
    ${para(`Hi ${esc(name || 'there')},`)}
    ${para(doneLine)}
    ${para(esc(dueLine))}
    ${button(`${APP_URL}/weightless`, 'Plan my week')}`, marketingFooter());
  const text = `Hi ${name || 'there'},\n\n${doneLine.replace(/<[^>]+>/g, '')}\n${dueLine}\n\nPlan your week: ${APP_URL}/weightless`;
  return { subject, html, text };
}

function reEngagementTemplate({ name }) {
  const subject = 'Your FocusLedger is right where you left it';
  const html = shell(`
    ${para(`Hi ${esc(name || 'there')},`)}
    ${para('No catching up required. Your tasks and notes are exactly where you left them.')}
    ${para('If it helps, start tiny: open the app, tell Buddy one thing on your mind, and let it pick a single next step.')}
    ${button(`${APP_URL}/weightless`, 'Pick one small thing')}`, marketingFooter());
  const text = `Hi ${name || 'there'},\n\nNo catching up required. Your tasks and notes are exactly where you left them.\nStart tiny: tell Buddy one thing on your mind and it'll pick a single next step.\n\n${APP_URL}/weightless`;
  return { subject, html, text };
}

function proExpiryReminderTemplate({ name, expiresOn, monthlyLink, annualLink }) {
  const subject = `Your Autopilot access ends ${expiresOn || 'soon'}`;
  const links = [monthlyLink && `<a href="${esc(monthlyLink)}">Monthly</a>`, annualLink && `<a href="${esc(annualLink)}">Annual</a>`].filter(Boolean).join(' · ');
  const html = shell(`
    ${para(`Hi ${esc(name || 'there')},`)}
    ${para(`Your complimentary Autopilot access ends on <strong>${esc(expiresOn || 'soon')}</strong>. Nothing is deleted: after that you're on the free plan, with all your data kept.`)}
    ${para('If you want to keep Autopilot, you can subscribe any time.')}
    ${button(`${APP_URL}/pricing`, 'See Autopilot plans')}
    ${links ? para(`<span style="font-size:13px;color:#5b6478;">Or go straight to checkout: ${links}</span>`) : ''}`, marketingFooter());
  const text = `Hi ${name || 'there'},\n\nYour complimentary Autopilot access ends on ${expiresOn || 'soon'}. Nothing is deleted; after that you're on the free plan with all your data kept.\n\nKeep Autopilot: ${APP_URL}/pricing`;
  return { subject, html, text };
}

// Buddy lapse re-engagement (buddyEngagementCron.js). These were imported but
// never existed, so the Day-5/Day-14 emails could not send.
function buddyReengageDay5Template({ name }) {
  const subject = 'Buddy saved your spot';
  const html = shell(`
    ${para(`Hi ${esc(name || 'there')},`)}
    ${para('Life gets loud. Buddy is still here whenever you want a hand, with no streak to rebuild and nothing to explain.')}
    ${para('A two-minute check-in is enough to get moving again.')}
    ${button(`${APP_URL}/app/buddy`, 'Check in with Buddy')}`, marketingFooter());
  const text = `Hi ${name || 'there'},\n\nBuddy is still here whenever you want a hand, with no streak to rebuild and nothing to explain. A two-minute check-in is enough: ${APP_URL}/app/buddy`;
  return { subject, html, text };
}

function buddyReengageDay14Template({ name }) {
  const subject = "We'll keep things quiet";
  const html = shell(`
    ${para(`Hi ${esc(name || 'there')},`)}
    ${para("This is the last Buddy email for now. We'd rather not crowd your inbox.")}
    ${para('Everything stays saved. Whenever you open FocusLedger again, Buddy picks up from today, not from where you stopped.')}
    ${button(`${APP_URL}/weightless`, 'Open FocusLedger')}`, marketingFooter());
  const text = `Hi ${name || 'there'},\n\nThis is the last Buddy email for now. Everything stays saved, and whenever you come back Buddy picks up from today.\n\n${APP_URL}/weightless`;
  return { subject, html, text };
}

module.exports = {
  welcomeTemplate,
  passwordResetTemplate,
  passwordResetGoogleOnlyTemplate,
  accountDeletionTemplate,
  proWelcomeTemplate,
  v2LaunchTemplate,
  weeklyNudgeTemplate,
  reEngagementTemplate,
  proExpiryReminderTemplate,
  buddyReengageDay5Template,
  buddyReengageDay14Template,
};

// Shared layout for templates that live elsewhere (lib/tandem-recap.js).
module.exports._layout = { shell, button, esc, marketingFooter, APP_URL };
