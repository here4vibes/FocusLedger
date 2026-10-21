'use strict';
/**
 * lib/email-mjml/index.js — fill a compiled MJML email with values.
 *
 * The HTML in ./compiled is generated at build time from ./sources.js
 * (`npm run build:emails`), so production never loads mjml. Each file is read
 * once and cached. Every value is HTML-escaped before it is substituted, and
 * URL values must be http(s) or they are replaced with the app URL.
 */

const fs = require('fs');
const path = require('path');
const { SOURCES } = require('./sources');

const COMPILED_DIR = path.join(__dirname, 'compiled');
const cache = new Map();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Links only ever point at our own http(s) pages; anything else (javascript:,
// data:, a stray relative path) falls back to the given URL.
function safeUrl(url, fallback) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : fallback;
}

function compiledHtml(name) {
  if (!cache.has(name)) {
    if (!SOURCES[name]) throw new Error(`[email-mjml] unknown template: ${name}`);
    cache.set(name, fs.readFileSync(path.join(COMPILED_DIR, `${name}.html`), 'utf8'));
  }
  return cache.get(name);
}

/**
 * @param {string} name   key of SOURCES
 * @param {object} values raw (unescaped) token values
 * @returns {string} HTML
 */
function renderEmail(name, values) {
  const html = compiledHtml(name);
  return html.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`[email-mjml] ${name}: missing value for {{${key}}}`);
    }
    return esc(values[key]);
  });
}

module.exports = { renderEmail, esc, safeUrl };
