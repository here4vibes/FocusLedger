/**
 * Guards CLAUDE.md's "No silent failures" rule in server code: no catch block
 * whose body is empty or only comments, and no `.catch(() => {})`-style
 * swallow. Use the canonical console.error pattern or lib/log-failure.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['routes', 'db', 'lib', 'jobs', 'services', 'middleware'];
const FILES = ['server.js'];

// Deliberate exceptions, each with a reason. Keep this list short.
const ALLOWED = [
  // Invalid or expired token while touching last_active_at: normal traffic,
  // and authenticateToken rejects it downstream. Logging it would flood Sentry.
  { file: 'server.js', contains: 'Invalid token' },
  // Parsing an error response body; the next line throws with what it found.
  { file: 'routes/google-calendar.js', contains: 'evRes.json().catch' },
];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{((?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*)\}/g;
// `.catch(() => ({ rows: [] }))`: a failed query that quietly becomes zeros.
const OBJ_SWALLOW = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\(\s*\{/g;
const SWALLOW = /\.catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*(\{(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\}|null|undefined|\[\]|\{\}|false|0)\s*\)/g;

test('server code has no silent catch blocks', () => {
  const files = [
    ...DIRS.flatMap((d) => walk(path.join(ROOT, d), [])),
    ...FILES.map((f) => path.join(ROOT, f)),
  ];
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const src = fs.readFileSync(f, 'utf8');
    for (const re of [EMPTY_CATCH, SWALLOW, OBJ_SWALLOW]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        const text = m[0] + src.split('\n')[line - 1];
        if (ALLOWED.some((a) => a.file === rel && text.includes(a.contains))) continue;
        offenders.push(`${rel}:${line}  ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
