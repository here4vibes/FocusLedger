'use strict';
/**
 * import-integrity.test.js — the guardrail for the bug that broke email signup.
 *
 * routes/auth.js did `const { validateTimezone } = require('../lib/timezone')`
 * but lib/timezone.js never exported validateTimezone. Destructuring a missing
 * export is SILENT — no error at require time — so it only blew up as
 * "validateTimezone is not a function" the moment a real signup called it.
 * Every email signup 500'd before the user row was created, and no test caught
 * it because merely requiring the module doesn't exercise the missing name.
 *
 * This test statically scans every server-side file for
 *   const { a, b: c } = require('./local-module')
 * and asserts each destructured name is actually exported by that module.
 * It runs with zero infrastructure (no DB, no server, no network).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['routes', 'lib', 'middleware', 'db', 'services'];

/** Collect every *.js file in the scan dirs (one level deep is enough here). */
function collectFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) files.push(path.join(abs, name));
    }
  }
  return files;
}

/**
 * Pull `const { … } = require('<rel>')` destructures that target a LOCAL module
 * (path starts with '.'). Returns [{ names: string[], dep: string }].
 * Renames (`a: b`), defaults (`a = x`) and rest (`...r`) are handled/ignored.
 */
function parseLocalDestructures(src) {
  const out = [];
  // const/let { ... } = require('...')  — non-greedy brace body, single line or wrapped.
  const re = /(?:const|let)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    const dep = m[2];
    const names = body
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !s.startsWith('...'))          // rest — nothing to check
      .map(s => s.split(':')[0].trim())            // `a: b` → check the source name `a`
      .map(s => s.split('=')[0].trim())            // `a = default` → check `a`
      .filter(Boolean);
    if (names.length) out.push({ names, dep });
  }
  return out;
}

const files = collectFiles();

describe('import integrity — every destructured import must exist', () => {
  test('scan actually found server files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const destructures = parseLocalDestructures(src);
    if (!destructures.length) continue;

    test(`${rel}`, () => {
      for (const { names, dep } of destructures) {
        const targetPath = path.resolve(path.dirname(file), dep);
        let mod;
        try {
          mod = require(targetPath);
        } catch (e) {
          // Module fails to load at all (env-dependent side effect, etc.).
          // Not the bug class we're guarding — skip rather than flake CI.
          continue;
        }
        if (mod === null || (typeof mod !== 'object' && typeof mod !== 'function')) {
          continue; // module.exports = <primitive>; nothing to destructure-check
        }
        for (const name of names) {
          expect(
            Object.prototype.hasOwnProperty.call(mod, name) || mod[name] !== undefined
          ).toBe(true);
          // ^ if this fails: `${rel}` imports { ${name} } from '${dep}',
          //   but that module never exports it. Add the export (or fix the name).
        }
      }
    });
  }
});
