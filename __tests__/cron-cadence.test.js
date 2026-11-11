'use strict';
/**
 * The cadence alarm: jobs that send at each user's local hour must be run
 * hourly, and Render Blueprint sync is off, so the live schedule can differ
 * from render.yaml. See lib/cron-cadence.js and docs/render-crons.md.
 */
const fs = require('fs');
const path = require('path');
const { checkHourlyCadence, hourlyCadence, cadenceMessage, describeGap, MAX_HOURLY_GAP_MINUTES } = require('../lib/cron-cadence');
const { recordRun } = require('../db/cron-heartbeats');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const minutesBefore = (now, m) => new Date(now.getTime() - m * 60000);
const NOW = new Date('2026-11-10T20:00:05Z');

describe('hourlyCadence', () => {
  test('first recorded run: nothing to compare, not an alarm', () => {
    expect(hourlyCadence(null, NOW)).toEqual({ ok: true, gapMinutes: null });
    expect(hourlyCadence(undefined, NOW)).toEqual({ ok: true, gapMinutes: null });
  });

  test('an hourly run, early or late by a few minutes, is fine', () => {
    expect(hourlyCadence(minutesBefore(NOW, 60), NOW)).toEqual({ ok: true, gapMinutes: 60 });
    expect(hourlyCadence(minutesBefore(NOW, 57), NOW).ok).toBe(true);
    expect(hourlyCadence(minutesBefore(NOW, 75), NOW).ok).toBe(true);
    expect(hourlyCadence(minutesBefore(NOW, MAX_HOURLY_GAP_MINUTES), NOW).ok).toBe(true);
  });

  test('a manual re-run minutes later is fine', () => {
    expect(hourlyCadence(minutesBefore(NOW, 3), NOW)).toEqual({ ok: true, gapMinutes: 3 });
  });

  test('more than 90 minutes since the previous run is an alarm', () => {
    expect(hourlyCadence(minutesBefore(NOW, 91), NOW)).toEqual({ ok: false, gapMinutes: 91 });
    expect(hourlyCadence(minutesBefore(NOW, 120), NOW)).toEqual({ ok: false, gapMinutes: 120 });   // every 2 hours
    expect(hourlyCadence(minutesBefore(NOW, 24 * 60), NOW)).toEqual({ ok: false, gapMinutes: 1440 }); // the live daily schedule
  });

  test('accepts the timestamp as a string, and ignores one it cannot read', () => {
    expect(hourlyCadence('2026-11-09T20:00:05Z', NOW)).toEqual({ ok: false, gapMinutes: 1440 });
    expect(hourlyCadence('not a date', NOW)).toEqual({ ok: true, gapMinutes: null });
  });
});

describe('the logged line', () => {
  test('says the gap in the unit a person would use', () => {
    expect(describeGap(91)).toBe('91 minutes');
    expect(describeGap(120)).toBe('2 hours');
    expect(describeGap(1440)).toBe('24 hours');
    expect(describeGap(3 * 1440)).toBe('3 days');
  });

  test('names the Render cron, the schedule to set and the doc', () => {
    const msg = cadenceMessage({ renderCron: 'evening-checkin-sender', sends: 'the evening push at evening_time', gapMinutes: 1440 });
    expect(msg).toContain('Render cron "evening-checkin-sender" is not running hourly');
    expect(msg).toContain('the previous run was 24 hours ago');
    expect(msg).toContain('0 * * * *');
    expect(msg).toContain('docs/render-crons.md');
  });
});

