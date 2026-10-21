'use strict';
/**
 * lib/email-mjml/sources.js — MJML sources for the transactional emails.
 *
 * These are compiled to HTML at build time by `npm run build:emails`
 * (scripts/build-emails.js) into lib/email-mjml/compiled/<name>.html, which is
 * committed. Runtime never loads mjml: lib/email-mjml/index.js reads the
 * compiled HTML once and fills the {{token}} placeholders with escaped values.
 * __tests__/email-mjml.test.js fails CI if a compiled file is stale.
 *
 * Tokens: {{appUrl}} is always available; each template lists its own. Only
 * put tokens in text or attribute values, never inside a tag name or CSS.
 */

const BRAND_NAVY = '#0c1b40';
const BRAND_ACCENT = '#2f6df0';
const FONT = '-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

/**
 * Shared layout: navy header, white card body, optional small footer
 * (marketing emails put the opt-out line and postal address there).
 * @param {string} body    MJML for the card (mj-text / mj-button elements)
 * @param {object} [opts]
 * @param {string} [opts.footer] inner HTML for the footer mj-text
 */
function layout(body, { footer = '' } = {}) {
  return `<mjml>
  <mj-head>
    <mj-title>FocusLedger</mj-title>
    <mj-attributes>
      <mj-all font-family="${FONT}" />
      <mj-text font-size="15px" line-height="1.6" color="#1c2540" padding="0 0 14px 0" />
      <mj-button background-color="${BRAND_ACCENT}" color="#ffffff" font-size="15px" font-weight="600" border-radius="10px" inner-padding="13px 26px" align="left" padding="8px 0 22px 0" />
    </mj-attributes>
    <mj-style inline="inline">
      a { color: ${BRAND_ACCENT}; }
    </mj-style>
  </mj-head>
  <mj-body width="520px" background-color="#f4f6fb">
    <mj-wrapper padding="24px 12px">
      <mj-section background-color="${BRAND_NAVY}" padding="22px 28px" border-radius="14px 14px 0 0">
        <mj-column>
          <mj-text font-size="18px" font-weight="700" color="#ffffff" letter-spacing="0.2px" padding="0">FocusLedger</mj-text>
        </mj-column>
      </mj-section>
      <mj-section padding="28px 28px ${footer ? '10px' : '24px'} 28px" background-color="#ffffff" border-radius="${footer ? '0' : '0 0 14px 14px'}">
        <mj-column>
${body}
        </mj-column>
      </mj-section>${footer ? `
      <mj-section padding="0 28px 24px 28px" background-color="#ffffff" border-radius="0 0 14px 14px">
        <mj-column>
          <mj-text font-size="12px" line-height="1.5" color="#8a92a6" padding="0">${footer}</mj-text>
        </mj-column>
      </mj-section>` : ''}
    </mj-wrapper>
  </mj-body>
</mjml>
`;
}

const p = (html) => `          <mj-text>${html}</mj-text>`;
const pLast = (html) => `          <mj-text padding="0">${html}</mj-text>`;
const muted = (html) => `          <mj-text color="#8a92a6" font-size="13px" padding="0">${html}</mj-text>`;
const button = (href, label) => `          <mj-button href="${href}">${label}</mj-button>`;

// name -> { tokens, mjml }. Copy must match the plain-text versions in
// lib/emailTemplates.js; only the HTML structure lives here.
const SOURCES = {
  welcome: {
    tokens: ['name', 'appUrl'],
    mjml: layout([
      p('Hi {{name}},'),
      p('Welcome to FocusLedger — your ADHD-native command center for tasks, money, and momentum, all in one tab.'),
      p("Here's the fastest way to feel the difference: open the app, dump whatever's on your mind, and let Buddy help you sort it into a plan."),
      button('{{appUrl}}/app', 'Open FocusLedger'),
      pLast("We built this for brains like ours. Glad you're here."),
    ].join('\n')),
  },

  passwordReset: {
    tokens: ['name', 'resetUrl'],
    mjml: layout([
      p('Hi {{name}},'),
      p('We got a request to reset your FocusLedger password. Tap the button below to choose a new one. This link expires in 1 hour.'),
      button('{{resetUrl}}', 'Reset password'),
      muted("If you didn't ask for this, you can safely ignore this email — your password won't change."),
    ].join('\n')),
  },

  passwordResetGoogleOnly: {
    tokens: ['name', 'appUrl'],
    mjml: layout([
      p('Hi {{name}},'),
      p("You asked to reset your password, but your FocusLedger account signs in with <strong>Google</strong> — there's no password to reset."),
      p('Just use "Continue with Google" on the sign-in page and you\'re in.'),
      button('{{appUrl}}/login', 'Go to sign in'),
    ].join('\n')),
  },

  accountDeletion: {
    tokens: ['confirmUrl'],
    mjml: layout([
      p('We received a request to permanently delete your FocusLedger account.'),
      p('<strong>This cannot be undone.</strong> All your tasks, money data, and history will be erased. To confirm, tap below within 24 hours.'),
      button('{{confirmUrl}}', 'Confirm deletion'),
      muted("If you didn't request this, do nothing — your account stays exactly as it is, and this link will expire."),
    ].join('\n')),
  },

  proWelcome: {
    tokens: ['name', 'cycle', 'appUrl'],
    mjml: layout([
      p('Hi {{name}},'),
      p("Your {{cycle}} FocusLedger Autopilot plan is active. Thank you for backing what we're building."),
      p("You've unlocked the full toolkit — bank sync, AI task breakdown, document extraction, and the whole Buddy coaching layer."),
      button('{{appUrl}}/app', 'Jump back in'),
      pLast('Reply to this email any time — a real person (with ADHD) reads it.'),
    ].join('\n')),
  },
};

module.exports = { SOURCES, layout };
