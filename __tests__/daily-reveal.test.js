'use strict';
/**
 * Unit tests for the Daily Reveal generation logic:
 * - buildFallbackReveal: deterministic reveal from real data (no AI)
 * - parseRevealJson: robust parsing of Haiku output
 */

const {
  buildFallbackReveal,
  parseRevealJson,
  pickFunFact,
  isFunFactDay,
  FUN_FACTS,
  SCIENCE_TAGS,
  deriveInterests,
  revealSlotFor,
  buildInterestFallback,
  interestsLine,
  INTEREST_KEYWORDS,
  INTEREST_FACTS,
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

describe('fun-fact reveals', () => {
  test('every fact in the bank has valid shape and science tag', () => {
    expect(FUN_FACTS.length).toBeGreaterThanOrEqual(10);
    for (const f of FUN_FACTS) {
      expect(f.headline.length).toBeGreaterThan(4);
      expect(f.headline.length).toBeLessThanOrEqual(60);
      expect(f.body.length).toBeGreaterThan(40);
      expect(SCIENCE_TAGS).toContain(f.scienceTag);
      expect(f.themes.length).toBeGreaterThan(0);
    }
  });

  test('pickFunFact never returns null and marks type fun_fact', () => {
    const r = pickFunFact(42, '2026-07-11', {});
    expect(r).not.toBeNull();
    expect(r.revealType).toBe('fun_fact');
    expect(SCIENCE_TAGS).toContain(r.scienceTag);
  });

  test('pickFunFact is deterministic for the same user+date', () => {
    const a = pickFunFact(7, '2026-07-11', null);
    const b = pickFunFact(7, '2026-07-11', null);
    expect(a.headline).toBe(b.headline);
  });

  test('different dates rotate the fact', () => {
    const picks = new Set(
      ['2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15']
        .map(d => pickFunFact(7, d, null).headline)
    );
    expect(picks.size).toBeGreaterThan(1); // rotates, not stuck
  });

  test('profile mentioning money prefers money-themed facts', () => {
    const profile = { primary_struggle: 'impulse money spending' };
    const moneyHeadlines = FUN_FACTS.filter(f => f.themes.includes('money')).map(f => f.headline);
    // With a money-heavy profile, picks come from the preferred pool
    const picks = new Set(
      ['2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14']
        .map(d => pickFunFact(7, d, profile).headline)
    );
    for (const h of picks) {
      expect(moneyHeadlines).toContain(h);
    }
  });

  test('isFunFactDay is deterministic and fires roughly 1 in 4', () => {
    expect(isFunFactDay(5, '2026-07-11')).toBe(isFunFactDay(5, '2026-07-11'));
    let hits = 0;
    for (let day = 1; day <= 28; day++) {
      const date = `2026-07-${String(day).padStart(2, '0')}`;
      if (isFunFactDay(9, date)) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(2);  // not never
    expect(hits).toBeLessThanOrEqual(14);    // not most days
  });
});

describe('interest detection', () => {
  const corpus = [
    { text: 'Gym session with Marcus' },
    { text: 'Buy climbing chalk' },
    { text: 'REI Co-op Climbing Gear' },
    { text: 'Book boulder gym day pass' },
    { text: 'Pay electricity bill' },
    { text: 'Blue Bottle Coffee' },
    { text: 'Starbucks coffee' },
    { text: 'Dentist appointment' },
  ];

  test('detects interests with >=3 signals, ignores one-offs', () => {
    const interests = deriveInterests(corpus);
    const tags = interests.map(i => i.tag);
    expect(tags).toContain('fitness');   // gym, climbing x2, boulder = 4 signals
    expect(tags).not.toContain('coffee'); // only 2 signals — not stable
  });

  test('collects evidence snippets (max 3, deduped)', () => {
    const interests = deriveInterests(corpus);
    const fitness = interests.find(i => i.tag === 'fitness');
    expect(fitness.evidence.length).toBeLessThanOrEqual(3);
    expect(fitness.evidence[0]).toBe('Gym session with Marcus');
  });

  test('never detects from sensitive text — no such keywords exist', () => {
    const sensitive = [
      { text: 'CVS Pharmacy' }, { text: 'Therapy session' }, { text: 'Therapy session 2' },
      { text: 'urgent care copay' }, { text: 'Therapy session 3' },
    ];
    expect(deriveInterests(sensitive)).toEqual([]);
  });

  test('empty/garbage corpus returns empty', () => {
    expect(deriveInterests([])).toEqual([]);
    expect(deriveInterests([{ text: null }, { text: '' }])).toEqual([]);
  });

  test('caps at top 3 interests by count', () => {
    const wide = [];
    for (const t of ['gym', 'recipe', 'steam', 'guitar', 'hike']) {
      for (let i = 0; i < 4; i++) wide.push({ text: `${t} thing ${i}` });
    }
    expect(deriveInterests(wide).length).toBe(3);
  });

  test('interestsLine formats for the AI prompt', () => {
    const line = interestsLine(deriveInterests(corpus));
    expect(line).toContain('INTERESTS');
    expect(line).toContain('fitness');
    expect(line).toContain('"Gym session with Marcus"');
    expect(interestsLine([])).toBe('');
  });
});

describe('revealSlotFor', () => {
  test('deterministic per user+date', () => {
    expect(revealSlotFor(5, '2026-07-13')).toBe(revealSlotFor(5, '2026-07-13'));
  });

  test('all three flavors occur across a month', () => {
    const slots = new Set();
    for (let d = 1; d <= 28; d++) {
      slots.add(revealSlotFor(9, `2026-07-${String(d).padStart(2, '0')}`));
    }
    expect(slots).toEqual(new Set(['fun_fact', 'interest', 'personal']));
  });

  test('isFunFactDay stays consistent with the slot', () => {
    for (let d = 1; d <= 10; d++) {
      const date = `2026-07-0${d % 9 + 1}`;
      expect(isFunFactDay(3, date)).toBe(revealSlotFor(3, date) === 'fun_fact');
    }
  });
});

describe('buildInterestFallback', () => {
  test('builds from real evidence, marks type interest, carries the curated source', () => {
    const r = buildInterestFallback({ tag: 'coffee', count: 5, evidence: ['Blue Bottle', 'Espresso beans'] });
    expect(r.revealType).toBe('interest');
    expect(r.headline).toContain('coffee');
    expect(r.body).toContain('"Blue Bottle"');
    expect(r.body).toContain('5');
    expect(r.source.url).toMatch(/^https:\/\//);
    expect(r.source.label.length).toBeGreaterThan(5);
  });

  test('null interest → null', () => {
    expect(buildInterestFallback(null)).toBeNull();
  });
});

describe('source credibility — every external claim is cited', () => {
  test('every fun fact carries a real https source', () => {
    for (const f of FUN_FACTS) {
      expect(f.source).toBeDefined();
      expect(f.source.url).toMatch(/^https:\/\//);
      expect(f.source.label.length).toBeGreaterThan(5);
    }
  });

  test('every interest tag has a sourced fact (no tag can produce an unsourced claim)', () => {
    for (const tag of Object.keys(INTEREST_KEYWORDS)) {
      const f = INTEREST_FACTS[tag];
      expect(f).toBeDefined();
      expect(f.fact.length).toBeGreaterThan(30);
      expect(f.source.url).toMatch(/^https:\/\//);
    }
  });

  test('pickFunFact passes the source through', () => {
    const r = pickFunFact(42, '2026-07-13', {});
    expect(r.source.url).toMatch(/^https:\/\//);
  });

  test('sources are stable resolver/edu URLs, not homepage guesses', () => {
    const all = [...FUN_FACTS.map(f => f.source.url), ...Object.values(INTEREST_FACTS).map(f => f.source.url)];
    for (const url of all) {
      expect(url).toMatch(/^https:\/\/(doi\.org|www\.additudemag\.com)\//);
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

  test('interest mode: science_tag "none" → null tag, type interest', () => {
    const r = parseRevealJson(
      '{"headline":"The climbing thing goes deeper","body":"Grip strength is one of the strongest longevity predictors researchers can measure — your hobby is quietly a health plan.","science_tag":"none"}',
      { defaultScienceTag: null, revealType: 'interest' }
    );
    expect(r.scienceTag).toBeNull();
    expect(r.revealType).toBe('interest');
  });
});
