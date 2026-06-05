/**
 * Shared public-site navigation.
 * Injected at the top of every public (non-app) page.
 * Self-contained — no external CSS dependency, no framework.
 */
(function () {
  'use strict';

  if (document.getElementById('fl-public-nav')) return;

  // Inject Space Grotesk if not already present
  if (!document.querySelector('link[href*="Space+Grotesk"]')) {
    var fl = document.createElement('link');
    fl.rel = 'stylesheet';
    fl.href = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap';
    document.head.appendChild(fl);
  }

  var css = document.createElement('style');
  css.id = 'fl-public-nav-css';
  css.textContent = [
    '#fl-public-nav{',
      'background:rgba(250,248,244,0.97);',
      'backdrop-filter:blur(16px);',
      '-webkit-backdrop-filter:blur(16px);',
      'box-shadow:0 1px 0 rgba(1,30,92,0.08);',
      'position:sticky;top:0;z-index:200;',
      'font-family:"Space Grotesk",system-ui,sans-serif;',
    '}',
    '#fl-public-nav .pn-inner{',
      'padding:0 2rem;height:64px;',
      'display:flex;justify-content:space-between;align-items:center;',
      'max-width:1200px;margin:0 auto;',
    '}',
    '#fl-public-nav .pn-logo{',
      'display:flex;align-items:center;gap:0.5rem;',
      'text-decoration:none;font-size:1.15rem;font-weight:700;',
      'letter-spacing:-0.02em;line-height:1;flex-shrink:0;',
    '}',
    '#fl-public-nav .pn-logo-img{height:30px;width:auto;display:block;flex-shrink:0;}',
    '#fl-public-nav .pn-focus{color:#011e5c;font-weight:700;}',
    '#fl-public-nav .pn-ledger{color:#f0b429;font-weight:400;}',
    '#fl-public-nav .pn-actions{display:flex;align-items:center;gap:0.5rem;}',
    '#fl-public-nav .pn-links{display:flex;align-items:center;gap:0;}',
    '#fl-public-nav .pn-links a{',
      'color:#44444a;text-decoration:none;',
      'font-size:0.875rem;font-weight:500;',
      'padding:0.45rem 0.85rem;border-radius:8px;',
      'transition:all 0.15s;white-space:nowrap;',
    '}',
    '#fl-public-nav .pn-links a:hover{color:#011e5c;background:rgba(1,30,92,0.05);}',
    '#fl-public-nav .pn-cta{',
      'background:#011e5c;color:#fff !important;',
      'font-weight:600;border-radius:10px;',
      'padding:0.5rem 1.1rem;text-decoration:none;',
      'font-size:0.875rem;white-space:nowrap;',
      'transition:background 0.15s;',
    '}',
    '#fl-public-nav .pn-cta:hover{background:#010f30;}',
    '#fl-public-nav .pn-burger{',
      'display:none;background:none;border:none;',
      'cursor:pointer;padding:0.5rem;color:#011e5c;',
    '}',
    '#fl-public-nav .pn-burger svg{width:22px;height:22px;}',
    '#fl-pnav-drawer{',
      'display:none;position:fixed;inset:0;z-index:300;',
      'background:rgba(1,15,48,0.5);',
    '}',
    '#fl-pnav-drawer.open{display:block;}',
    '#fl-pnav-drawer .pnd-panel{',
      'position:absolute;top:0;right:0;',
      'width:min(300px,88vw);height:100%;',
      'background:#faf8f4;padding:1.5rem;',
      'transform:translateX(100%);',
      'transition:transform 0.25s ease;',
      'border-left:1px solid #e8e3d9;',
    '}',
    '#fl-pnav-drawer.open .pnd-panel{transform:translateX(0);}',
    '#fl-pnav-drawer .pnd-header{display:flex;justify-content:flex-end;margin-bottom:1.5rem;}',
    '#fl-pnav-drawer .pnd-close{',
      'background:none;border:none;color:#8a8a95;cursor:pointer;padding:0.25rem;',
    '}',
    '#fl-pnav-drawer .pnd-close svg{width:22px;height:22px;}',
    '#fl-pnav-drawer .pnd-links{display:flex;flex-direction:column;gap:0.25rem;}',
    '#fl-pnav-drawer .pnd-links a{',
      'color:#44444a;text-decoration:none;',
      'font-family:"Space Grotesk",system-ui,sans-serif;',
      'font-size:1rem;font-weight:500;',
      'padding:0.85rem 0.75rem;border-radius:10px;',
      'transition:all 0.15s;',
    '}',
    '#fl-pnav-drawer .pnd-links a:hover{color:#011e5c;background:rgba(1,30,92,0.05);}',
    '#fl-pnav-drawer .pnd-links .pnd-cta{',
      'background:#011e5c;color:#fff;',
      'text-align:center;border-radius:12px;',
      'margin-top:0.75rem;font-weight:700;',
    '}',
    '#fl-pnav-drawer .pnd-links .pnd-cta:hover{background:#010f30;}',
    '@media(max-width:600px){',
      '#fl-public-nav .pn-inner{padding:0 1rem;height:56px;}',
      '#fl-public-nav .pn-links{display:none;}',
      '#fl-public-nav .pn-burger{display:flex;}',
    '}',
  ].join('');
  document.head.appendChild(css);

  var buddyHref = window.location.pathname === '/' ? '#try-buddy' : '/#try-buddy';

  var nav = document.createElement('nav');
  nav.id = 'fl-public-nav';
  nav.setAttribute('aria-label', 'Main navigation');
  nav.innerHTML =
    '<div class="pn-inner">' +
      '<a href="/" class="pn-logo">' +
        '<img src="/icons/fl-icon.svg" class="pn-logo-img" alt="FocusLedger logo">' +
        '<span class="pn-focus">Focus</span><span class="pn-ledger">Ledger</span>' +
      '</a>' +
      '<div class="pn-actions">' +
        '<span class="pn-links">' +
          '<a href="/adhd-tax">ADHD Tax Calc</a>' +
          '<a href="/science">The Science</a>' +
          '<a href="/pricing">Pricing</a>' +
          '<a href="' + buddyHref + '">Try Buddy</a>' +
          '<a href="/login" id="pnavAuthLink">Log In</a>' +
        '</span>' +
        '<a href="/signup" id="pnavCtaLink" class="pn-cta">Start Free</a>' +
        '<button class="pn-burger" id="pnavBurger" aria-label="Open menu" aria-expanded="false">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
            '<line x1="3" y1="6" x2="21" y2="6"></line>' +
            '<line x1="3" y1="12" x2="21" y2="12"></line>' +
            '<line x1="3" y1="18" x2="21" y2="18"></line>' +
          '</svg>' +
        '</button>' +
      '</div>' +
    '</div>';

  var drawer = document.createElement('div');
  drawer.id = 'fl-pnav-drawer';
  drawer.innerHTML =
    '<div class="pnd-panel">' +
      '<div class="pnd-header">' +
        '<button class="pnd-close" id="pnavDrawerClose" aria-label="Close menu">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line>' +
          '</svg>' +
        '</button>' +
      '</div>' +
      '<div class="pnd-links">' +
        '<a href="/adhd-tax">ADHD Tax Calc</a>' +
        '<a href="/science">The Science</a>' +
        '<a href="/pricing">Pricing</a>' +
        '<a href="/contact">Contact</a>' +
        '<a href="/login" id="pnavMobileAuthLink">Log In</a>' +
        '<a href="/signup" id="pnavMobileCtaLink" class="pnd-cta">Start Free</a>' +
      '</div>' +
    '</div>';

  document.body.insertBefore(drawer, document.body.firstChild);
  document.body.insertBefore(nav, drawer);

  var burger = document.getElementById('pnavBurger');
  var drawerEl = document.getElementById('fl-pnav-drawer');
  var closeBtn = document.getElementById('pnavDrawerClose');

  function openMenu() {
    drawerEl.classList.add('open');
    document.body.style.overflow = 'hidden';
    burger.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    drawerEl.classList.remove('open');
    document.body.style.overflow = '';
    burger.setAttribute('aria-expanded', 'false');
  }

  if (burger) burger.addEventListener('click', openMenu);
  if (closeBtn) closeBtn.addEventListener('click', closeMenu);
  if (drawerEl) {
    drawerEl.addEventListener('click', function (e) {
      if (e.target === drawerEl) closeMenu();
    });
    drawerEl.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', closeMenu);
    });
  }

  // Update links if user is already logged in
  fetch('/api/auth/me', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.user) return;
      var pairs = [
        ['pnavAuthLink', 'pnavMobileAuthLink'],
        ['pnavCtaLink', 'pnavMobileCtaLink'],
      ];
      pairs.forEach(function (ids) {
        ids.forEach(function (id) {
          var el = document.getElementById(id);
          if (el) { el.href = '/app'; el.textContent = id.includes('Cta') ? 'Go to App' : 'Dashboard'; }
        });
      });
    })
    .catch(function () {});
})();
