'use strict';
/**
 * Finds every catch handler in a JS source and reports the ones whose body
 * neither logs, rethrows, forwards the error nor carries a `// silent-ok:`
 * marker. No parser dependency: a small lexer masks strings, template
 * literals, comments and regex literals so braces inside them don't count.
 */

// A body passes if it contains any of these (checked on code, not strings).
const HANDLED = [/console\.error/, /console\.warn/, /\blogFailure\b/, /\bthrow\b/, /\bnext\(/, /\breject\(/, /status\(401\)/];
const MARKER = /(\/\/|\/\*)\s*silent-ok:/;

// Tokens after which a `/` starts a regex literal rather than a division.
const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** Same-length copy of src with string, template, comment and regex contents blanked. */
function mask(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  let prev = ''; // last significant char of code
  const tplStack = []; // brace depth at each open `${`
  let depth = 0;
  const n = src.length;

  function skipString(q) { // i at opening quote
    const start = i++;
    while (i < n && src[i] !== q) { if (src[i] === '\\') i++; else if (src[i] === '\n') break; i++; }
    i++;
    blank(start + 1, i - 1);
  }
  function skipTemplate() { // i just after ` or after the } closing a ${
    const start = i;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { blank(start, i); i++; return; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(start, i); i += 2; tplStack.push(depth); depth++; return; }
      i++;
    }
    blank(start, i);
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const s = i; while (i < n && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") { skipString(c); prev = 'a'; continue; }
    if (c === '`') { i++; skipTemplate(); prev = 'a'; continue; }
    if (c === '/') {
      const before = src.slice(Math.max(0, i - 12), i).trimEnd();
      if (REGEX_PREV.has(prev) || REGEX_KEYWORDS.test(before)) {
        const s = i++;
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        blank(s + 1, i);
        prev = 'a';
        continue;
      }
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (tplStack.length && tplStack[tplStack.length - 1] === depth) { tplStack.pop(); i++; skipTemplate(); prev = 'a'; continue; }
    }
    if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? 'a' : c;
    i++;
  }
  return out.join('');
}

function matchClose(m, open) { // index of the bracket matching m[open]
  const o = m[open];
  const cl = o === '{' ? '}' : o === '(' ? ')' : ']';
  let depth = 0;
  for (let k = open; k < m.length; k++) {
    if (m[k] === o) depth++;
    else if (m[k] === cl && --depth === 0) return k;
  }
  return -1;
}

/** All catch handlers: { line, start, end } where [start,end) is the handler body. */
function findHandlers(src, m = mask(src)) {
  const handlers = [];
  const re = /\bcatch\b/g;
  let x;
  while ((x = re.exec(m))) {
    const at = x.index;
    let k = at + 5;
    while (/\s/.test(m[k] || '')) k++;
    const isMethod = /\.\s*$/.test(m.slice(Math.max(0, at - 3), at));
    if (isMethod) {
      if (m[k] !== '(') continue;
      const close = matchClose(m, k);
      if (close < 0) continue;
      const arg = m.slice(k + 1, close);
      // Only arrow or function handlers have a body to inspect; a named
      // handler such as `.catch(next)` or `.catch(logFailure(...))` passes.
      if (!/^\s*(async\s+)?(function\b|\(?[\w$\s,{}]*\)?\s*=>)/.test(arg)) continue;
      handlers.push({ line: lineOf(src, at), start: k + 1, end: close, kind: 'method' });
    } else {
      if (m[k] === '(') { const c = matchClose(m, k); if (c < 0) continue; k = c + 1; while (/\s/.test(m[k] || '')) k++; }
      if (m[k] !== '{') continue;
      const close = matchClose(m, k);
      if (close < 0) continue;
      handlers.push({ line: lineOf(src, at), start: k + 1, end: close, kind: 'block' });
    }
  }
  return handlers;
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

/** Handlers in src that neither log nor forward the error. */
function silentHandlers(src) {
  const m = mask(src);
  const hs = findHandlers(src, m);
  const lines = src.split('\n');
  const bad = [];
  for (const h of hs) {
    // An inner catch handles its own error; don't let it vouch for the outer one.
    let code = m.slice(h.start, h.end);
    let orig = src.slice(h.start, h.end);
    for (const inner of hs) {
      if (inner !== h && inner.start > h.start && inner.end < h.end) {
        const a = inner.start - h.start;
        const b = inner.end - h.start;
        code = code.slice(0, a) + ' '.repeat(b - a) + code.slice(b);
        orig = orig.slice(0, a) + ' '.repeat(b - a) + orig.slice(b);
      }
    }
    const endLine = lineOf(src, h.end);
    const marked = MARKER.test(orig) || MARKER.test(lines[h.line - 1]) || MARKER.test(lines[endLine - 1]);
    if (marked || HANDLED.some((r) => r.test(code))) continue;
    bad.push({ line: h.line, text: lines[h.line - 1].trim().slice(0, 90) });
  }
  return bad;
}

module.exports = { mask, findHandlers, silentHandlers };
