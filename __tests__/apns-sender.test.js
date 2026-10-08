'use strict';

const http2 = require('http2');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' });

const apns = require('../lib/apns-sender');

let server;
let host;
let requests;
let respond; // (path) => { status, body }

beforeAll(async () => {
  server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => { data += c; });
    stream.on('end', () => {
      requests.push({ headers, body: data ? JSON.parse(data) : null });
      const r = respond(headers[':path']);
      stream.respond({ ':status': r.status });
      stream.end(r.body ? JSON.stringify(r.body) : undefined);
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  host = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  requests = [];
  respond = () => ({ status: 200 });
  apns._internal.resetProviderToken();
  Object.assign(process.env, {
    APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM456',
    APNS_KEY_P8: Buffer.from(pkcs8).toString('base64'), APNS_BUNDLE_ID: 'net.focusledger.app',
  });
});

afterEach(() => {
  for (const k of ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_P8', 'APNS_BUNDLE_ID']) delete process.env[k];
});

test('not configured → no-op', async () => {
  delete process.env.APNS_KEY_P8;
  await expect(apns.sendApnsNotification(['t1'], { title: 'a', body: 'b' }, null, { host })).resolves.toEqual({ sent: 0, failed: 0 });
  expect(requests).toHaveLength(0);
});

test('sends an alert per token with a valid ES256 provider token and the app url', async () => {
  const r = await apns.sendApnsNotification(['tokA', 'tokB'], { title: 'Hi', body: 'There', url: '/app/money' }, null, { host });

  expect(r).toEqual({ sent: 2, failed: 0 });
  expect(requests.map(q => q.headers[':path'])).toEqual(['/3/device/tokA', '/3/device/tokB']);
  const h = requests[0].headers;
  expect(h['apns-topic']).toBe('net.focusledger.app');
  expect(h['apns-push-type']).toBe('alert');
  const token = h.authorization.replace(/^bearer /, '');
  const decoded = jwt.verify(token, publicKey.export({ type: 'spki', format: 'pem' }), { algorithms: ['ES256'], complete: true });
  expect(decoded.header.kid).toBe('KEY123');
  expect(decoded.payload.iss).toBe('TEAM456');
  expect(requests[0].body).toEqual({ aps: { alert: { title: 'Hi', body: 'There' } }, url: '/app/money' });
});

test('410 / BadDeviceToken → onInvalidToken; other failures are counted, not swallowed', async () => {
  respond = (path) => {
    if (path.endsWith('/gone')) return { status: 410, body: { reason: 'Unregistered' } };
    if (path.endsWith('/bad')) return { status: 400, body: { reason: 'BadDeviceToken' } };
    if (path.endsWith('/oops')) return { status: 500, body: { reason: 'InternalServerError' } };
    return { status: 200 };
  };
  const invalid = [];
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

  const r = await apns.sendApnsNotification(['ok', 'gone', 'bad', 'oops'], { title: 't', body: 'b' }, (t) => invalid.push(t), { host });

  expect(r).toEqual({ sent: 1, failed: 3 });
  expect(invalid).toEqual(['gone', 'bad']);
  expect(spy).toHaveBeenCalledWith('[apns] send failed | status:', 500, '| reason:', 'InternalServerError', '| token:', 'oops…');
  spy.mockRestore();
});

test('provider token is reused within its lifetime (Apple rate-limits refreshes)', () => {
  const t0 = Date.now();
  const a = apns._internal.providerToken(t0);
  expect(apns._internal.providerToken(t0 + 10 * 60 * 1000)).toBe(a);
  expect(apns._internal.providerToken(t0 + 51 * 60 * 1000)).not.toBe(a);
});

test('unreachable host → every token counted as failed, no throw', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const r = await apns.sendApnsNotification(['x', 'y'], { title: 't', body: 'b' }, null, { host: 'http://localhost:1' });
  expect(r).toEqual({ sent: 0, failed: 2 });
  spy.mockRestore();
});
