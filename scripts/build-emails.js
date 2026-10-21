#!/usr/bin/env node
'use strict';
/**
 * scripts/build-emails.js — compile lib/email-mjml/sources.js to HTML.
 *
 *   npm run build:emails
 *
 * Writes lib/email-mjml/compiled/<name>.html (committed). Run it after editing
 * an MJML source; __tests__/email-mjml.test.js fails CI when the committed
 * HTML is stale. mjml is a devDependency: production only reads the output.
 */

const fs = require('fs');
const path = require('path');
const { SOURCES } = require('../lib/email-mjml/sources');

const OUT_DIR = path.join(__dirname, '..', 'lib', 'email-mjml', 'compiled');

// fonts: {} stops mjml from adding a Google Fonts link (we use system fonts).
// Returns { name: html }. Throws on any MJML validation error so a broken
// template can never be written.
async function compileAll() {
  const mjml2html = require('mjml');
  const out = {};
  for (const [name, { mjml }] of Object.entries(SOURCES)) {
    const result = await mjml2html(mjml, { validationLevel: 'strict', minify: false, keepComments: false, fonts: {} });
    if (result.errors && result.errors.length) {
      throw new Error(`[build-emails] ${name}: ${result.errors.map(e => e.formattedMessage || e.message).join('; ')}`);
    }
    out[name] = result.html.trim() + '\n';
  }
  return out;
}

async function main() {
  const started = Date.now();
  const compiled = await compileAll();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, html] of Object.entries(compiled)) {
    fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), html);
  }
  console.log(`[build-emails] compiled ${Object.keys(compiled).length} templates in ${Date.now() - started}ms`);
}

if (require.main === module) {
  main().catch(e => { console.error('[build-emails] failed:', e.message); process.exit(1); });
}

module.exports = { compileAll, OUT_DIR };
