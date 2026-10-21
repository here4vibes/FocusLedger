'use strict';

const { cleanMerchantName, merchantKey, transactionMerchant, _internal } = require('../lib/merchant-normalize');
const { normalizeMerchantKey } = require('../lib/bill-patterns');
const { detectStreams, resolvePrefKeys, cancellationVerdict, bucketFor } = require('../lib/bill-guardian');

const desc = (s) => transactionMerchant({ description: s });

describe('cleanMerchantName: raw bank descriptors', () => {
  test.each([
    // Payment processors / POS prefixes
    ['SQ *JOES COFFEE 4421', 'Joes Coffee'],
    ['SQ*JOES COFFEE', 'Joes Coffee'],
    ['TST* BLUE DOOR CAFE', 'Blue Door Cafe'],
    ['TST*BLUE DOOR CAFE - 123 MAIN', 'Blue Door Cafe'],
    ['PAYPAL *NETFLIX 4029357733 CA', 'Netflix'],
    ['PAYPAL *SPOTIFY', 'Spotify'],
    ['PP*DROPBOX', 'Dropbox'],
    ['SP * ALLBIRDS', 'Allbirds'],
    ['SP AFF*ALLBIRDS', 'Allbirds'],
    ['SQ *SQ *DOUBLE SHOT', 'Double Shot'],
    // Store numbers, cities, states, zips
    ['JOES COFFEE #12', 'Joes Coffee'],
    ['JOES COFFEE #12 SEATTLE WA', 'Joes Coffee'],
    ['PLANET FITNESS #0123 BOSTON MA', 'Planet Fitness'],
    ['WHOLE FOODS MKT #10234 AUSTIN TX', 'Whole Foods Mkt'],
    ['7-ELEVEN 34512', '7-Eleven'],
    ['IN-N-OUT BURGER 123', 'In-N-Out Burger'],
    ['TARGET        00012345', 'Target'],
    ['DUKE ENERGY      CHARLOTTE    NC', 'Duke Energy'],
    ['MCDONALD\'S F12345 CHICAGO IL', 'McDonald\'s'],
    ['CVS/PHARMACY #04512', 'CVS/Pharmacy'],
    // Phones, web suffixes, reference ids
    ['NETFLIX.COM', 'Netflix'],
    ['NETFLIX.COM 866-579-7172 CA', 'Netflix'],
    ['HULU 877-8244858 CA', 'Hulu'],
    ['APPLE.COM/BILL 866-712-7753 CA', 'Apple'],
    ['SPOTIFY*P1234ABC', 'Spotify'],
    ['AMAZON MKTPLACE PMTS*2K4AB1C23', 'Amazon Mktplace'],
    ['UBER *EATS', 'Uber Eats'],
    ['UBER *TRIP HELP.UBER.COM', 'Uber Trip'],
    ['LYFT   *RIDE TUE 8PM', 'Lyft Ride'],
    ['STATE FARM INSURANCE 1234567890', 'State Farm Insurance'],
    // Card-network and ACH boilerplate, card digits, dates
    ['PURCHASE AUTHORIZED ON 09/12 SQ *JOES COFFEE SEATTLE WA S586255123 CARD 1234', 'Joes Coffee'],
    ['RECURRING PAYMENT AUTHORIZED ON 10/01 PLANET FITNESS', 'Planet Fitness'],
    ['CHECKCARD 0912 GEICO *AUTO 800-841-3000 DC', 'GEICO Auto'],
    ['POS DEBIT WAL-MART #1234', 'Wal-Mart'],
    ['COMCAST DES:CABLE ID:8822 INDN:JANE DOE CO ID:0000 PPD', 'Comcast'],
    ['ACH DEBIT PROGRESSIVE INS', 'Progressive Ins'],
    ['PREAUTHORIZED DEBIT NAVIENT', 'Navient'],
    ['XXXX1234 CHASE CREDIT CRD AUTOPAY', 'Chase Credit Crd'],
    // How-it-was-paid words, kept when they name the bill
    ['T-MOBILE *AUTO PAY', 'T-Mobile'],
    ['AT&T *PAYMENT', 'AT&T'],
    ['VERIZON WIRELESS PAYMENTS', 'Verizon Wireless'],
    ['RENT PAYMENT', 'Rent Payment'],
    // Title case: connector words, specials
    ['BED BATH AND BEYOND', 'Bed Bath and Beyond'],
    ['SXM*SIRIUSXM.COM/ACCT', 'SXM SiriusXM'],
    ['24 HOUR FITNESS USA', '24 Hour Fitness'],
  ])('%s → %s', (raw, expected) => {
    expect(cleanMerchantName(raw)).toBe(expected);
  });

  test('state codes that are also words stay unless a city or number sits in front', () => {
    expect(cleanMerchantName('JOES PIZZA CO')).toBe('Joes Pizza Co');
    expect(cleanMerchantName('PIZZA ME')).toBe('Pizza Me');
    expect(cleanMerchantName('BLUE BOTTLE DENVER CO')).toBe('Blue Bottle');
  });

  test('empty or noise-only input', () => {
    expect(cleanMerchantName('')).toBe('');
    expect(cleanMerchantName(null)).toBe('');
    expect(cleanMerchantName('   ')).toBe('');
    // Nothing merchant-like survives the stripping: fall back to the raw text, title-cased.
    expect(cleanMerchantName('POS 12345')).toBe('Pos 12345');
  });
});

