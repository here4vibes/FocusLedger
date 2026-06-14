/**
 * shared-nav.js — bottom nav bar + left sidebar (desktop) + hamburger slide-out menu
 * Usage: <script src="/shared-nav.js"></script> — zero other wiring needed
 * Owns: nav DOM injection, active-state detection, menu open/close, desktop sidebar
 * Does NOT own: page routing, auth, any app-specific state
 */

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────

  // Primary tabs — exactly 4, shown in bottom nav (mobile) and sidebar top section (desktop)
  // Routes use /app/* namespace for true isolation — each tab is its own route, not a CSS toggle
  const NAV_ITEMS = [    { label: 'Tasks',  href: '/app/tasks', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>' },
    { label: 'Money',  href: '/app/money', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
    { label: 'Vault',  href: '/app/vault', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>' },
    { label: 'Buddy',  href: '/app/buddy', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
  ];

  // Secondary links — shown in hamburger slide-out (mobile) and sidebar bottom section (desktop)
  const MENU_ITEMS = [
    { label: 'Journal',           href: '/journal',           icon: '📓' },
    { label: 'Routines',          href: '/routines',          icon: '🔄' },
    { label: 'Ideas',             href: '/ideas',             icon: '💡' },
    { label: 'Values',            href: '/values',            icon: '🌟' },
    { label: 'Insights',          href: '/insights',          icon: '📊' },
    { label: 'Email → Tasks',     href: '/email',             icon: '📧' },
    { label: 'Settings',          href: '/settings',          icon: '⚙️' },
    { label: 'Partner Dashboard', href: '/partner-dashboard', icon: '👥' },
    { label: 'Help & Contact',    href: '/contact',           icon: '💬' },
  ];

  // Desktop sidebar: all items merged with a section divider between them
  // MENU_ITEMS that duplicate NAV_ITEMS hrefs are filtered out
  const SIDEBAR_EXTRA_ITEMS = MENU_ITEMS.filter(function (mi) {
    return !NAV_ITEMS.some(function (ni) { return ni.href === mi.href; });
  });

  // Pages where the bottom pill nav must NOT appear — focused flows where it
  // would overlap the page's own input/action area (check-in conversation, focus mode).
  const NO_BOTTOM_NAV_PATHS = [
    '/app/checkin',
    '/app/checkin/evening',
    '/checkin',
    '/check-in/evening',
  ];

  function isBottomNavExcluded() {
    var path = window.location.pathname;
    return NO_BOTTOM_NAV_PATHS.some(function(p) {
      return path === p || path === p + '/' || path.startsWith(p + '/');
    });
  }

  const APP_NAME = 'FocusLedger';

  // ── Stylesheet injection ───────────────────────────────────

  function injectStylesheet() {
    if (document.getElementById('shared-nav-styles')) return;
    var link = document.createElement('link');
    link.id   = 'shared-nav-styles';
    link.rel  = 'stylesheet';
    link.href = '/shared-nav.css';
    document.head.appendChild(link);
  }

  // ── Active page detection ──────────────────────────────────

  function isActive(href) {
    var path = window.location.pathname;
    // /app/tasks is also active for legacy /app root (e.g. old bookmarks that 301 here)
    // and for /app/task/:id and /app/focus/:id sub-routes which belong to the Tasks tab
    if (href === '/app/tasks') {
      return path === '/app/tasks' || path === '/app/tasks/'
        || path === '/app' || path === '/app/'
        || path.startsWith('/app/task/') || path.startsWith('/app/focus/');
    }
    return path === href || path === href + '/' || path.startsWith(href + '/');
  }

  // Returns true if the current page matches a MENU_ITEM (secondary page)
  // but does NOT match any NAV_ITEM — used to show the hamburger dot
  function isOnSecondaryPage() {
    var onPrimary = NAV_ITEMS.some(function (item) { return isActive(item.href); });
    if (onPrimary) return false;
    return MENU_ITEMS.some(function (item) { return isActive(item.href); });
  }

  // ── Build a nav anchor element ─────────────────────────────

  function buildNavAnchor(item, className) {
    var a = document.createElement('a');
    a.href = item.href;
    a.className = className + (isActive(item.href) ? ' active' : '');
    a.setAttribute('aria-current', isActive(item.href) ? 'page' : null);

    // Buddy tab: open panel instead of navigating when widget is loaded
    if (item.label === 'Buddy') {
      a.addEventListener('click', function (e) {
        if (typeof window.openBuddyPanel === 'function') {
          e.preventDefault();
          window.openBuddyPanel();
        }
        // else: fall through to normal navigation (/app/buddy)
      });
    }

    var iconEl = document.createElement('span');
    iconEl.className = 'shared-nav-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.innerHTML = item.icon;

    var labelEl = document.createElement('span');
    labelEl.className = 'shared-nav-label';
    labelEl.textContent = item.label;

    a.appendChild(iconEl);
    a.appendChild(labelEl);
    return a;
  }

  // ── Build mobile bottom nav (≤899px) ──────────────────────
  // Standalone component. Contains ONLY the 4 primary tabs.
  // Desktop sidebar is a completely separate element.

  function buildMobileBottomNav() {
    var nav = document.createElement('nav');
    nav.id = 'shared-bottom-nav';
    nav.setAttribute('aria-label', 'Main navigation');

    // First 2 items: Tasks, Money
    NAV_ITEMS.slice(0, 2).forEach(function (item) {
      nav.appendChild(buildNavAnchor(item, 'shared-nav-item'));
    });

    // Center FAB — calls window.flQuickAdd() if the page has wired it up
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'shared-nav-fab';
    fab.setAttribute('aria-label', 'Quick add');
    fab.textContent = '+';
    fab.addEventListener('click', function () {
      if (typeof window.flQuickAdd === 'function') {
        window.flQuickAdd();
      }
    });
    nav.appendChild(fab);

    // Last 2 items: Vault, Buddy
    NAV_ITEMS.slice(2).forEach(function (item) {
      nav.appendChild(buildNavAnchor(item, 'shared-nav-item'));
    });

    return nav;
  }

  // ── Build desktop sidebar (≥900px) ───────────────────────
  // Standalone component. Contains all secondary pages.
  // Mobile bottom nav is a completely separate element.

  function buildDesktopSidebar() {
    var nav = document.createElement('nav');
    nav.id = 'shared-sidebar';
    nav.setAttribute('aria-label', 'Sidebar navigation');
    nav.setAttribute('aria-hidden', 'false');

    // Brand header — links to home
    var brand = document.createElement('a');
    brand.href = '/app';
    brand.className = 'shared-sidebar-brand';
    brand.style.textDecoration = 'none';
    brand.innerHTML = '<img src="/icons/fl-icon.svg" style="height:28px;width:auto;display:block;flex-shrink:0" alt=""> <span style="font-weight:700;color:rgba(255,255,255,0.95)">Focus</span><span style="font-weight:400;color:#f0b429">Ledger</span>';
    brand.style.display = 'flex';
    brand.style.alignItems = 'center';
    brand.style.gap = '0.5rem';
    nav.appendChild(brand);

    // Primary tab items (same links as mobile bottom nav)
    NAV_ITEMS.forEach(function (item) {
      nav.appendChild(buildNavAnchor(item, 'shared-nav-item'));
    });

    // Divider
    var divider = document.createElement('div');
    divider.className = 'shared-nav-divider';
    divider.setAttribute('aria-hidden', 'true');
    nav.appendChild(divider);

    // Section label
    var sectionLabel = document.createElement('span');
    sectionLabel.className = 'shared-nav-section-label';
    sectionLabel.textContent = 'More';
    nav.appendChild(sectionLabel);

    // Secondary items
    SIDEBAR_EXTRA_ITEMS.forEach(function (item) {
      nav.appendChild(buildNavAnchor(item, 'shared-nav-item'));
    });

    // Sign Out at the bottom
    var signOutDivider = document.createElement('div');
    signOutDivider.className = 'shared-nav-divider';
    signOutDivider.setAttribute('aria-hidden', 'true');
    nav.appendChild(signOutDivider);

    var signOutBtn = document.createElement('button');
    signOutBtn.className = 'shared-nav-item shared-nav-signout';
    signOutBtn.type = 'button';
    signOutBtn.setAttribute('aria-label', 'Sign out');

    var signOutIcon = document.createElement('span');
    signOutIcon.className = 'shared-nav-icon';
    signOutIcon.setAttribute('aria-hidden', 'true');
    signOutIcon.textContent = '🚪';

    var signOutLabel = document.createElement('span');
    signOutLabel.className = 'shared-nav-label';
    signOutLabel.textContent = 'Sign Out';

    signOutBtn.appendChild(signOutIcon);
    signOutBtn.appendChild(signOutLabel);
    signOutBtn.addEventListener('click', handleSignOut);
    nav.appendChild(signOutBtn);

    return nav;
  }

  // ── Build top bar (mobile) ────────────────────────────────
  // Fixed top bar with brain logo on left, hamburger button on right.
  // Hidden on desktop via CSS — sidebar already has the logo.

  function buildTopBar(hamburgerBtn) {
    var bar = document.createElement('header');
    bar.id = 'shared-top-bar';
    bar.setAttribute('role', 'banner');

    var logoLink = document.createElement('a');
    logoLink.href = '/app';
    logoLink.className = 'shared-top-logo';
    logoLink.setAttribute('aria-label', 'FocusLedger home');

    var logoImg = document.createElement('img');
    logoImg.src = '/icons/fl-icon.svg';
    logoImg.alt = '';
    logoImg.setAttribute('aria-hidden', 'true');

    var logoText = document.createElement('span');
    logoText.className = 'shared-top-logo-text';
    logoText.innerHTML = '<span class="fl-focus">Focus</span><span class="fl-ledger">Ledger</span>';

    logoLink.appendChild(logoImg);
    logoLink.appendChild(logoText);

    bar.appendChild(logoLink);
    bar.appendChild(hamburgerBtn);

    return bar;
  }

  // ── Build hamburger button ────────────────────────────────
  // Placed inside #shared-top-bar on mobile; hidden on desktop via CSS.

  function buildHamburgerBtn() {
    var btn = document.createElement('button');
    btn.id = 'shared-hamburger-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'shared-slide-menu');

    for (var i = 0; i < 3; i++) {
      var bar = document.createElement('span');
      bar.className = 'shared-ham-bar';
      bar.setAttribute('aria-hidden', 'true');
      btn.appendChild(bar);
    }

    // Active-page dot — shown when user is on a secondary (menu) page
    // Signals "you're off the primary tabs" without disrupting the hamburger bars
    if (isOnSecondaryPage()) {
      var dot = document.createElement('span');
      dot.className = 'shared-ham-dot';
      dot.setAttribute('aria-hidden', 'true');
      btn.appendChild(dot);
    }

    return btn;
  }

  // ── Build slide-out menu ──────────────────────────────────
  // Hidden on desktop via CSS; mobile only.

  function buildSlideMenu() {
    var overlay = document.createElement('div');
    overlay.id = 'shared-menu-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var menu = document.createElement('aside');
    menu.id = 'shared-slide-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-modal', 'true');
    menu.setAttribute('aria-label', 'Navigation menu');

    // Header
    var header = document.createElement('div');
    header.className = 'shared-menu-header';

    var logo = document.createElement('span');
    logo.className = 'shared-menu-logo';
    logo.innerHTML = '<img src="/icons/fl-icon.svg" style="height:26px;width:auto;display:block;flex-shrink:0" alt=""> <span style="font-weight:700">Focus</span><span style="font-weight:400;color:#f0b429">Ledger</span>';
    logo.style.display = 'flex';
    logo.style.alignItems = 'center';
    logo.style.gap = '0.4rem';

    // PRO badge — hidden by default, shown for Autopilot/Tandem users
    var proBadge = document.createElement('span');
    proBadge.id = 'shared-pro-badge';
    proBadge.className = 'shared-pro-badge';
    proBadge.setAttribute('aria-label', 'Autopilot plan');
    proBadge.textContent = 'AUTOPILOT';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'shared-menu-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.textContent = '✕';

    header.appendChild(logo);
    header.appendChild(proBadge);
    header.appendChild(closeBtn);

    // List
    var ul = document.createElement('ul');
    ul.className = 'shared-menu-list';
    ul.setAttribute('role', 'list');

    MENU_ITEMS.forEach(function (item) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = item.href;
      a.className = 'shared-menu-link' + (isActive(item.href) ? ' active' : '');

      var iconEl = document.createElement('span');
      iconEl.className = 'shared-menu-icon';
      iconEl.setAttribute('aria-hidden', 'true');
      iconEl.textContent = item.icon;

      var labelEl = document.createElement('span');
      labelEl.textContent = item.label;

      a.appendChild(iconEl);
      a.appendChild(labelEl);
      li.appendChild(a);
      ul.appendChild(li);
    });

    // Sign Out — separated by a visual divider
    var signOutLi = document.createElement('li');
    signOutLi.className = 'shared-menu-signout-item';

    var signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.className = 'shared-menu-link shared-menu-signout-btn';
    signOutBtn.setAttribute('aria-label', 'Sign out of FocusLedger');

    var signOutIcon = document.createElement('span');
    signOutIcon.className = 'shared-menu-icon';
    signOutIcon.setAttribute('aria-hidden', 'true');
    signOutIcon.textContent = '🚪';

    var signOutLabel = document.createElement('span');
    signOutLabel.textContent = 'Sign Out';

    signOutBtn.appendChild(signOutIcon);
    signOutBtn.appendChild(signOutLabel);
    signOutBtn.addEventListener('click', handleSignOut);
    signOutLi.appendChild(signOutBtn);
    ul.appendChild(signOutLi);

    menu.appendChild(header);
    menu.appendChild(ul);

    return { overlay: overlay, menu: menu, closeBtn: closeBtn };
  }

  // ── Sign Out ───────────────────────────────────────────────

  function handleSignOut() {
    localStorage.removeItem('fl_token');
    window.location.href = '/login';
  }

  // ── PRO Badge — fetch subscription status and show/hide ──

  function fetchSubscriptionStatus() {
    var token = (window.FLToken || localStorage.getItem('fl_token') || '');
    if (!token) return;

    fetch('/api/subscription/status', {
      headers: { Authorization: 'Bearer ' + token }
    })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.success) return;
        var badge = document.getElementById('shared-pro-badge');
        if (!badge) return;
        var sub = data.subscription;
        if (sub.is_pro || sub.is_tandem) {
          var label = sub.is_tandem ? 'TANDEM' : (sub.plan_label || 'AUTOPILOT').toUpperCase();
          badge.textContent = label;
          badge.classList.add('visible');
        } else {
          badge.classList.remove('visible');
        }
      })
      .catch(function() {});
  }

  function setupMenuLogic(hamburgerBtn, overlay, menu, closeBtn) {
    function openMenu() {
      hamburgerBtn.classList.add('open');
      hamburgerBtn.setAttribute('aria-expanded', 'true');
      hamburgerBtn.setAttribute('aria-label', 'Close menu');
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
      menu.classList.add('open');
      document.body.style.overflow = 'hidden';
      // Trap focus: focus first menu link
      var firstLink = menu.querySelector('.shared-menu-link');
      if (firstLink) setTimeout(function () { firstLink.focus(); }, 50);
    }

    function closeMenu() {
      hamburgerBtn.classList.remove('open');
      hamburgerBtn.setAttribute('aria-expanded', 'false');
      hamburgerBtn.setAttribute('aria-label', 'Open menu');
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      menu.classList.remove('open');
      document.body.style.overflow = '';
      hamburgerBtn.focus();
    }

    hamburgerBtn.addEventListener('click', function () {
      if (hamburgerBtn.classList.contains('open')) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    overlay.addEventListener('click', closeMenu);
    closeBtn.addEventListener('click', closeMenu);

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && menu.classList.contains('open')) {
        closeMenu();
      }
    });

    // Close menu when a link is followed (navigation)
    menu.addEventListener('click', function (e) {
      if (e.target.closest('.shared-menu-link')) {
        closeMenu();
      }
    });
  }

  // ── Viewport detection ──────────────────────────────────────
  // Breakpoint: 899px. Mobile is ≤899px, desktop is ≥900px.
  // Determined at init AND re-checked on resize/rotation so it
  // adapts live — no stale sign-in-time decision.

  var _viewportChecked = false;

  function isMobileViewport() {
    return window.matchMedia('(max-width: 899px)').matches;
  }

  function onViewportChange() {
    // Debounce resize to avoid thrashing DOM
    if (_viewportChecked) return;
    _viewportChecked = true;
    setTimeout(function () { _viewportChecked = false; }, 250);
    // Reload to swap the shell — viewport change is rare (rotation, resize to
    // a meaningful breakpoint) so a full page re-init is acceptable and ensures
    // the correct shell is always in the DOM.
    window.location.reload();
  }

  // ── Init ──────────────────────────────────────────────────

  // Dynamically load spring.js (it's in /lib/ on the server, served as static)
  function loadSpring(cb) {
    if (window.FLSpring) { cb(); return; }
    var s = document.createElement('script');
    s.src = '/lib/spring.js';
    s.onload = cb;
    s.onerror = cb; // graceful fallback — skip spring if load fails
    document.head.appendChild(s);
  }

  function init() {
    injectStylesheet();

    fetchSubscriptionStatus();

    // Determine which shell to render based on current viewport.
    // The OTHER shell is NEVER appended to the DOM — duplication is
    // structurally impossible, not just hidden by CSS.
    var mobileView = isMobileViewport();

    // Mark body so CSS can target each shell without relying solely on media queries
    document.body.setAttribute('data-nav-shell', mobileView ? 'mobile' : 'desktop');
    document.body.classList.add('shared-nav-active');

    // Build hamburger + top bar (hamburger lives inside top bar on mobile;
    // CSS hides the whole bar on desktop where the sidebar has the logo).
    var hamburgerBtn = buildHamburgerBtn();
    var parts         = buildSlideMenu();
    var overlay        = parts.overlay;
    var menu           = parts.menu;
    var closeBtn       = parts.closeBtn;

    var topBar = buildTopBar(hamburgerBtn);
    document.body.appendChild(topBar);
    document.body.appendChild(overlay);
    document.body.appendChild(menu);

    // Only inject the shell that matches the current viewport.
    // On focused flow pages (check-in, focus mode) the pill collapses to a small
    // circle so it doesn't cover the page's input — tap to temporarily expand.
    if (mobileView) {
      var mobileNav = buildMobileBottomNav();
      if (isBottomNavExcluded()) {
        mobileNav.classList.add('nav-collapsed');
        // Remove bottom padding — collapsed circle doesn't need the full 90px clearance
        document.body.style.paddingBottom = 'calc(72px + env(safe-area-inset-bottom, 0px))';
        // Tap collapsed circle → expand for 4s then re-collapse
        var collapseTimer = null;
        mobileNav.addEventListener('click', function (e) {
          if (!mobileNav.classList.contains('nav-collapsed')) return;
          e.stopPropagation();
          mobileNav.classList.remove('nav-collapsed');
          clearTimeout(collapseTimer);
          collapseTimer = setTimeout(function () {
            mobileNav.classList.add('nav-collapsed');
          }, 4000);
        });
      }
      document.body.appendChild(mobileNav);
    } else {
      var desktopNav = buildDesktopSidebar();
      document.body.appendChild(desktopNav);
    }

    setupMenuLogic(hamburgerBtn, overlay, menu, closeBtn);

    // ── Page transitions — fade content on navigation ──────────────────
    document.addEventListener('click', function (e) {
      var anchor = e.target.closest('a[href]');
      if (!anchor) return;
      var href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http') ||
          href.startsWith('mailto:') || href.startsWith('tel:')) return;
      document.body.classList.add('transitioning-out');
      setTimeout(function () {
        document.body.classList.remove('transitioning-out');
        document.body.classList.add('transitioning-in');
        setTimeout(function () {
          document.body.classList.remove('transitioning-in');
        }, 250);
      }, 120);
    });

    // ── Spring slide on active nav item ─────────────────────────────────
    loadSpring(function() {
      var reduced = (window.FLHaptics && FLHaptics.prefersReducedMotion())
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return;

      // Active item lives in whichever shell was rendered (mobile or desktop)
      var activeItem = document.querySelector('#shared-bottom-nav .shared-nav-item.active')
        || document.querySelector('#shared-sidebar .shared-nav-item.active');
      if (!activeItem) return;

      var icon = activeItem.querySelector('.shared-nav-icon');
      if (!icon) return;

      var scale = 0;
      var raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame;
      function tick() {
        scale = Math.min(scale + 0.08, 1.12);
        icon.style.transform = 'scale(' + scale + ')';
        if (scale < 1.12) {
          raf(tick);
        } else {
          var settle = { v: 1.12 };
          function settleTick() {
            settle.v = settle.v * 0.88 + 1.0 * 0.12;
            icon.style.transform = 'scale(' + settle.v + ')';
            if (Math.abs(settle.v - 1.0) > 0.003) {
              (window.requestAnimationFrame || window.webkitRequestAnimationFrame)(settleTick);
            } else {
              icon.style.transform = '';
            }
          }
          (window.requestAnimationFrame || window.webkitRequestAnimationFrame)(settleTick);
        }
      }
      raf(tick);

      activeItem.addEventListener('pointerdown', function() {
        if (window.FLHaptics) FLHaptics.light();
      }, { passive: true });
    });
  }

  // ── FLNav public API ─────────────────────────────────────────────
  // window.FLNav.collapse() — shrink nav to dot and move to top-bar corner.
  // window.FLNav.restore()  — expand back to full pill at bottom.
  // Called automatically when any *.overlay element gets/loses 'open' class.
  // Pages can also call directly for overlays that toggle display instead.

  var _overlayDepth = 0;

  window.FLNav = {
    collapse: function () {
      _overlayDepth++;
      var nav = document.getElementById('shared-bottom-nav');
      if (!nav) return;
      nav.classList.add('nav-collapsed', 'nav-overlay-mode');
    },
    restore: function () {
      _overlayDepth = Math.max(0, _overlayDepth - 1);
      if (_overlayDepth > 0) return;
      var nav = document.getElementById('shared-bottom-nav');
      if (!nav) return;
      nav.classList.remove('nav-collapsed', 'nav-overlay-mode');
    },
    forceRestore: function () {
      _overlayDepth = 0;
      var nav = document.getElementById('shared-bottom-nav');
      if (nav) nav.classList.remove('nav-collapsed', 'nav-overlay-mode');
    }
  };

  // ── Auto-detect overlays via MutationObserver ─────────────────────
  // Watches for any element with 'overlay' in its class or id gaining/losing
  // the 'open' class. Zero per-page wiring needed — just use .classList.add('open').

  function isOverlayEl(el) {
    var cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
    return cls.toLowerCase().includes('overlay');
  }

  var _observerReady = false;
  function startOverlayObserver() {
    if (_observerReady || typeof MutationObserver === 'undefined') return;
    _observerReady = true;

    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type !== 'attributes' || m.attributeName !== 'class') return;
        var el = m.target;
        if (!isOverlayEl(el)) return;
        var nowOpen  = el.classList.contains('open');
        var wasOpen  = m.oldValue ? m.oldValue.split(' ').indexOf('open') > -1 : false;
        if (nowOpen && !wasOpen)  window.FLNav.collapse();
        if (!nowOpen && wasOpen)  window.FLNav.restore();
      });
    });

    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
  }

  // ── Init ──────────────────────────────────────────────────

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); startOverlayObserver(); });
  } else {
    init();
    startOverlayObserver();
  }

})();
