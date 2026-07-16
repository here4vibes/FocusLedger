'use strict';
/**
 * schema-audit.js — cross-reference code SQL against the real prod schema.
 * Finds DRIFT: columns the code references on a table that exists in prod but
 * that lacks the column (the phantom-column crash source). Scoped to SQL blobs
 * (backtick/quoted strings containing SQL) so JS property access never leaks in.
 */
const fs = require('fs');
const path = require('path');

const CSV = process.argv[2];
const ROOT = process.argv[3] || '.';

// ── Load prod schema: table -> Set(columns) ──────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur); return out;
}
const csvRows = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
const schema = new Map(); // table -> Set(col)
for (let r = 1; r < csvRows.length; r++) {
  const f = parseCsvLine(csvRows[r]);
  const t = f[0], col = f[2];
  if (!schema.has(t)) schema.set(t, new Set());
  schema.get(t).add(col);
}

// ── Collect code files ───────────────────────────────────────────────────────
const DIRS = ['db', 'routes', 'jobs', 'lib', 'services'];
const files = [];
for (const d of DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) continue;
  for (const n of fs.readdirSync(abs)) if (n.endsWith('.js')) files.push(path.join(abs, n));
}
// root-level job files
for (const n of fs.readdirSync(ROOT)) if (/Nudge|Reveal|Job|Check|nudge/.test(n) && n.endsWith('.js')) files.push(path.join(ROOT, n));

// ── Extract SQL blobs (backtick + quoted strings that look like SQL) ──────────
function extractSqlBlobs(src) {
  const blobs = [];
  // backtick template literals
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const s = m[1];
    if (/\b(from|into|update|join|set)\b/i.test(s) && /\b(select|insert|update|delete)\b/i.test(s)) blobs.push(s);
  }
  // single/double quoted single-line SQL
  for (const m of src.matchAll(/['"]([^'"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^'"]*)['"]/gi)) {
    const s = m[1];
    if (/\b(from|into|update)\b/i.test(s)) blobs.push(s);
  }
  return blobs;
}

// SQL reserved words that appear as alias.column-like tokens but aren't columns
const findings = [];
const known = new Set(schema.keys());

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (let blob of extractSqlBlobs(src)) {
    blob = blob.replace(/\$\{[^}]*\}/g, ' '); // strip JS interpolation
    const lower = blob;

    // alias map: FROM/JOIN <table> [AS] <alias>
    const alias = new Map();
    for (const m of lower.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\s+(?:as\s+)?([a-z_][a-z0-9_]*)?/gi)) {
      const table = m[1].toLowerCase();
      const al = (m[2] || table).toLowerCase();
      // skip when the "alias" is actually a SQL keyword (e.g., FROM x WHERE)
      if (/^(where|group|order|limit|on|left|right|inner|outer|join|using|set|returning|as)$/.test(al)) {
        alias.set(table, table);
      } else {
        alias.set(al, table);
      }
    }

    // qualified refs: alias.column
    for (const m of blob.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
      const al = m[1].toLowerCase(), col = m[2].toLowerCase();
      const table = alias.get(al);
      if (!table || !known.has(table)) continue;      // unknown alias/CTE/system → skip
      if (!schema.get(table).has(col)) {
        findings.push({ file: path.relative(ROOT, file), table, col, kind: 'ref' });
      }
    }

    // INSERT INTO table (col, col, ...)
    for (const m of blob.matchAll(/insert\s+into\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
      const table = m[1].toLowerCase();
      if (!known.has(table)) continue;
      for (let col of m[2].split(',')) {
        col = col.trim().toLowerCase().replace(/["`]/g, '');
        if (!col || /[^a-z0-9_]/.test(col)) continue;  // skip expressions
        if (!schema.get(table).has(col)) {
          findings.push({ file: path.relative(ROOT, file), table, col, kind: 'insert' });
        }
      }
    }
  }
}

// ── Dedup + report ───────────────────────────────────────────────────────────
const seen = new Set(), uniq = [];
for (const f of findings) {
  const k = `${f.table}.${f.col}|${f.file}|${f.kind}`;
  if (seen.has(k)) continue; seen.add(k); uniq.push(f);
}
uniq.sort((a, b) => (a.table + a.col).localeCompare(b.table + b.col));

console.log(`\n=== SCHEMA DRIFT: code references a column prod's table lacks (${uniq.length}) ===\n`);
const byCol = new Map();
for (const f of uniq) {
  const k = `${f.table}.${f.col}`;
  if (!byCol.has(k)) byCol.set(k, []);
  byCol.get(k).push(`${f.file} (${f.kind})`);
}
for (const [k, locs] of [...byCol].sort()) {
  console.log(`  ${k}`);
  for (const l of [...new Set(locs)]) console.log(`      ${l}`);
}
console.log(`\n${byCol.size} distinct (table.column) drift candidates across ${uniq.length} sites.`);
