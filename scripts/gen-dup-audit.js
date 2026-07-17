'use strict';
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || process.cwd();
const DIRS = ['db', 'routes', 'jobs', 'lib', 'services'];
const files = [];
for (const d of DIRS) { const a = path.join(ROOT, d); if (fs.existsSync(a)) for (const n of fs.readdirSync(a)) if (n.endsWith('.js')) files.push(path.join(a, n)); }
for (const n of fs.readdirSync(ROOT)) if (n.endsWith('.js')) files.push(path.join(ROOT, n));

const HAS = new Set(['buddy_checkins', 'buddy_daily_plans', 'buddy_midday_checkins', 'daily_reveals', 'detected_patterns', 'one_off_email_log']);
const seen = new Map();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /insert\s+into\s+([a-z_][a-z0-9_]*)[\s\S]{0,400}?on\s+conflict\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(s))) {
    const t = m[1].toLowerCase();
    const cols = m[2].replace(/\s+/g, '');
    if (/[^a-z0-9_,]/i.test(cols)) continue; // skip expression indexes like LOWER(email)
    seen.set(t + '|' + cols, { t, cols });
  }
}
const rows = [...seen.values()].filter(r => !HAS.has(r.t)).sort((a, b) => (a.t + a.cols).localeCompare(b.t + b.cols));

const out = [];
out.push('-- Read-only duplicate audit for the constraint remediation.');
out.push('-- For each unique the code assumes but prod lacks, counts key-groups with >1 row.');
out.push('-- dup_groups = 0  → safe to add the unique index directly.');
out.push('-- dup_groups > 0  → that table needs dedup FIRST (keeps one row per key).');
out.push('');
const parts = rows.map(r => {
  const c = r.cols.split(',').join(', ');
  return `SELECT '${r.t} (${r.cols})' AS constraint_needed, COUNT(*) AS dup_groups`
    + ` FROM (SELECT ${c} FROM ${r.t} GROUP BY ${c} HAVING COUNT(*) > 1) d`;
});
out.push(parts.join('\nUNION ALL\n') + '\nORDER BY dup_groups DESC, constraint_needed;');
out.push('');
out.push('-- Total constraints to add: ' + rows.length);
fs.writeFileSync(process.argv[3] || '/tmp/dup-audit.sql', out.join('\n'));
console.log('generated ' + rows.length + ' constraint checks');
