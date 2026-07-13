'use strict';
/**
 * migration-integrity.test.js — structural guard for the migration runner.
 *
 * migrate.js loads every migrations/*.js and calls `up(client)` inside a
 * transaction. A migration missing `name`, exporting `up` as a non-function,
 * or colliding on `name` with another migration corrupts the run — and we've
 * been bitten repeatedly by migration-layer breakage. This asserts the shape
 * statically (no DB), so a malformed migration fails CI instead of the runner.
 */
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'migrations');
const files = fs.existsSync(MIG_DIR)
  ? fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.js')).sort()
  : [];

describe('migration integrity', () => {
  test('migrations directory has files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s exports { name:string, up:function }', (file) => {
    const mod = require(path.join(MIG_DIR, file));
    expect(mod).toBeTruthy();
    expect(typeof mod.name).toBe('string');
    expect(mod.name.trim().length).toBeGreaterThan(0);
    expect(typeof mod.up).toBe('function');
    // down is optional but, when present, must be callable (rollback path).
    if (mod.down !== undefined) expect(typeof mod.down).toBe('function');
  });

  test('migration names are unique (runner dedups on name)', () => {
    const names = files.map(f => require(path.join(MIG_DIR, f)).name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});
