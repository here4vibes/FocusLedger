/**
 * Runs public/sw.js in a sandbox and fires a notification click on "Done ✓".
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSw(fetchImpl) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    clients: { matchAll: async () => [], openWindow: async (url) => { opened.push(url); } },
    location: { origin: 'https://focusledger.net' },
    skipWaiting: () => {},
  };
  const ctx = vm.createContext({
    self, caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], match: async () => null },
    fetch: fetchImpl, console: { log() {}, warn() {}, error() {} }, URL, Response: function () {}, Promise, JSON,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), ctx);
  return { listeners, shown, opened };
}

function click(sw, action, data) {
  let done;
  const p = new Promise((r) => { done = r; });
  sw.listeners.notificationclick({
    action,
    notification: { close() {}, data },
    waitUntil: (pr) => Promise.resolve(pr).then(done, done),
  });
  return p;
}

test('Done ✓ posts the token and confirms without opening the app', async () => {
  const calls = [];
  const sw = loadSw(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ success: true, title: 'Eat something', routine_completed: [{ name: 'Morning Essentials', current_streak: 3 }] }) };
  });
  await click(sw, 'done', { url: '/weightless', actionTokens: { done: 'tok123' } });
  expect(calls).toEqual([{ url: '/api/push-actions/done', body: { token: 'tok123' } }]);
  expect(sw.shown[0].title).toBe('Done ✓');
  expect(sw.shown[0].opts.body).toBe('Morning Essentials done · 3-day streak 🔥');
  expect(sw.opened).toEqual([]);
});

test('if saving fails it opens the app instead', async () => {
  const sw = loadSw(async () => ({ ok: false, json: async () => ({ success: false, message: 'expired' }) }));
  await click(sw, 'done', { url: '/weightless?remind=5', actionTokens: { done: 'old' } });
  expect(sw.opened).toEqual(['/weightless?remind=5']);
});