describe('cleanMerchantName: curated names', () => {
  test('mixed-case names (Plaid merchant_name) are trusted as-is', () => {
    expect(cleanMerchantName("Joe's Coffee")).toBe("Joe's Coffee");
    expect(cleanMerchantName('YouTube Premium')).toBe('YouTube Premium');
    expect(cleanMerchantName('Chase Card Payment')).toBe('Chase Card Payment');
    expect(cleanMerchantName('  Oak   Property Management ')).toBe('Oak Property Management');
  });

  test('a processor prefix that slipped into a curated name is still dropped', () => {
    expect(cleanMerchantName('SQ *Blue Door Cafe')).toBe('Blue Door Cafe');
  });

  test('descriptor mode cleans mixed-case raw descriptors too', () => {
    expect(cleanMerchantName('AMZN Mktp US*2K4AB1C23', { descriptor: true })).toBe('Amzn Mktp');
    expect(cleanMerchantName('GOOGLE *YouTube', { descriptor: true })).toBe('Google YouTube');
  });

  test('all-lower-case input is title-cased', () => {
    expect(cleanMerchantName('joes coffee #12')).toBe('Joes Coffee');
  });
});

describe('titleCase', () => {
  const { titleCase } = _internal;
  test('apostrophes do not start a word; hyphens do; Mc names', () => {
    expect(titleCase("JOE'S CRAB SHACK")).toBe("Joe's Crab Shack");
    expect(titleCase('T-MOBILE')).toBe('T-Mobile');
    expect(titleCase('MCDONALDS')).toBe('McDonalds');
  });
  test('connector words lower case except first; special spellings', () => {
    expect(titleCase('THE HOME DEPOT')).toBe('The Home Depot');
    expect(titleCase('BANK OF AMERICA')).toBe('Bank of America');
    expect(titleCase('PG&E')).toBe('PG&E');
    expect(titleCase('USAA INSURANCE')).toBe('USAA Insurance');
    expect(titleCase('EBAY')).toBe('eBay');
  });
});

describe('merchantKey / transactionMerchant', () => {
  test('raw descriptor variants of one merchant share a key', () => {
    const keys = ['SQ *JOES COFFEE 4421', 'JOES COFFEE #12', 'JOES COFFEE #12 SEATTLE WA',
      'PURCHASE AUTHORIZED ON 09/12 SQ *JOES COFFEE SEATTLE WA S586255123 CARD 1234']
      .map(s => desc(s).key);
    expect(new Set(keys)).toEqual(new Set(['joes_coffee']));
  });

  test("Plaid's \"Joe's Coffee\" and raw \"JOES COFFEE\" share a key (apostrophe dropped)", () => {
    expect(merchantKey("Joe's Coffee")).toBe('joes_coffee');
    expect(transactionMerchant({ merchant_name: "Joe's Coffee", description: 'SQ *JOES COFFEE 4421' }).key).toBe('joes_coffee');
  });

  test('prefers merchant_name over description for the name', () => {
    const m = transactionMerchant({ merchant_name: 'Netflix', description: 'NETFLIX.COM 866-579-7172 CA' });
    expect(m).toMatchObject({ name: 'Netflix', key: 'netflix', legacyKey: 'netflix', raw: 'Netflix' });
  });

  test('legacyKey is the pre-normalization key of the raw name', () => {
    const raw = 'SQ *JOES COFFEE 4421';
    expect(desc(raw).legacyKey).toBe(normalizeMerchantKey(raw));
    expect(desc(raw).legacyKey).toBe('sq_joes_coffee_4421');
  });

  test('clean names keep the key they always had (no churn for Plaid-named merchants)', () => {
    for (const name of ['Netflix', 'Spotify', 'Oak Property Management', 'Chase Card Payment', 'State Farm', 'Glow Nails']) {
      expect(transactionMerchant({ merchant_name: name }).key).toBe(normalizeMerchantKey(name));
    }
  });

  test('nothing usable → empty key', () => {
    expect(transactionMerchant({}).key).toBe('');
    expect(transactionMerchant({ merchant_name: '  ', description: '' }).key).toBe('');
  });
});

