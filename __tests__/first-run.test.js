// First-run funnel helpers: in-app browser detection (ads open in Facebook /
// Instagram webviews, where Google refuses sign-in) and the literal
// "Add a task: …" that must work even when the AI can't be reached.

const { isInApp, browserUrl } = require('../public/js/in-app-browser');
const { parsePlainAddTask } = require('../lib/plain-add-task');

describe('in-app browser detection', () => {
  const inApp = [
    ['Instagram iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 331.0.0.29.117 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 600349675)'],
    ['Facebook iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 [FBAN/FBIOS;FBAV/465.0.0.39.106;FBBV/600000000;FBDV/iPhone14,5;FBMD/iPhone]'],
    ['Facebook Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/465.0.0.50.82;]'],
    ['TikTok', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.5.0 BytedanceWebview/d8a21c6'],
    ['LinkedIn', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.8'],
  ];
  test.each(inApp)('%s is in-app', (_, ua) => expect(isInApp(ua)).toBe(true));

  const real = [
    ['Safari iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'],
    ['Chrome Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'],
    ['Chrome desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'],
    ['empty', ''],
  ];
  test.each(real)('%s is a real browser', (_, ua) => expect(isInApp(ua)).toBe(false));
});

describe('browserUrl (the link to open outside the in-app browser)', () => {
  test('adds the saved campaign tags so attribution survives the hop', () => {
    expect(browserUrl('https://focusledger.net/signup', { utm_source: 'instagram', utm_medium: 'paid', utm_campaign: 'launch 1', fbclid: 'abc', landing_page: '/' }))
      .toBe('https://focusledger.net/signup?utm_source=instagram&utm_medium=paid&utm_campaign=launch%201');
  });
  test('keeps tags already in the address and drops the hash', () => {
    expect(browserUrl('https://focusledger.net/signup?utm_source=fb&plan=autopilot#top', { utm_source: 'instagram', utm_medium: 'paid' }))
      .toBe('https://focusledger.net/signup?utm_source=fb&plan=autopilot&utm_medium=paid');
  });
  test('no attribution: the address is unchanged', () => {
    expect(browserUrl('https://focusledger.net/login', null)).toBe('https://focusledger.net/login');
    expect(browserUrl('https://focusledger.net/login', { utm_source: 42 })).toBe('https://focusledger.net/login');
  });
});

describe('parsePlainAddTask', () => {
  test.each([
    ['Add a task: call the dentist', 'call the dentist'],
    ['add task: Pay rent', 'Pay rent'],
    ['  Please add a new task - renew passport  ', 'renew passport'],
    ['ADD A TASK: "email Sam"', 'email Sam'],
    ['add another task — book flights', 'book flights'],
  ])('%s → %s', (msg, title) => expect(parsePlainAddTask(msg)).toBe(title));

  test.each([
    ['Add a task: '],                          // the chip's prefill, sent empty
    ['can you add a task for the dentist'],    // needs the model
    ['remind me to call the dentist'],
    ["I'm stuck"],
    ['add a task: one\nand another thing'],    // multi-line: not a plain title
    ['add a task: ' + 'x'.repeat(201)],
    [null], [undefined], [42],
  ])('%p is left to the model', (msg) => expect(parsePlainAddTask(msg)).toBeNull());
});
