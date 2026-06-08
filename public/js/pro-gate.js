/**
 * pro-gate.js — Shared Pro gate modal for FocusLedger
 *
 * Owns: rendering + dismissing the "This is a Pro feature" upgrade prompt.
 * Does NOT own: Pro status checks (backend), subscription state (routes/subscription.js).
 *
 * Usage:
 *   FLProGate.show({ feature: 'Bank Sync', description: 'Connect your bank to auto-import transactions.' });
 *
 * One modal per DOM; rendered lazily on first call. Dismissable, no guilt.
 * Checkout is handled via PricingService (pricing-service.js) — no hardcoded links here.
 */
(function(global) {
  'use strict';

  var _modalEl = null;
  var _isAnnual = false;

  function _inject() {
    if (_modalEl) return;

    // Styles
    var style = document.createElement('style');
    style.textContent = [
      '.fl-pro-gate-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(45,42,38,0.55);z-index:9999;align-items:center;justify-content:center;padding:1rem;}',
      '.fl-pro-gate-overlay.visible{display:flex;}',
      '.fl-pro-gate-card{background:#fff;border-radius:20px;padding:2rem 1.75rem;max-width:400px;width:100%;box-shadow:0 24px 80px rgba(45,42,38,0.22);text-align:center;position:relative;font-family:"DM Sans",sans-serif;}',
      '.fl-pg-close{position:absolute;top:0.9rem;right:1rem;background:none;border:none;cursor:pointer;font-size:1.15rem;color:#9e9b96;line-height:1;padding:0.25rem;}',
      '.fl-pg-close:hover{color:#011e5c;}',
      '.fl-pg-badge{display:inline-block;background:#c9a84c;color:#fff;font-size:0.72rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;border-radius:20px;padding:0.28rem 0.85rem;margin-bottom:0.9rem;}',
      '.fl-pg-title{font-family:"Space Grotesk",sans-serif;font-size:1.25rem;font-weight:700;color:#011e5c;margin-bottom:0.4rem;line-height:1.3;}',
      '.fl-pg-desc{font-size:0.88rem;color:#6b6b6b;margin-bottom:1.4rem;line-height:1.5;}',
      '.fl-pg-toggle{display:flex;align-items:center;justify-content:center;gap:0.65rem;margin-bottom:1.2rem;}',
      '.fl-pg-toggle-label{font-size:0.85rem;color:#9e9b96;cursor:pointer;transition:color 0.2s;}',
      '.fl-pg-toggle-label.active{color:#011e5c;font-weight:600;}',
      '.fl-pg-switch{width:38px;height:21px;background:#E8E5E0;border-radius:11px;cursor:pointer;position:relative;transition:background 0.2s;}',
      '.fl-pg-switch.annual{background:#c9a84c;}',
      '.fl-pg-switch .knob{width:17px;height:17px;background:#fff;border-radius:50%;position:absolute;top:2px;left:2px;transition:transform 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.15);}',
      '.fl-pg-switch.annual .knob{transform:translateX(17px);}',
      '.fl-pg-save{font-size:0.7rem;font-weight:700;color:#5BA4A4;background:rgba(91,164,164,0.12);border-radius:10px;padding:0.18rem 0.55rem;}',
      '.fl-pg-price{font-family:"Space Grotesk",sans-serif;font-size:2.4rem;font-weight:700;color:#011e5c;line-height:1;margin-bottom:0.2rem;}',
      '.fl-pg-price sup{font-size:1.1rem;vertical-align:top;margin-top:0.45rem;}',
      '.fl-pg-period{font-size:0.82rem;color:#9e9b96;margin-bottom:1.4rem;}',
      '.fl-pg-cta{display:block;width:100%;padding:0.85rem;background:#c9a84c;color:#fff;border:none;border-radius:12px;font-family:"DM Sans",sans-serif;font-size:0.98rem;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;transition:background 0.2s,transform 0.1s;}',
      '.fl-pg-cta:hover{background:#d4b56a;transform:translateY(-1px);}',
      '.fl-pg-dismiss{display:block;margin-top:0.75rem;font-size:0.82rem;color:#9e9b96;background:none;border:none;cursor:pointer;font-family:inherit;width:100%;text-align:center;}',
      '.fl-pg-dismiss:hover{color:#011e5c;text-decoration:underline;}'
    ].join('');
    document.head.appendChild(style);

    // Markup — CTA is a button; checkout handled by PricingService below
    var div = document.createElement('div');
    div.className = 'fl-pro-gate-overlay';
    div.id = 'flProGateOverlay';
    div.innerHTML = [
      '<div class="fl-pro-gate-card">',
        '<button class="fl-pg-close" id="flPgClose">✕</button>',
        '<div class="fl-pg-badge">Autopilot Feature</div>',
        '<div class="fl-pg-title" id="flPgTitle">This is an Autopilot feature</div>',
        '<div class="fl-pg-desc" id="flPgDesc">Upgrade to unlock it.</div>',
        '<div class="fl-pg-toggle">',
          '<span class="fl-pg-toggle-label active" id="flPgMonthly">Monthly</span>',
          '<div class="fl-pg-switch" id="flPgSwitch"><div class="knob"></div></div>',
          '<span class="fl-pg-toggle-label" id="flPgAnnual">Annual</span>',
          '<span class="fl-pg-save">Save ~$20/yr</span>',
        '</div>',
        '<div class="fl-pg-price"><sup>$</sup><span id="flPgPriceNum">9.99</span></div>',
        '<div class="fl-pg-period" id="flPgPeriod">per month, billed monthly</div>',
        '<button class="fl-pg-cta" id="flPgCta">Switch to Autopilot — $9.99/mo</button>',
        '<button class="fl-pg-dismiss" id="flPgDismiss">Maybe later</button>',
      '</div>'
    ].join('');
    document.body.appendChild(div);
    _modalEl = div;

    // Event wiring
    function close() {
      _modalEl.classList.remove('visible');
      document.body.style.overflow = '';
    }

    function setPricing() {
      var sw   = document.getElementById('flPgSwitch');
      var num  = document.getElementById('flPgPriceNum');
      var per  = document.getElementById('flPgPeriod');
      var cta  = document.getElementById('flPgCta');
      var ml   = document.getElementById('flPgMonthly');
      var al   = document.getElementById('flPgAnnual');
      if (_isAnnual) {
        sw.classList.add('annual');
        ml.classList.remove('active'); al.classList.add('active');
        num.textContent = '8.33';
        per.textContent = 'per month, billed as $100/year — save ~$20';
        cta.textContent = 'Switch to Autopilot — $100/year';
      } else {
        sw.classList.remove('annual');
        ml.classList.add('active'); al.classList.remove('active');
        num.textContent = '9.99';
        per.textContent = 'per month, billed monthly — cancel anytime';
        cta.textContent = 'Switch to Autopilot — $9.99/mo';
      }
    }

    document.getElementById('flPgSwitch').addEventListener('click', function() { _isAnnual = !_isAnnual; setPricing(); });
    document.getElementById('flPgMonthly').addEventListener('click', function() { _isAnnual = false; setPricing(); });
    document.getElementById('flPgAnnual').addEventListener('click', function() { _isAnnual = true; setPricing(); });
    document.getElementById('flPgClose').addEventListener('click', close);
    document.getElementById('flPgDismiss').addEventListener('click', close);
    _modalEl.addEventListener('click', function(e) { if (e.target === _modalEl) close(); });

    // CTA uses PricingService when available, falls back to navigation
    document.getElementById('flPgCta').addEventListener('click', function() {
      var billing = _isAnnual ? 'annual' : 'monthly';
      if (global.PricingService) {
        PricingService.checkout('autopilot', billing, this);
      } else {
        window.location.href = '/pricing';
      }
    });
  }

  /**
   * Show the Pro gate modal.
   * @param {object} opts
   * @param {string} opts.feature      - Feature name, e.g. "Bank Sync"
   * @param {string} [opts.description] - One-line value prop for what the user tried to access
   */
  function show(opts) {
    opts = opts || {};
    _inject();
    var title = document.getElementById('flPgTitle');
    var desc  = document.getElementById('flPgDesc');
    if (title) title.textContent = opts.feature ? opts.feature + ' is an Autopilot feature' : 'This is an Autopilot feature';
    if (desc)  desc.textContent  = opts.description || 'Switch to Autopilot to unlock this and everything else we ship.';
    _isAnnual = false;
    var sw  = document.getElementById('flPgSwitch');  if (sw)  sw.classList.remove('annual');
    var ml  = document.getElementById('flPgMonthly'); if (ml)  { ml.classList.add('active'); }
    var al  = document.getElementById('flPgAnnual');  if (al)  { al.classList.remove('active'); }
    var num = document.getElementById('flPgPriceNum'); if (num) num.textContent = '9.99';
    var per = document.getElementById('flPgPeriod');   if (per) per.textContent = 'per month, billed monthly — cancel anytime';
    var cta = document.getElementById('flPgCta');      if (cta) cta.textContent = 'Switch to Autopilot — $9.99/mo';
    _modalEl.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  global.FLProGate = { show: show };
})(window);
