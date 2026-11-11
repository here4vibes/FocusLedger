'use strict';
/**
 * Inside the iOS app (user agent carries "FocusLedgerApp") the server never
 * starts a web purchase, never serves the sales pages and never sends upsell
 * copy (App Store guideline 3.1.1). Browsers are untouched.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, _res, next) => { req.user = { id: 42, email: 'buyer@example.com' }; next(); },
}));
jest.mock('../lib/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/emailTemplates', () => ({ proWelcomeTemplate: () => ({ subject: 's', html: 'h' }) }));
jest.mock('../db/billing');
const mockStripe = {
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
};
jest.mock('../lib/stripe-client', () => ({ getStripe: () => mockStripe }));

const {
  NATIVE_UA_TOKEN, NATIVE_CHECKOUT_CODE, NEUTRAL_PLAN_MESSAGE,
  isNativeAppRequest, stripUpsell, nativeAppResponses, nativeAppRedirects,
} = require('../lib/native-app');

const IOS_APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FocusLedgerApp/1.0';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('isNativeAppRequest', () => {
  test('true only for the app user agent', () => {
    expect(isNativeAppRequest({ headers: { 'user-agent': IOS_APP_UA } })).toBe(true);
    expect(isNativeAppRequest({ headers: { 'user-agent': SAFARI_UA } })).toBe(false);
    expect(isNativeAppRequest({ headers: {} })).toBe(false);
    expect(isNativeAppRequest(undefined)).toBe(false);
  });

  test('the token matches capacitor.config.ts and the browser module', () => {
    const root = path.join(__dirname, '..');
    expect(fs.readFileSync(path.join(root, 'capacitor.config.ts'), 'utf8'))
      .toMatch(new RegExp(`appendUserAgent: '${NATIVE_UA_TOKEN}/`));
    expect(fs.readFileSync(path.join(root, 'public/js/native-app.js'), 'utf8'))
      .toContain(`var UA_TOKEN = '${NATIVE_UA_TOKEN}'`);
  });
});

describe('stripUpsell', () => {
  test('keeps the fact, drops the pitch', () => {
    expect(stripUpsell('Free accounts can store up to 5 documents. Upgrade to Pro for unlimited storage.'))
      .toBe('Free accounts can store up to 5 documents.');
    expect(stripUpsell('You have 10 active tasks of your own — the free plan cap (routine tasks don’t count). Finish a few, or open it up with Autopilot.'))
      .toBe('You have 10 active tasks of your own — the free plan cap (routine tasks don’t count).');
  });

  test('a message that is only a pitch becomes the neutral plan line', () => {
    expect(stripUpsell('Upgrade to Autopilot for $9.95/mo!')).toBe(NEUTRAL_PLAN_MESSAGE);
  });

  test('leaves ordinary messages and non-strings alone', () => {
    expect(stripUpsell('Task created.')).toBe('Task created.');
    expect(stripUpsell(undefined)).toBe(undefined);
  });
});

describe('POST /api/subscription/checkout and /portal', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/subscription', require('../routes/subscription')({ query: jest.fn() }));
    return a;
  }

  test('the iOS app gets 403 with a clear code and Stripe is never called', async () => {
    const res = await request(app()).post('/api/subscription/checkout')
      .set('User-Agent', IOS_APP_UA).send({ plan: 'autopilot', billing: 'monthly' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: NATIVE_CHECKOUT_CODE });
    expect(res.body.url).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/stripe|focusledger\.net|\$/i);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('the billing portal is refused in the iOS app too', async () => {
    const res = await request(app()).post('/api/subscription/portal').set('User-Agent', IOS_APP_UA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(NATIVE_CHECKOUT_CODE);
    expect(mockStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test('a browser still gets a checkout URL', async () => {
    const res = await request(app()).post('/api/subscription/checkout')
      .set('User-Agent', SAFARI_UA).send({ plan: 'autopilot', billing: 'monthly' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toMatch(/^https:\/\//);
  });
});

describe('nativeAppResponses + nativeAppRedirects', () => {
  function app() {
    const a = express();
    a.use(nativeAppResponses, nativeAppRedirects);
    a.get('/', (_req, res) => res.send('landing'));
    a.get('/pricing', (_req, res) => res.send('pricing'));
    a.get('/login', (_req, res) => res.send('login'));
    a.post('/api/tasks', (_req, res) => res.status(402).json({
      success: false, code: 'TASK_LIMIT_REACHED', upgrade_required: true,
      message: 'Free plan is limited to 10 active tasks. Upgrade to Autopilot for unlimited tasks!',
    }));
    return a;
  }

  test.each(['/', '/pricing'])('the iOS app is sent from %s to /login', async (page) => {
    const res = await request(app()).get(page).set('User-Agent', IOS_APP_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test.each(['/', '/pricing'])('a browser still gets %s', async (page) => {
    const res = await request(app()).get(page).set('User-Agent', SAFARI_UA);
    expect(res.status).toBe(200);
  });

  test('the task-cap 402 keeps its code but loses the upgrade pitch in the iOS app', async () => {
    const res = await request(app()).post('/api/tasks').set('User-Agent', IOS_APP_UA);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('TASK_LIMIT_REACHED');
    expect(res.body.message).toBe('Free plan is limited to 10 active tasks.');
  });

  test('a browser gets the original message', async () => {
    const res = await request(app()).post('/api/tasks').set('User-Agent', SAFARI_UA);
    expect(res.body.message).toMatch(/Upgrade to Autopilot/);
  });
});

describe('every page loads the detection module first', () => {
  const root = path.join(__dirname, '..');
  const pages = ['views/index.html', 'public/pricing.html', 'public/login.html', 'public/signup.html',
    'public/settings.html', 'public/weightless.html', 'public/app/tasks.html', 'public/thanks.html',
    'public/story.html', 'public/science.html'];

  test.each(pages)('%s loads /js/native-app.js before the Meta Pixel and any other script', (page) => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const at = html.indexOf('<script src="/js/native-app.js"></script>');
    expect(at).toBeGreaterThan(-1);
    const firstOtherScript = html.replace('<script src="/js/native-app.js"></script>', '').search(/<script[\s>]/);
    expect(at).toBeLessThan(firstOtherScript);
    const pixel = html.indexOf('fbevents.js');
    if (pixel !== -1) expect(at).toBeLessThan(pixel);
  });
});
