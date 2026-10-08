'use strict';

const { loadMigrations, expectedMigrationNames } = require('../lib/migration-manifest');
const { getMigrationStatus } = require('../db/migrations-status');

describe('migration manifest', () => {
  test('every migration has a unique recorded name', () => {
    // Two files sharing a name means the second one silently never runs —
    // migrate.js would treat it as already applied.
    const names = loadMigrations().map(m => m.name);
    const dups = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dups).toEqual([]);
  });

  test('every migration exports an up() function', () => {
    const bad = loadMigrations().filter(m => typeof m.migration.up !== 'function').map(m => m.file);
    expect(bad).toEqual([]);
  });

  test('loads in lexicographic filename order', () => {
    const files = loadMigrations().map(m => m.file);
    expect(files).toEqual([...files].sort());
  });
});

describe('getMigrationStatus', () => {
  const expected = expectedMigrationNames();

  test('up_to_date when every expected name is recorded (legacy extras allowed)', async () => {
    const rows = [
      ...expected.map(name => ({ name, applied_at: new Date('2026-05-01T00:00:00Z') })),
      { name: 'some_legacy_name', applied_at: new Date('2026-05-27T03:13:06Z') },
    ];
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    const s = await getMigrationStatus(pool);
    expect(s.up_to_date).toBe(true);
    expect(s.pending).toEqual([]);
    expect(s.applied).toBe(expected.length);
    expect(s.recorded_total).toBe(expected.length + 1);
    expect(s.last_recorded_at).toBe('2026-05-27T03:13:06.000Z');
  });

  test('lists pending names when some are missing', async () => {
    const rows = expected.slice(0, -2).map(name => ({ name, applied_at: new Date() }));
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    const s = await getMigrationStatus(pool);
    expect(s.up_to_date).toBe(false);
    expect(s.pending).toEqual(expected.slice(-2));
    expect(s.applied).toBe(expected.length - 2);
  });

  test('fresh DB (no _migrations table) reports everything pending', async () => {
    const err = Object.assign(new Error('relation "_migrations" does not exist'), { code: '42P01' });
    const pool = { query: jest.fn().mockRejectedValue(err) };
    const s = await getMigrationStatus(pool);
    expect(s.up_to_date).toBe(false);
    expect(s.pending).toHaveLength(expected.length);
  });

  test('unexpected DB errors are thrown, not swallowed', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('connection reset')) };
    await expect(getMigrationStatus(pool)).rejects.toThrow('connection reset');
  });
});
