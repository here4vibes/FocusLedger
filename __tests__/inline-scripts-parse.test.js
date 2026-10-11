'use strict';
/**
 * Every inline <script> in public/ must parse. One stray quote ('We'll …') or a
 * doubled line-continuation backslash kills a whole page's script silently:
 * /transactions and /reset-password were dead from July to October 2026 this way.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const SKIP_TYPES = /type\s*=\s*["'](?:application\/(?:ld\+)?json|text\/template|module|importmap)["']/i;

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return htmlFiles(p);
    return e.name.endsWith('.html') ? [p] : [];
  });
}

const cases = [];
for (const file of htmlFiles(PUBLIC)) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1], code = m[2];
    if (/\bsrc\s*=/.test(attrs) || SKIP_TYPES.test(attrs) || !code.trim()) continue;
    cases.push([`${path.relative(PUBLIC, file)} #${i++}`, code]);
  }
}

describe('inline scripts parse', () => {
  test('found inline scripts to check', () => { expect(cases.length).toBeGreaterThan(50); });
  test.each(cases)('%s', (_name, code) => {
    expect(() => new vm.Script(code)).not.toThrow();
  });
});
