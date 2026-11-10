#!/usr/bin/env node
/**
 * Resolve a public/changelog.html merge conflict the house way: take main's
 * file and re-insert the branch's own entries at the top of their month.
 *
 * "Branch entries" = entries in the branch's version whose title does not
 * appear in main's version. They keep their branch order and go to the top of
 * the matching month group in main; a month main doesn't have yet gets a new
 * group, placed by date.
 *
 * Usage:
 *   node scripts/resolve-changelog.js --git
 *       During `git merge main` on a PR branch (conflict in changelog.html):
 *       main = stage 3 (theirs), branch = stage 2 (ours). Writes the result to
 *       public/changelog.html; then `git add public/changelog.html`.
 *   node scripts/resolve-changelog.js --git --main-stage 2
 *       The other direction (a merge where main is "ours").
 *   node scripts/resolve-changelog.js <main.html> <branch.html> [out.html]
 *       Plain files; prints to stdout when no out path is given.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ENTRY_OPEN = '<div class="entry">';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** Index just past the </div> that closes the <div ...> starting at `start`. */
function matchDiv(html, start) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error(`unbalanced <div> at offset ${start}`);
}

const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** Month groups (label + span) and their entries (title key + raw html). */
function parse(html) {
  const groups = [];
  const re = /<div class="month-group">/g;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index;
    const end = matchDiv(html, start);
    const body = html.slice(start, end);
    const label = clean((body.match(/<div class="month-label">([\s\S]*?)<\/div>/) || [, ''])[1]);
    const entries = [];
    let i = body.indexOf(ENTRY_OPEN);
    while (i !== -1) {
      const e = matchDiv(body, i);
      const raw = body.slice(i, e);
      const title = (raw.match(/<div class="entry-title">([\s\S]*?)<\/div>/) || [, ''])[1];
      entries.push({ key: clean(title).toLowerCase() || clean(raw), raw, offset: start + i });
      i = body.indexOf(ENTRY_OPEN, e);
    }
    groups.push({ label, start, end, entries });
    re.lastIndex = end;
  }
  return groups;
}

/** "October 2026" -> 202609 (sortable); unknown labels sort last. */
function monthRank(label) {
  const [mon, year] = label.toLowerCase().split(/\s+/);
  const i = MONTHS.indexOf(mon);
  return i === -1 || !/^\d{4}$/.test(year || '') ? -1 : Number(year) * 100 + i;
}

function resolveChangelog(mainHtml, branchHtml) {
  const mainGroups = parse(mainHtml);
  const mainKeys = new Set(mainGroups.flatMap((g) => g.entries.map((e) => e.key)));

  // Branch-only entries, grouped by month label, branch order kept.
  const additions = new Map();
  for (const g of parse(branchHtml)) {
    for (const e of g.entries) {
      if (mainKeys.has(e.key)) continue;
      if (!additions.has(g.label)) additions.set(g.label, []);
      additions.get(g.label).push(e.raw);
    }
  }
  if (additions.size === 0) return mainHtml;

  // Collect insertions as [offset, text], apply from the end backwards.
  const inserts = [];
  const indent = '\n            ';
  for (const [label, raws] of additions) {
    const group = mainGroups.find((g) => g.label === label);
    if (group) {
      if (group.entries.length) {
        inserts.push([group.entries[0].offset, raws.join(indent) + indent]);
      } else {
        const listOpen = mainHtml.indexOf('<div class="changelog-list">', group.start);
        const at = listOpen + '<div class="changelog-list">'.length;
        inserts.push([at, '\n' + indent + raws.join(indent) + '\n']);
      }
      continue;
    }
    const block =
      `<!-- ${label} -->\n    <div class="month-group">\n        <div class="month-label">${label}</div>\n` +
      `        <div class="changelog-list">\n${indent}${raws.join(indent)}\n\n        </div>\n    </div>\n\n    `;
    const rank = monthRank(label);
    const older = mainGroups.find((g) => monthRank(g.label) < rank);
    if (older) {
      // Before the older group's "<!-- Month YYYY -->" comment, if it has one.
      const before = mainHtml.slice(0, older.start);
      const comment = before.match(/<!--[^>]*-->\s*$/);
      inserts.push([comment ? older.start - comment[0].length : older.start, block]);
    } else if (mainGroups.length) {
      const last = mainGroups[mainGroups.length - 1];
      inserts.push([last.end, '\n\n    ' + block.trimEnd()]);
    } else {
      throw new Error('main changelog has no month groups');
    }
  }
  inserts.sort((a, b) => b[0] - a[0]);
  let out = mainHtml;
  for (const [at, text] of inserts) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

function main(argv) {
  const file = 'public/changelog.html';
  if (argv.includes('--git')) {
    const si = argv.indexOf('--main-stage');
    const mainStage = si !== -1 ? argv[si + 1] : '3';
    if (!['2', '3'].includes(mainStage)) throw new Error('--main-stage must be 2 or 3');
    const branchStage = mainStage === '3' ? '2' : '3';
    const show = (stage) => execFileSync('git', ['show', `:${stage}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const out = resolveChangelog(show(mainStage), show(branchStage));
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(root, file), out);
    console.log(`[resolve-changelog] wrote ${file}; review it, then: git add ${file}`);
    return;
  }
  const [mainPath, branchPath, outPath] = argv.filter((a) => !a.startsWith('--'));
  if (!mainPath || !branchPath) {
    console.error('usage: resolve-changelog.js --git [--main-stage 2|3] | <main.html> <branch.html> [out.html]');
    process.exit(2);
  }
  const out = resolveChangelog(fs.readFileSync(mainPath, 'utf8'), fs.readFileSync(branchPath, 'utf8'));
  if (outPath) fs.writeFileSync(outPath, out);
  else process.stdout.write(out);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error('[resolve-changelog] failed:', e.message);
    process.exit(1);
  }
}

module.exports = { resolveChangelog, parse, monthRank };
