'use strict';
const { habitStrength, strengthForRoutine, DAILY_HALF_LIFE_DAYS } = require('../lib/habit-strength');

const DAY = 24 * 60 * 60 * 1000;
function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}
/** Every day from start for n days. */
function run(start, n) {
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}
function range(from, to, step = 1) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, step)) out.push(d);
  return out;
}

describe('habitStrength (daily)', () => {
  const start = '2026-01-01';

  test('no completions is 0', () => {
    expect(habitStrength({ completions: [], today: '2026-03-01', startDate: start })).toBe(0);
  });

  test('consistent completion climbs high', () => {
    const days = run(start, 90);
    expect(habitStrength({ completions: days, today: days[89], startDate: start })).toBeGreaterThanOrEqual(98);
    // Builds gradually: a month in is solid but not maxed.
    const month = habitStrength({ completions: days.slice(0, 30), today: days[29], startDate: start });
    expect(month).toBeGreaterThan(70);
    expect(month).toBeLessThan(85);
  });

  test('one miss after a long run barely dips', () => {
    const days = run(start, 90);
    const before = habitStrength({ completions: days, today: days[89], startDate: start });
    // Day index 90 missed; today is index 91, not done yet (in progress).
    const after = habitStrength({ completions: days, today: addDays(start, 91), startDate: start });
    expect(before - after).toBeGreaterThan(0);
    expect(before - after).toBeLessThanOrEqual(6);
    // Doing it the next day starts climbing back (by a fraction of a point near the top).
    const recovered = habitStrength({ completions: [...days, addDays(start, 91)], today: addDays(start, 91), startDate: start });
    expect(recovered).toBeGreaterThanOrEqual(after);
    // A month of misses later, one completion is clearly visible.
    const lowAfter = habitStrength({ completions: days, today: addDays(start, 120), startDate: start });
    const lowRecovered = habitStrength({ completions: [...days, addDays(start, 120)], today: addDays(start, 120), startDate: start });
    expect(lowRecovered).toBeGreaterThan(lowAfter);
  });

  test('the in-progress day does not count as a miss', () => {
    const days = run(start, 60);
    const doneToday = habitStrength({ completions: days, today: days[59], startDate: start });
    const notYet = habitStrength({ completions: days.slice(0, 59), today: days[59], startDate: start });
    expect(notYet).toBeLessThanOrEqual(doneToday);
    expect(doneToday - notYet).toBeLessThanOrEqual(2);
  });

  test('a long gap decays gradually, not to zero at once', () => {
    const days = run(start, 90);
    const twoWeeksOff = habitStrength({ completions: days, today: addDays(start, 90 + DAILY_HALF_LIFE_DAYS), startDate: start });
    expect(twoWeeksOff).toBeGreaterThanOrEqual(46);
    expect(twoWeeksOff).toBeLessThanOrEqual(52); // half-life: about half after 14 days off
    const twoMonthsOff = habitStrength({ completions: days, today: addDays(start, 150), startDate: start });
    expect(twoMonthsOff).toBeLessThan(10);
    expect(twoMonthsOff).toBeGreaterThan(0);
  });

  test('a streak reset is not a strength reset', () => {
    // Every other day for 60 days: never more than a 1-day streak, but a real habit.
    const days = run(start, 60).filter((_, i) => i % 2 === 0);
    const s = habitStrength({ completions: days, today: addDays(start, 60), startDate: start });
    expect(s).toBeGreaterThan(40);
    expect(s).toBeLessThan(60);
  });

  test('history starts at the first completion when no start date is given; future dates ignored', () => {
    expect(habitStrength({ completions: ['2026-01-05'], today: '2026-01-05' })).toBe(5);
    expect(habitStrength({ completions: ['2026-02-01'], today: '2026-01-05' })).toBe(0);
  });

  test('bad input is safe', () => {
    expect(habitStrength({ completions: ['nope', null], today: '2026-01-05' })).toBe(0);
    expect(habitStrength({ completions: ['2026-01-01'], today: 'garbage' })).toBe(0);
    expect(habitStrength()).toBe(0);
  });

  test('accepts Date objects the way node-postgres returns DATE columns (local midnight)', () => {
    const d = new Date(2026, 0, 5);
    expect(habitStrength({ completions: [d], today: '2026-01-05' })).toBe(5);
  });
});

