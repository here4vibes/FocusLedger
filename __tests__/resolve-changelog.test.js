const fs = require('fs');
const path = require('path');
const { resolveChangelog, parse, monthRank } = require('../scripts/resolve-changelog');

const entry = (title, day = '18', mon = 'Oct') => `<div class="entry">
                <div class="entry-date">
                    <span class="entry-day">${day}</span>
                    <span class="entry-month">${mon}</span>
                </div>
                <div class="entry-body">
                    <div class="entry-title">${title}</div>
                    <div class="entry-desc">About ${title}.</div>
                </div>
            </div>`;

const group = (label, entries) => `    <!-- ${label} -->
    <div class="month-group">
        <div class="month-label">${label}</div>
        <div class="changelog-list">

            ${entries.join('\n            ')}

        </div>
    </div>
`;

const page = (groups) => `<html><body><main class="content-wrap">\n\n${groups.join('\n')}\n</main></body></html>\n`;

const titles = (html) => parse(html).map((g) => [g.label, g.entries.map((e) => e.key)]);

describe('resolve-changelog', () => {
  test('re-inserts branch-only entries at the top of their month, in branch order', () => {
    const main = page([group('October 2026', [entry('Main new'), entry('Shared')]), group('September 2026', [entry('Old', '09', 'Sep')])]);
    const branch = page([group('October 2026', [entry('Branch A'), entry('Branch B'), entry('Shared')]), group('September 2026', [entry('Old', '09', 'Sep')])]);
    const out = resolveChangelog(main, branch);
    expect(titles(out)).toEqual([
      ['October 2026', ['branch a', 'branch b', 'main new', 'shared']],
      ['September 2026', ['old']],
    ]);
  });

  test('keeps main text for an entry both sides have, even if the branch edited it', () => {
    const main = page([group('October 2026', [entry('Shared')])]);
    const branch = page([group('October 2026', [entry('Shared').replace('About Shared.', 'Edited.')])]);
    expect(resolveChangelog(main, branch)).toBe(main);
  });

  test('no branch-only entries returns main unchanged', () => {
    const main = page([group('October 2026', [entry('A'), entry('B')])]);
    const branch = page([group('October 2026', [entry('A')])]);
    expect(resolveChangelog(main, branch)).toBe(main);
  });

  test('a month main lacks gets a new group placed by date', () => {
    const main = page([group('October 2026', [entry('Oct thing')]), group('July 2026', [entry('Jul thing', '01', 'Jul')])]);
    const branch = page([group('September 2026', [entry('Sep thing', '09', 'Sep')]), group('July 2026', [entry('Jul thing', '01', 'Jul')])]);
    const out = resolveChangelog(main, branch);
    expect(titles(out).map((g) => g[0])).toEqual(['October 2026', 'September 2026', 'July 2026']);
    expect(titles(out)[1][1]).toEqual(['sep thing']);
  });

  test('a newer month than any in main goes first', () => {
    const main = page([group('October 2026', [entry('Oct thing')])]);
    const branch = page([group('November 2026', [entry('Nov thing', '02', 'Nov')]), group('October 2026', [entry('Oct thing')])]);
    expect(titles(resolveChangelog(main, branch)).map((g) => g[0])).toEqual(['November 2026', 'October 2026']);
  });

  test('works on the real changelog: an added entry lands first and nothing else changes', () => {
    const real = fs.readFileSync(path.join(__dirname, '..', 'public', 'changelog.html'), 'utf8');
    const first = parse(real)[0];
    const firstEntry = first.entries[0];
    const branch = real.slice(0, firstEntry.offset) + entry('Brand new branch entry') + '\n            ' + real.slice(firstEntry.offset);
    const out = resolveChangelog(real, branch);
    expect(out).toBe(branch);
    expect(parse(out)[0].entries[0].key).toBe('brand new branch entry');
  });

  test('monthRank orders labels', () => {
    expect(monthRank('October 2026')).toBeGreaterThan(monthRank('September 2026'));
    expect(monthRank('January 2027')).toBeGreaterThan(monthRank('December 2026'));
    expect(monthRank('Someday')).toBe(-1);
  });
});
