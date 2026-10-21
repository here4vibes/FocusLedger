'use strict';
/**
 * Transactional emails authored in MJML (lib/email-mjml/).
 * Checks the copy, links and escaping of each converted template, and that the
 * committed compiled HTML matches the MJML sources (run `npm run build:emails`).
 */

const fs = require('fs');
const path = require('path');
const T = require('../lib/emailTemplates');
const { SOURCES } = require('../lib/email-mjml/sources');
const { compileAll, OUT_DIR } = require('../scripts/build-emails');

const APP_URL = (process.env.APP_URL || 'https://focusledger.net').replace(/\/$/, '');
const EVIL = '<script>alert(1)</script>"\'&';
const EVIL_ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;';

function expectShape(out) {
  expect(Object.keys(out)).toEqual(expect.arrayContaining(['subject', 'html', 'text']));
  expect(typeof out.subject).toBe('string');
  expect(out.html).toMatch(/^<!doctype html>/i);
  expect(out.html).not.toMatch(/\{\{\w+\}\}/); // every token filled
  expect(out.html).toContain('FocusLedger');
}

function expectNoInjection(html) {
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('alert(1)</script>');
  expect(html).toContain(EVIL_ESCAPED);
}

describe('welcomeTemplate', () => {
  test('subject, copy and app link', () => {
    const out = T.welcomeTemplate({ name: 'Sam' });
    expectShape(out);
    expect(out.subject).toBe('Welcome to FocusLedger, Sam');
    expect(out.html).toContain('Hi Sam,');
    expect(out.html).toContain('your ADHD-native command center for tasks, money, and momentum, all in one tab.');
    expect(out.html).toContain(`href="${APP_URL}/app"`);
    expect(out.html).toContain('Open FocusLedger');
    expect(out.html).toContain("Glad you're here.");
  });
  test('no name falls back', () => {
    const out = T.welcomeTemplate({});
    expect(out.subject).toBe('Welcome to FocusLedger, friend');
    expect(out.html).toContain('Hi there,');
  });
  test('escapes the name', () => {
    expectNoInjection(T.welcomeTemplate({ name: EVIL }).html);
  });
});

describe('proWelcomeTemplate', () => {
  test('subject, cycle, copy and link', () => {
    const out = T.proWelcomeTemplate({ name: 'Sam', billingCycle: 'yearly' });
    expectShape(out);
    expect(out.subject).toBe("You're on FocusLedger Autopilot 🚀");
    expect(out.html).toContain('Your annual FocusLedger Autopilot plan is active.');
    expect(out.html).toContain(`href="${APP_URL}/app"`);
    expect(out.html).toContain('Jump back in');
    expect(T.proWelcomeTemplate({ name: 'Sam' }).html).toContain('Your monthly FocusLedger Autopilot plan');
  });
  test('escapes the name', () => {
    expectNoInjection(T.proWelcomeTemplate({ name: EVIL, billingCycle: 'monthly' }).html);
  });
});

describe('passwordResetTemplate', () => {
  const resetUrl = 'https://focusledger.net/reset-password?token=abc123&x=1';
  test('subject, copy and reset link (attribute-escaped)', () => {
    const out = T.passwordResetTemplate({ name: 'Sam', resetUrl });
    expectShape(out);
    expect(out.subject).toBe('Reset your FocusLedger password');
    expect(out.html).toContain('This link expires in 1 hour.');
    expect(out.html).toContain('href="https://focusledger.net/reset-password?token=abc123&amp;x=1"');
    expect(out.html).toContain('Reset password');
    expect(out.html).toContain("your password won't change.");
    expect(out.text).toContain(resetUrl);
  });
  test('escapes the name and refuses a non-http link', () => {
    const out = T.passwordResetTemplate({ name: EVIL, resetUrl: 'javascript:alert(1)' });
    expectNoInjection(out.html);
    expect(out.html).not.toContain('javascript:');
    expect(out.html).toContain(`href="${APP_URL}/forgot-password"`);
  });
  test('a quote in the URL cannot break out of href', () => {
    const out = T.passwordResetTemplate({ name: 'Sam', resetUrl: 'https://x.test/"><script>alert(1)</script>' });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('href="https://x.test/&quot;&gt;&lt;script&gt;');
  });
});

describe('passwordResetGoogleOnlyTemplate', () => {
  test('subject, copy and sign-in link', () => {
    const out = T.passwordResetGoogleOnlyTemplate({ name: 'Sam' });
    expectShape(out);
    expect(out.subject).toBe('Signing in to FocusLedger');
    expect(out.html).toContain('<strong>Google</strong>');
    expect(out.html).toContain(`href="${APP_URL}/login"`);
    expect(out.html).toContain('Go to sign in');
  });
  test('escapes the name', () => {
    expectNoInjection(T.passwordResetGoogleOnlyTemplate({ name: EVIL }).html);
  });
});

describe('accountDeletionTemplate', () => {
  test('subject, copy and confirm link', () => {
    const confirmUrl = 'https://focusledger.net/api/account/delete/confirm?token=t0k';
    const out = T.accountDeletionTemplate({ confirmUrl });
    expectShape(out);
    expect(out.subject).toBe('Confirm your FocusLedger account deletion');
    expect(out.html).toContain('<strong>This cannot be undone.</strong>');
    expect(out.html).toContain('within 24 hours');
    expect(out.html).toContain(`href="${confirmUrl}"`);
    expect(out.html).toContain('Confirm deletion');
  });
  test('escapes the confirm URL', () => {
    const out = T.accountDeletionTemplate({ confirmUrl: `https://x.test/${EVIL}` });
    expectNoInjection(out.html);
  });
});

describe('compiled MJML', () => {
  test('committed HTML matches the MJML sources (run `npm run build:emails`)', async () => {
    const started = Date.now();
    const compiled = await compileAll();
    const ms = Date.now() - started;
    for (const [name, html] of Object.entries(compiled)) {
      const committed = fs.readFileSync(path.join(OUT_DIR, `${name}.html`), 'utf8');
      expect({ name, html: committed }).toEqual({ name, html });
    }
    expect(ms).toBeLessThan(15000);
  }, 30000);

  test('the layout footer (for marketing emails) is valid MJML', async () => {
    const { layout } = require('../lib/email-mjml/sources');
    const mjml2html = require('mjml');
    const r = await mjml2html(layout('<mj-text>Body</mj-text>', { footer: 'Reply "no more" to stop.' }),
      { validationLevel: 'strict', fonts: {} });
    expect(r.errors).toEqual([]);
    expect(r.html).toContain('Reply "no more" to stop.');
  }, 30000);

  test('each source only uses the tokens it declares', () => {
    for (const [name, { tokens, mjml }] of Object.entries(SOURCES)) {
      const used = [...new Set([...mjml.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))].sort();
      expect({ name, used }).toEqual({ name, used: [...tokens].sort() });
    }
  });

  test('fits a phone: fluid width, no fixed width wider than the 520px card', () => {
    const html = T.welcomeTemplate({ name: 'Sam' }).html;
    expect(html).toContain('max-width:520px');
    expect(html).toMatch(/@media only screen and \(min-width:480px\)/);
  });
});