describe('habitStrength (weekly)', () => {
  const start = '2026-01-01';
  const weeks = n => Array.from({ length: n }, (_, i) => addDays(start, i * 7 + 2));

  test('once a week counts as fully consistent', () => {
    const done = weeks(26);
    const s = habitStrength({ completions: done, today: done[25], startDate: start, cadence: 'weekly' });
    expect(s).toBeGreaterThanOrEqual(98);
    // The same dates scored per day would look like a weak habit.
    expect(habitStrength({ completions: done, today: done[25], startDate: start })).toBeLessThan(25);
  });

  test('several completions in one week count once', () => {
    const once = habitStrength({ completions: [addDays(start, 1)], today: addDays(start, 6), startDate: start, cadence: 'weekly' });
    const thrice = habitStrength({ completions: [start, addDays(start, 1), addDays(start, 2)], today: addDays(start, 6), startDate: start, cadence: 'weekly' });
    expect(thrice).toBe(once);
  });

  test('the current week is in progress until done; one missed week dips gently', () => {
    const done = weeks(26);
    const full = habitStrength({ completions: done, today: done[25], startDate: start, cadence: 'weekly' });
    // Later in week 26 (index 25), and into week index 26 before doing it: unchanged.
    const nextWeek = habitStrength({ completions: done, today: addDays(start, 26 * 7 + 3), startDate: start, cadence: 'weekly' });
    expect(nextWeek).toBe(full);
    // Week index 26 missed entirely, now in week index 27: one period of decay.
    const missed = habitStrength({ completions: done, today: addDays(start, 27 * 7 + 1), startDate: start, cadence: 'weekly' });
    expect(full - missed).toBeGreaterThan(5);
    expect(full - missed).toBeLessThanOrEqual(20);
  });
});

describe('strengthForRoutine (timezone)', () => {
  test("uses the user's local date, not UTC", () => {
    // 03:00 UTC on Oct 21 is still Oct 20 in Los Angeles, already Oct 21 noon in Tokyo.
    const now = new Date('2026-10-21T03:00:00Z');
    const createdAt = new Date('2026-08-01T16:00:00Z');
    const completions = range('2026-08-01', '2026-10-20');

    const la = strengthForRoutine({ completions, createdAt, routineType: 'am', tz: 'America/Los_Angeles', now });
    expect(la).toBeGreaterThanOrEqual(97); // "today" is Oct 20 and it's done

    // Tokyo's Oct 21 is in progress, so nothing is missed there either.
    const tokyo = strengthForRoutine({ completions, createdAt, routineType: 'am', tz: 'Asia/Tokyo', now });
    expect(tokyo).toBe(la);

    // Two days later in LA, Oct 21 was missed: a small dip, not a reset.
    const later = strengthForRoutine({ completions, createdAt, routineType: 'am', tz: 'America/Los_Angeles', now: new Date('2026-10-23T03:00:00Z') });
    expect(later).toBeLessThan(la);
    expect(later).toBeGreaterThan(85);
  });

  test('evening in LA: a UTC clock would count the local "today" as already missed', () => {
    const createdAt = '2026-09-01T16:00:00Z';
    const completions = range('2026-09-01', '2026-09-30');
    const now = new Date('2026-10-02T05:00:00Z'); // Oct 1, 22:00 in LA; Oct 2 in UTC
    const la = strengthForRoutine({ completions, createdAt, routineType: 'pm', tz: 'America/Los_Angeles', now });
    const utc = strengthForRoutine({ completions, createdAt, routineType: 'pm', tz: 'UTC', now });
    expect(utc).toBeLessThan(la);
  });

  test('weekly routine type uses weekly periods', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    const createdAt = '2026-05-01T12:00:00Z';
    const completions = range('2026-05-02', '2026-10-20', 7);
    expect(strengthForRoutine({ completions, createdAt, routineType: 'weekly', tz: 'UTC', now })).toBeGreaterThanOrEqual(95);
    expect(strengthForRoutine({ completions, createdAt, routineType: 'am', tz: 'UTC', now })).toBeLessThan(25);
  });
});
