'use strict';
/**
 * Unit tests for the Daily Reveal generation logic:
 * - buildFallbackReveal: deterministic reveal from real data (no AI)
 * - parseRevealJson: robust parsing of Haiku output
 */

const {
  buildFallbackReveal,
  parseRevealJson,
  SCIENCE_TAGS,
} = require('../jobs/dailyRevealJob');

const empty = { tasks: [], expenses: [], checkins: [], focus: [], streaks: [] };

describe('buildFallbackReveal', () => {
  test('returns null with no data at all — no hollow reveals', () => {
    expect(buildFallbackReveal(empty)).toBeNull();
  });

  test('weekday concentration wins when 3+ completions share a day', () => {
    const tasks = [
      ...Array(4).fill({ is_completed: true, completed_dow: 2, completed_date: '2026-07-07' }),
      { is_completed: true, completed_dow: 4, completed_date: '2026-07-09' },
      { is_completed: false },
    ];
    const r = buildFallbackReveal({ ...empty, tasks });
    expect(r).not.toBeNull();
    expect(r.headline).toContain('Tuesday');
    expect(r.body).toContain('80%'); // 4 of 5 completed
    expect(SCIENCE_TAGS).toContain(r.scienceTag);
  });

  test('check-in correlation reveal when 60%+ completions land on check-in days', () => {
    const tasks = [
      { is_completed: true, completed_date: '2026-07-07', completed_dow: 2 },
      { is_completed: true, completed_date: '2026-07-07', completed_dow: 2 },
      { is_completed: true, completed_date: '2026-07-08', completed_dow: 3 },
      { is_completed: true, completed_date: '2026-07-09', completed_dow: 4 },
    ];
    const checkins = [
      { checkin_date: '2026-07-07' },
      { checkin_date: '2026-07-08' },
    ];
    const r = buildFallbackReveal({ ...empty, tasks, checkins });
    expect(r).not.toBeNull();
    expect(r.scienceTag).toBe('cross_domain');
    expect(r.body).toContain('75%'); // 3 of 4 on check-in days
  });

  test('impulse-free week reveal', () => {
    const expenses = [
      ...Array(5).fill({ is_impulse: false, amount: '20.00' }),
      { is_impulse: null, amount: '10.00' },
    ];
    const r = buildFallbackReveal({ ...empty, expenses });
    expect(r).not.toBeNull();
    expect(r.scienceTag).toBe('impulse_spending');
    expect(r.body.toLowerCase()).toContain('zero');
  });

  test('focus minutes reveal at 60+ minutes', () => {
    const focus = [
      { actual_duration_seconds: 1800, completed: true },
      { actual_duration_seconds: 2400, completed: false },
    ];
    const r = buildFallbackReveal({ ...empty, focus });
    expect(r).not.toBeNull();
    expect(r.scienceTag).toBe('executive_function');
    expect(r.body).toContain('70 minutes');
  });

  test('streak reveal when a routine streak is alive', () => {
    const streaks = [{ routine_name: 'Morning Essentials', current_streak: 5, best_streak: 9 }];
    const r = buildFallbackReveal({ ...empty, streaks });
    expect(r).not.toBeNull();
    expect(r.headline).toContain('Morning Essentials');
    expect(r.body).toContain('5 days');
  });

  test('single completion still produces the baseline reveal', () => {
    const tasks = [{ is_completed: true, completed_date: '2026-07-09', completed_dow: 4 }];
    const r = buildFallbackReveal({ ...empty, tasks });
    expect(r).not.toBeNull();
    expect(r.scienceTag).toBe('salutogenesis');
  });

  test('every fallback path returns a valid science tag and non-empty copy', () => {
    const variants = [
      { ...empty, tasks: Array(5).fill({ is_completed: true, completed_dow: 1, completed_date: '2026-07-06' }) },
      { ...empty, expenses: Array(6).fill({ is_impulse: false, amount: '5' }) },
      { ...empty, focus: [{ actual_duration_seconds: 5400, completed: true }] },
      { ...empty, streaks: [{ routine_name: 'PM wind-down', current_streak: 3, best_streak: 3 }] },
    ];
    for (const data of variants) {
      const r = buildFallbackReveal(data);
      expect(r).not.toBeNull();
      expect(r.headline.length).toBeGreaterThan(4);
      expect(r.body.length).toBeGreaterThan(20);
      expect(SCIENCE_TAGS).toContain(r.scienceTag);
    }
  });
});

describe('parseRevealJson', () => {
  test('parses clean JSON', () => {
    const r = parseRevealJson('{"headline":"Something about your Tuesdays","body":"You finished 80% of tasks on Tuesdays this week. Try stacking tomorrow accordingly.","science_tag":"habit_formation"}');
    expect(r).toMatchObject({ scienceTag: 'habit_formation' });
    expect(r.headline).toBe('Something about your Tuesdays');
  });

  test('extracts JSON wrapped in prose/fences', () => {
    const r = parseRevealJson('Here is the reveal:\n```json\n{"headline":"The 2pm thing is real","body":"Focus sessions after 2pm ran 40% longer this week. Guard that window today.","science_tag":"executive_function"}\n```');
    expect(r).not.toBeNull();
    expect(r.headline).toBe('The 2pm thing is real');
  });

  test('rejects missing fields', () => {
    expect(parseRevealJson('{"headline":"only a headline"}')).toBeNull();
    expect(parseRevealJson('no json here at all')).toBeNull();
  });

  test('rejects too-short content', () => {
    expect(parseRevealJson('{"headline":"Hi","body":"short"}')).toBeNull();
  });

  test('invalid science_tag falls back to cross_domain', () => {
    const r = parseRevealJson('{"headline":"A pattern emerged this week","body":"Your mornings drive most of your completions — protect the first hour today.","science_tag":"made_up_tag"}');
    expect(r.scienceTag).toBe('cross_domain');
  });

  test('caps runaway headline length', () => {
    const long = 'x'.repeat(300);
    const r = parseRevealJson(`{"headline":"${long}","body":"A real body sentence that is long enough to pass validation checks."}`);
    expect(r.headline.length).toBeLessThanOrEqual(80);
  });
});