describe('bill guardian with normalized merchants', () => {
  const DAY = 86400000;
  const TODAY = Date.parse('2026-10-11T12:00:00Z');
  const day = (off) => new Date(TODAY + off * DAY).toISOString().slice(0, 10);
  // Three monthly charges of a coffee subscription, each with a different descriptor.
  const coffeeTxs = [
    { description: 'SQ *JOES COFFEE 4421', amount: 30, transaction_date: day(-65) },
    { description: 'JOES COFFEE #12', amount: 30, transaction_date: day(-35) },
    { merchant_name: "Joe's Coffee", description: 'SQ *JOES COFFEE 4421', amount: 30, transaction_date: day(-4) },
  ];

  test('"SQ *JOES COFFEE 4421" and "JOES COFFEE #12" group into one "Joe\'s Coffee" stream', () => {
    const streams = detectStreams(coffeeTxs, TODAY);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ merchant_key: 'joes_coffee', name: "Joe's Coffee", frequency: 'monthly', occurrences: 3 });
    expect(streams[0].legacy_keys.sort()).toEqual(['joe_s_coffee', 'joes_coffee_12', 'sq_joes_coffee_4421']);
  });

  test('without a Plaid name the stream is titled from the cleaned descriptor', () => {
    const streams = detectStreams(coffeeTxs.map(t => ({ ...t, merchant_name: undefined })), TODAY);
    expect(streams[0].name).toBe('Joes Coffee');
  });

  test('an answer stored under an old raw-name key is found and its key is kept', () => {
    const prefs = [{ merchant_key: 'sq_joes_coffee_4421', bucket: 'subscription', updated_at: '2026-09-01T00:00:00Z' }];
    const [s] = detectStreams(coffeeTxs, TODAY, prefs);
    expect(s.merchant_key).toBe('sq_joes_coffee_4421');
    expect(bucketFor(s, new Map(prefs.map(p => [p.merchant_key, p])).get(s.merchant_key))).toBe('subscription');
  });

  test('a row under the normalized key wins over legacy rows', () => {
    const prefs = [
      { merchant_key: 'sq_joes_coffee_4421', bucket: 'subscription', updated_at: '2026-10-01T00:00:00Z' },
      { merchant_key: 'joes_coffee', bucket: 'habit', updated_at: '2026-01-01T00:00:00Z' },
    ];
    expect(detectStreams(coffeeTxs, TODAY, prefs)[0].merchant_key).toBe('joes_coffee');
  });

  test('several legacy rows: the most recently updated answer wins', () => {
    const streams = [{ merchant_key: 'joes_coffee', legacy_keys: ['sq_joes_coffee_4421', 'joes_coffee_12'] }];
    resolvePrefKeys(streams, [
      { merchant_key: 'sq_joes_coffee_4421', updated_at: '2026-03-01T00:00:00Z' },
      { merchant_key: 'joes_coffee_12', updated_at: '2026-09-01T00:00:00Z' },
    ]);
    expect(streams[0].merchant_key).toBe('joes_coffee_12');
  });

  test('no matching row → the normalized key', () => {
    expect(detectStreams(coffeeTxs, TODAY, [{ merchant_key: 'netflix' }])[0].merchant_key).toBe('joes_coffee');
  });

  test('known-merchant patterns still match after cleaning (raw name checked too)', () => {
    const txs = [-70, -40, -10].map(o => ({ description: 'PAYPAL *NETFLIX 4029357733 CA', amount: 15.49, transaction_date: day(o) }));
    const [s] = detectStreams(txs, TODAY);
    expect(s.name).toBe('Netflix');
    expect(bucketFor(s)).toBe('subscription');
  });

  describe('cancellationVerdict across key generations', () => {
    const pending = (key) => ({ merchant_key: key, cancel_requested_at: day(-20), cancel_expected_by: day(-10), cancel_frequency: 'monthly' });

    test('legacy-keyed cancel: a new charge under a different descriptor counts as charged again', () => {
      const txs = [
        { description: 'SQ *JOES COFFEE 4421', amount: 30, transaction_date: day(-50) },
        { description: 'JOES COFFEE #13', amount: 30, transaction_date: day(-5) },
      ];
      expect(cancellationVerdict(pending('sq_joes_coffee_4421'), txs, TODAY)).toBe('charged_again');
    });

    test('normalized-key cancel: any descriptor variant counts', () => {
      const txs = [{ description: 'SQ *JOES COFFEE 9981', amount: 30, transaction_date: day(-5) }];
      expect(cancellationVerdict(pending('joes_coffee'), txs, TODAY)).toBe('charged_again');
    });

    test('other merchants do not count', () => {
      const txs = [{ description: 'SQ *BLUE DOOR CAFE', amount: 30, transaction_date: day(-5) }];
      expect(cancellationVerdict(pending('sq_joes_coffee_4421'), txs, TODAY)).toBe('confirmed');
    });
  });
});

describe('db/bills createBillReminder dedupe', () => {
  test('checks the stream key and its legacy keys, so an older reminder is not duplicated', async () => {
    const { createBillReminder } = require('../db/bills');
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    const created = await createBillReminder(pool, 9,
      { merchant_key: 'joes_coffee', legacy_keys: ['sq_joes_coffee_4421', 'joes_coffee_12'] },
      { title: 't', description: 'd', due_date: '2026-11-01' });
    expect(created).toBe(false);
    expect(calls[0].sql).toMatch(/bill_merchant_key = ANY\(\$6::text\[\]\)/);
    expect(calls[0].params[4]).toBe('joes_coffee');
    expect(calls[0].params[5]).toEqual(['joes_coffee', 'sq_joes_coffee_4421', 'joes_coffee_12']);
  });
});