describe('checkHourlyCadence', () => {
  const opts = { job: 'evening-checkin', prefix: '[evening-checkin]', renderCron: 'evening-checkin-sender', sends: 'the evening push at evening_time' };
  const poolReturning = (previous, last = NOW) => ({
    query: jest.fn().mockResolvedValue({ rows: [{ previous_run_at: previous, last_run_at: last }] }),
  });
  let errorSpy;
  let logSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('records the run under the job name', async () => {
    const pool = poolReturning(minutesBefore(NOW, 60));
    await checkHourlyCadence(pool, opts);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO cron_heartbeats/);
    expect(sql).toMatch(/ON CONFLICT \(job_name\) DO UPDATE/);
    expect(sql).toMatch(/previous_run_at = cron_heartbeats\.last_run_at/);
    expect(params).toEqual(['evening-checkin']);
  });

  test('hourly: no error logged', async () => {
    const result = await checkHourlyCadence(poolReturning(minutesBefore(NOW, 60)), opts);
    expect(result).toEqual({ ok: true, gapMinutes: 60 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('daily: one loud console.error that names the cron to fix', async () => {
    const result = await checkHourlyCadence(poolReturning(minutesBefore(NOW, 1440)), opts);
    expect(result).toEqual({ ok: false, gapMinutes: 1440 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0];
    expect(line).toMatch(/^\[evening-checkin\] Render cron "evening-checkin-sender" is not running hourly/);
    expect(line).toContain('0 * * * *');
  });

  test('the gap is measured on the database clock, not this machine\'s', async () => {
    // previous and this run both come back from the same NOW() source
    const result = await checkHourlyCadence(poolReturning('2026-11-10T19:00:00Z', '2026-11-10T20:00:00Z'), opts);
    expect(result).toEqual({ ok: true, gapMinutes: 60 });
  });

  test('first run: no error, and it says cadence is checked from the next run', async () => {
    const result = await checkHourlyCadence(poolReturning(null), opts);
    expect(result).toEqual({ ok: true, gapMinutes: null });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('first recorded run'));
  });

  test('a heartbeat failure is logged and never stops the job', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('relation "cron_heartbeats" does not exist')) };
    await expect(checkHourlyCadence(pool, opts)).resolves.toEqual({ ok: true, gapMinutes: null });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[evening-checkin] cron heartbeat failed'),
      'relation "cron_heartbeats" does not exist', '| job:', 'evening-checkin');
  });
});

describe('db/cron-heartbeats recordRun', () => {
  test('returns the previous and current run times', async () => {
    const prev = new Date('2026-11-10T19:00:00Z');
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ previous_run_at: prev, last_run_at: NOW }] }) };
    await expect(recordRun(pool, 'cold-start-nudge')).resolves.toEqual({ previousRunAt: prev, thisRunAt: NOW });
  });
});

describe('the jobs, render.yaml and the doc agree', () => {
  /** name → schedule for every uncommented cron in render.yaml. */
  function renderSchedules() {
    const out = {};
    let name = null;
    for (const line of read('render.yaml').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const n = line.match(/^\s+name:\s*([\w-]+)/);
      if (n) name = n[1];
      const s = line.match(/^\s+schedule:\s*"([^"]+)"/);
      if (s && name) out[name] = s[1];
    }
    return out;
  }

  const jobs = [
    { file: 'jobs/evening-checkin.js', renderCron: 'evening-checkin-sender' },
    { file: 'jobs/coldStartNudge.js', renderCron: 'cold-start-nudge' },
  ];

  test.each(jobs)('$file checks its cadence and names Render cron $renderCron', ({ file, renderCron }) => {
    const src = read(file);
    expect(src).toMatch(/await checkHourlyCadence\(pool, \{/);
    expect(src).toContain(`renderCron: '${renderCron}'`);
  });

  test.each(jobs)('render.yaml declares $renderCron hourly and runs $file', ({ file, renderCron }) => {
    expect(renderSchedules()[renderCron]).toBe('0 * * * *');
    expect(read('render.yaml')).toContain(`startCommand: node ${file}`);
  });

  test('docs/render-crons.md has a row for every cron in render.yaml', () => {
    const doc = read('docs/render-crons.md');
    const names = Object.keys(renderSchedules());
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) expect(doc).toContain('`' + name + '`');
  });

  test('every script a render.yaml cron starts exists', () => {
    const commands = read('render.yaml').split('\n')
      .filter(l => !/^\s*#/.test(l))
      .map(l => l.match(/startCommand:\s*node\s+(\S+)/))
      .filter(Boolean)
      .map(m => m[1]);
    expect(commands.length).toBeGreaterThanOrEqual(13);
    for (const script of commands) expect(fs.existsSync(path.join(ROOT, script))).toBe(true);
  });
});
