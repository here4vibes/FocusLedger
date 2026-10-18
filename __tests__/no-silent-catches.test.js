/**
 * Guards CLAUDE.md's "No silent failures" rule in server code.
 *
 * 1. No catch block whose body is empty or only comments, and no
 *    `.catch(() => {})`-style swallow (regex checks below).
 * 2. Every catch handler body (`catch {}` blocks and arrow/function
 *    `.catch()` handlers) must log (console.error/warn, logFailure), rethrow,
 *    forward (next(, reject(), answer 401, or carry a `// silent-ok: <reason>`
 *    marker in the body or on its first/last line. See helpers/catch-scanner.js.
 */
const fs = require('fs');
const path = require('path');
const { silentHandlers } = require('./helpers/catch-scanner');

const ROOT = path.join(__dirname, '..');
const DIRS = ['routes', 'db', 'lib', 'jobs', 'services', 'middleware'];
// Root-level modules the server, migrations or a jobs/ cron entry point load.
const FILES = [
  'server.js', 'migrate.js', 'buddyEngagementCron.js', 'emailCron.js',
  'eveningNudge.js', 'morningNudge.js', 'plaidDailySync.js', 'taskDeadlineNudge.js',
];
const MARKER = /(\/\/|\/\*)\s*silent-ok:/;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [
  ...DIRS.flatMap((d) => walk(path.join(ROOT, d), [])),
  ...FILES.map((f) => path.join(ROOT, f)),
];

const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{((?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*)\}/g;
// `.catch(() => ({ rows: [] }))`: a failed query that quietly becomes zeros.
const OBJ_SWALLOW = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\(\s*\{/g;
const SWALLOW = /\.catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*(\{(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\}|null|undefined|\[\]|\{\}|false|0)\s*\)/g;

test('server code has no empty catch blocks or swallowing .catch()', () => {
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    for (const re of [EMPTY_CATCH, SWALLOW, OBJ_SWALLOW]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        if (MARKER.test(m[0]) || MARKER.test(lines[line - 1])) continue;
        offenders.push(`${rel}:${line}  ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test('every catch handler logs, rethrows, forwards, or is marked silent-ok', () => {
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    for (const h of silentHandlers(fs.readFileSync(f, 'utf8'))) offenders.push(`${rel}:${h.line}  ${h.text}`);
  }
  expect(offenders).toEqual([]);
});

describe('catch scanner', () => {
  const bad = (src) => silentHandlers(src).length;
  test('flags a catch that only returns a fallback', () => {
    expect(bad('try { a(); } catch { return null; }')).toBe(1);
    expect(bad('p.catch((e) => { x = 1; });')).toBe(1);
    expect(bad('p.catch(async function (e) { return []; });')).toBe(1);
  });
  test('accepts logging, rethrow, forwarding and markers', () => {
    expect(bad('try { a(); } catch (e) { console.warn("[m] x", e.message); return null; }')).toBe(0);
    expect(bad('try { a(); } catch (e) { throw e; }')).toBe(0);
    expect(bad('p.catch(e => reject(e));')).toBe(0);
    expect(bad('p.catch(next); p.catch(logFailure("[m]", "op"));')).toBe(0);
    expect(bad('try { a(); } catch { // silent-ok: parse fallback\n return null; }')).toBe(0);
  });
  test('ignores braces and the word catch inside strings, templates, regexes and comments', () => {
    expect(bad('const s = "catch {"; const t = `${"}"} catch { ${x} }`; const r = /catch \{/; // catch {')).toBe(0);
    expect(bad('try { a(`}${b}`); } catch (e) { const r = /[}]/; return r; }')).toBe(1);
  });
  test('an inner logging catch does not vouch for the outer one', () => {
    expect(bad('try { a(); } catch { try { b(); } catch (e) { console.error(e); } return null; }')).toBe(1);
  });
});
