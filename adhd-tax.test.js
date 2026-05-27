'use strict';

/**
 * Tests for ADHD Tax Calculator
 *
 * 1. Pure calculation logic (no DB dependency)
 * 2. API routes: POST /api/adhd-tax/submit, GET /api/adhd-tax/results/:hash
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { calculateAdhdTax, ADHD_TAX_CONFIG } = require('../routes/adhd-tax');

// ──────────────────────────────────────────────
// Pure calculation logic
// ──────────────────────────────────────────────
describe('calculateAdhdTax — pure calculation', () => {
  test('all-zero answers returns 0 total', () => {
    const result = calculateAdhdTax({
      appStack: 'none',
      lateFees: 'never',
      impulse: 'under_50',
      missedBills: 'never',
      unusedSubsYesNo: 'no'
    });
    // under_50 impulse = $25 × 12 = $300 (not zero — midpoint of <$50 is $25)
    expect(result.total).toBe(300);
    expect(result.breakdown.appStack).toBe(0);
    expect(result.breakdown.lateFees).toBe(0);
    expect(result.breakdown.missedBills).toBe(0);
    expect(result.breakdown.unusedSubs).toBe(0);
  });

  test('max-tier answers returns highest total', () => {
    const result = calculateAdhdTax({
      appStack: '5+',
      lateFees: 'multiple_month',
      impulse: '400_plus',
      missedBills: 'often',
      unusedSubsYesNo: 'yes',
      unusedSubsAmount: '200' // $200/mo × 12 = $2,400
    });
    const expected =
      ADHD_TAX_CONFIG.appStack['5+'] +
      ADHD_TAX_CONFIG.lateFees.multiple_month +
      ADHD_TAX_CONFIG.impulse['400_plus'] +
      ADHD_TAX_CONFIG.missedBills.often +
      200 * 12;
    expect(result.total).toBe(expected);
  });

  test('unusedSubs defaults to $120/yr when yes but no amount given', () => {
    const result = calculateAdhdTax({
      appStack: 'none',
      lateFees: 'never',
      impulse: 'under_50',
      missedBills: 'never',
      unusedSubsYesNo: 'yes',
      unusedSubsAmount: ''
    });
    expect(result.breakdown.unusedSubs).toBe(ADHD_TAX_CONFIG.unusedSubsDefault);
  });

  test('unusedSubs is 0 when answer is no', () => {
    const result = calculateAdhdTax({
      appStack: 'none',
      lateFees: 'never',
      impulse: 'under_50',
      missedBills: 'never',
      unusedSubsYesNo: 'no',
      unusedSubsAmount: '100'
    });
    expect(result.breakdown.unusedSubs).toBe(0);
  });

  test('monthly impulse $50-150 maps to $1,200/year', () => {
    const result = calculateAdhdTax({
      appStack: 'none',
      lateFees: 'never',
      impulse: '50_150',
      missedBills: 'never',
      unusedSubsYesNo: 'no'
    });
    expect(result.breakdown.impulse).toBe(1200);
  });

  test('comparedToAverage is "above" when total exceeds average', () => {
    const result = calculateAdhdTax({
      appStack: '5+',
      lateFees: 'multiple_month',
      impulse: '400_plus',
      missedBills: 'often',
      unusedSubsYesNo: 'no'
    });
    expect(result.comparedToAverage).toBe('above');
    expect(result.total).toBeGreaterThan(ADHD_TAX_CONFIG.averageAnnual);
  });

  test('comparedToAverage is "below" when total is low', () => {
    const result = calculateAdhdTax({
      appStack: 'none',
      lateFees: 'never',
      impulse: 'under_50',
      missedBills: 'never',
      unusedSubsYesNo: 'no'
    });
    expect(result.comparedToAverage).toBe('below');
  });

  test('unknown answer key returns 0 for that line item (graceful)', () => {
    const result = calculateAdhdTax({
      appStack: 'not_a_real_key',
      lateFees: 'never',
      impulse: 'under_50',
      missedBills: 'never',
      unusedSubsYesNo: 'no'
    });
    expect(result.breakdown.appStack).toBe(0);
  });
});

// ──────────────────────────────────────────────
// API route tests
// ──────────────────────────────────────────────
describe('POST /api/adhd-tax/submit', () => {
  const validAnswers = {
    appStack: '1-2',
    lateFees: 'monthly',
    impulse: '50_150',
    missedBills: 'rarely',
    unusedSubsYesNo: 'no'
  };

  test('400 when email is missing', async () => {
    const pool = { connect: jest.fn(), query: jest.fn() };
    const app = createTestApp(pool, 'adhd-tax');
    const res = await request(app).post('/api/adhd-tax/submit').send({ answers: validAnswers });
    expect(res.status).toBe(400);
  });

  test('400 when required answer is missing', async () => {
    const pool = { connect: jest.fn(), query: jest.fn() };
    const app = createTestApp(pool, 'adhd-tax');
    const { appStack: _, ...partial } = validAnswers;
    const res = await request(app).post('/api/adhd-tax/submit').send({
      email: 'test@example.com',
      answers: partial
    });
    expect(res.status).toBe(400);
  });

  test('400 when appStack value is invalid', async () => {
    const pool = { connect: jest.fn(), query: jest.fn() };
    const app = createTestApp(pool, 'adhd-tax');
    const res = await request(app).post('/api/adhd-tax/submit').send({
      email: 'test@example.com',
      answers: { ...validAnswers, appStack: 'banana' }
    });
    expect(res.status).toBe(400);
  });

  test('200 with correct results structure on valid submission', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })       // user lookup
        .mockResolvedValueOnce({ rows: [] }),       // insert lead
      release: jest.fn()
    };
    const pool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }) // email_sent_at update
    };
    const app = createTestApp(pool, 'adhd-tax');

    const res = await request(app).post('/api/adhd-tax/submit').send({
      email: 'test@example.com',
      answers: validAnswers
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toBeDefined();
    expect(res.body.results.total).toBeGreaterThan(0);
    expect(res.body.results.breakdown).toMatchObject({
      appStack: expect.any(Number),
      lateFees: expect.any(Number),
      impulse: expect.any(Number),
      missedBills: expect.any(Number),
      unusedSubs: expect.any(Number)
    });
    expect(res.body.shareHash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('GET /api/adhd-tax/results/:hash', () => {
  test('400 for malformed hash', async () => {
    const pool = { connect: jest.fn() };
    const app = createTestApp(pool, 'adhd-tax');
    const res = await request(app).get('/api/adhd-tax/results/not-valid');
    expect(res.status).toBe(400);
  });

  test('404 when hash not found', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };
    const pool = { connect: jest.fn().mockResolvedValue(mockClient) };
    const app = createTestApp(pool, 'adhd-tax');
    const res = await request(app).get('/api/adhd-tax/results/abcdef1234567890');
    expect(res.status).toBe(404);
  });

  test('200 with results when hash exists', async () => {
    const fakeResults = {
      answers: {},
      results: { total: 2400, breakdown: {} }
    };
    const mockClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          results_json: fakeResults,
          share_hash: 'abcdef1234567890',
          created_at: new Date()
        }]
      }),
      release: jest.fn()
    };
    const pool = { connect: jest.fn().mockResolvedValue(mockClient) };
    const app = createTestApp(pool, 'adhd-tax');
    const res = await request(app).get('/api/adhd-tax/results/abcdef1234567890');
    expect(res.status).toBe(200);
    expect(res.body.shareHash).toBe('abcdef1234567890');
  });
});
