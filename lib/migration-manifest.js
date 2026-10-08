'use strict';
/**
 * Migration manifest — the single source of truth for which folder migrations
 * the deployed code expects, and what each one is recorded as in _migrations.
 *
 * Used by BOTH migrate.js (to run them) and /health (to report whether they're
 * all applied), so the two can never disagree about a migration's name. That
 * disagreement is exactly what made /health look 4 months stale in Oct 2026:
 * files had been renamed, but their recorded names hadn't, and the old health
 * output (newest applied_at) read like a backlog that didn't exist.
 *
 * Name rule (must stay stable — changing it re-runs migrations):
 *   recorded name = migration.name || filename without ".js"
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Load every folder migration in run order (lexicographic by filename).
 * @returns {{ file: string, name: string, migration: { up: Function } }[]}
 */
function loadMigrations(dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(file => {
      const migration = require(path.join(dir, file));
      const name = migration.name || file.replace(/\.js$/, '');
      return { file, name, migration };
    });
}

let cachedNames = null;

/** Recorded names the deployed code expects, in run order. Cached per process. */
function expectedMigrationNames() {
  if (!cachedNames) cachedNames = loadMigrations().map(m => m.name);
  return cachedNames;
}

module.exports = { loadMigrations, expectedMigrationNames };
