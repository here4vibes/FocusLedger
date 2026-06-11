// plaid-service.js — shared Plaid Link initialization and bank account management
// Loaded by any page that needs Connect Bank / bank sync status
// All API calls go through the backend; no Plaid secrets ever reach the browser

(function (global) {
  'use strict';

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function authHeaders() {
    return {
      Authorization: 'Bearer ' + (localStorage.getItem('fl_token') || ''),
      'Content-Type': 'application/json',
    };
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function showBankSyncToast(type, message) {
    var toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast visible ' + type;
    toast.style.display = 'block';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { toast.style.display = 'none'; }, 4000);
  }

  function relativeTime(isoString) {
    if (!isoString) return 'never';
    var diff = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  // ── Open Plaid Link ─────────────────────────────────────────────────────────

  function openPlaidLink(linkToken, btn, errEl, originalText) {
    if (!window.Plaid) {
      if (errEl) { errEl.textContent = 'Couldn\u2019t load the bank connection tool. Check your internet.'; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; if (originalText) btn.textContent = originalText; }
      return;
    }
    var handler = window.Plaid.create({
      token: linkToken,
      onSuccess: function (publicToken, metadata) {
        var institutionName = metadata && metadata.institution ? metadata.institution.name : 'Your Bank';
        var institutionId   = metadata && metadata.institution ? metadata.institution.institution_id : null;

        fetch('/api/plaid/exchange-token', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ public_token: publicToken, institution_name: institutionName, institution_id: institutionId }),
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (btn) { btn.disabled = false; if (originalText) btn.textContent = originalText; }
          if (data.success) {
            showBankSyncToast('', '\u2713 Connected to ' + (data.institution_name || institutionName) + '.');
            if (typeof onBankSyncStatusChanged === 'function') onBankSyncStatusChanged();
          } else {
            if (errEl) { errEl.textContent = data.message || 'That connection didn\u2019t go through. Try again?'; errEl.style.display = 'block'; }
          }
        })
        .catch(function () {
          if (errEl) { errEl.textContent = 'Connection didn\u2019t save. Try again.'; errEl.style.display = 'block'; }
          if (btn) { btn.disabled = false; if (originalText) btn.textContent = originalText; }
        });
      },
      onExit: function (err) {
        if (btn) { btn.disabled = false; if (originalText) btn.textContent = originalText; }
        if (err && err.error_code !== 'USER_CANCELLED') {
          if (errEl) { errEl.textContent = err.error_message || 'Connection interrupted. Try again.'; errEl.style.display = 'block'; }
        }
      },
    });
    handler.open();
  }

  // ── Init Plaid Link (fetch token then open) ────────────────────────────────

  function initPlaidLink(btn) {
    if (btn) { btn.disabled = true; var originalText = btn.textContent; btn.textContent = 'Connecting...'; }
    // Look for bankErrorMsg inside the button's closest card/container, not globally
    // This avoids conflicts when multiple #bankErrorMsg exist in the DOM
    var errEl = btn ? btn.parentElement?.querySelector('[id="bankErrorMsg"]') : null;
    if (!errEl) errEl = document.getElementById('bankErrorMsg');

    fetch('/api/plaid/create-link-token', {
      method: 'POST',
      headers: authHeaders(),
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success || !data.link_token) {
        if (errEl) { errEl.textContent = data.message || 'Connection didn\u2019t start. Try again?'; errEl.style.display = 'block'; }
        if (btn) { btn.disabled = false; if (originalText) btn.textContent = originalText; }
        return;
      }
      if (window.Plaid) {
        openPlaidLink(data.link_token, btn, errEl, originalText);
      } else {
        var script = document.createElement('script');
        script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
        script.onload = function () { openPlaidLink(data.link_token, btn, errEl, originalText); };
        script.onerror = function () {
          if (errEl) { errEl.textContent = 'Couldn\u2019t load the bank connection tool. Check your internet.'; errEl.style.display = 'block'; }
          if (btn) { btn.disabled = false; if (originalText) btn.textContent = originalText; }
        };
        document.head.appendChild(script);
      }
    })
    .catch(function () {
      if (errEl) { errEl.textContent = 'Connection didn\u2019t go through. Try again?'; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; if (originalText) btn.textContent = originalText; }
    });
  }

  // ── Disconnect ──────────────────────────────────────────────────────────────

  function disconnectBankAccount(itemId) {
    fetch('/api/plaid/items/' + itemId, { method: 'DELETE', headers: authHeaders() })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.success) {
        showBankSyncToast('', 'Account disconnected.');
        if (typeof onBankSyncStatusChanged === 'function') onBankSyncStatusChanged();
      }
    })
    .catch(function () { showBankSyncToast('', 'Failed to disconnect. Try again.'); });
  }

  // ── Reconnect (Plaid update mode) ───────────────────────────────────────────

  function reconnectBankAccount(itemId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Reconnecting…'; }
    var errEl = btn ? btn.closest('.dash-card')?.querySelector('.bank-reconnect-err') : null;

    fetch('/api/plaid/create-update-token', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ item_id: itemId }),
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success || !data.link_token) {
        if (btn) { btn.disabled = false; btn.textContent = 'Reconnect'; }
        showBankSyncToast('error', data.message || 'Could not start reconnect. Try again?');
        return;
      }
      if (window.Plaid) {
        openReconnectLink(data.link_token, btn);
      } else {
        var script = document.createElement('script');
        script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
        script.onload = function () { openReconnectLink(data.link_token, btn); };
        script.onerror = function () {
          if (btn) { btn.disabled = false; btn.textContent = 'Reconnect'; }
          showBankSyncToast('error', "Couldn't load the connection tool. Check your internet.");
        };
        document.head.appendChild(script);
      }
    })
    .catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Reconnect'; }
      showBankSyncToast('error', "Reconnect didn't start. Try again.");
    });
  }

  function openReconnectLink(linkToken, btn) {
    var handler = window.Plaid.create({
      token: linkToken,
      onSuccess: function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Reconnect'; }
        showBankSyncToast('', '✓ Connection refreshed.');
        if (typeof onBankSyncStatusChanged === 'function') onBankSyncStatusChanged();
      },
      onExit: function (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Reconnect'; }
        if (err && err.error_code !== 'USER_CANCELLED') {
          showBankSyncToast('error', err.error_message || 'Reconnect interrupted. Try again.');
        }
      },
    });
    handler.open();
  }

  // ── Load + Render Status ────────────────────────────────────────────────────

  function loadBankSyncStatus(containerId, opts) {
    opts = opts || {};
    var container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);text-align:center;padding:1rem;">Loading...</p>';

    fetch('/api/plaid/status', { headers: authHeaders() })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success) {
        container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);">Could not load bank status. <button id="retryBankBtn" style="color:var(--orange);background:none;border:none;cursor:pointer;font-family:inherit;font-size:inherit;text-decoration:underline;">Retry</button></p>';
        var retryBtn = document.getElementById('retryBankBtn');
        if (retryBtn) retryBtn.addEventListener('click', function () { loadBankSyncStatus(containerId, opts); });
        return;
      }

      // Not Pro
      if (!data.is_pro) {
        var upgradeBtn = opts.showUpgradeButton !== false
          ? '<button id="bankUpgradeBtn" style="background:var(--orange);color:white;border:none;padding:0.6rem 1.25rem;border-radius:8px;font-size:0.875rem;font-weight:600;cursor:pointer;min-height:44px;">Switch to Autopilot</button>'
          : '';
        container.innerHTML = '<p style="font-size:0.88rem;color:var(--text-muted);margin-bottom:0.75rem;">Bank sync is an <a href="#" onclick="event.preventDefault();if(window.openUpgradeModal)openUpgradeModal();" style="color:var(--orange);font-weight:600;">Autopilot</a> feature.</p>' + upgradeBtn;
        var bankUpgradeBtn = document.getElementById('bankUpgradeBtn');
        if (bankUpgradeBtn) bankUpgradeBtn.addEventListener('click', function () { if (window.openUpgradeModal) window.openUpgradeModal(); });
        return;
      }

      // Not configured
      if (!data.is_configured) {
        container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);">Bank sync is being set up \u2014 check back shortly.</p>';
        return;
      }

      var items = data.items || [];

      // No connected accounts — show CTA
      if (items.length === 0) {
        var html = '<p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem;line-height:1.5;">Sync transactions automatically. Categorized and ready to review. Uses Plaid, bank-grade 256-bit encryption.</p>';
        html += '<div style="display:flex;align-items:center;gap:0.6rem;font-size:0.8rem;color:var(--green-muted,#4A9292);margin-bottom:0.75rem;">';
        html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        html += 'Bank access tokens encrypted with AES-256-GCM</div>';
        html += '<button id="connectBankBtn" style="background:var(--green);color:white;border:none;padding:0.6rem 1.25rem;border-radius:8px;font-size:0.875rem;font-weight:600;cursor:pointer;min-height:44px;font-family:\u27e8DM Sans\u27e9,sans-serif;transition:opacity 0.15s;-webkit-tap-highlight-color:rgba(91,164,164,0.3);touch-action:manipulation;">Connect Bank</button>';
        html += '<div id="bankErrorMsg" style="display:none;margin-top:0.75rem;font-size:0.82rem;color:#E05252;padding:0.6rem 0.9rem;background:#FFF0EE;border-radius:8px;"></div>';
        container.innerHTML = html;
        attachConnectBankHandlers('connectBankBtn', opts.onConnected);
        return;
      }

      // Connected accounts
      var html = '';
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var instName = escHtml(item.institution_name || 'Connected Account');
        var synced    = relativeTime(item.last_synced_at);
        var accounts  = item.accounts || [];
        html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;padding:0.75rem 0;border-bottom:1px solid #F0EEE9;">';
        html += '<div style="display:flex;align-items:center;gap:0.75rem;">';
        html += '<div style="width:36px;height:36px;border-radius:8px;background:#F0F5F5;display:flex;align-items:center;justify-content:center;font-size:1.1rem;">🏦</div>';
        html += '<div>';
        html += '<div style="font-weight:600;font-size:0.92rem;">' + instName + '</div>';
        html += '<div style="font-size:0.78rem;color:var(--text-muted);">Synced ' + synced + (accounts.length ? ' \u00b7 ' + accounts.length + ' account' + (accounts.length !== 1 ? 's' : '') : '') + '</div>';
        html += '</div></div>';
        html += '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">';
        html += '<span style="font-size:0.78rem;font-weight:600;color:var(--green-muted,#4A9292);background:rgba(91,164,164,0.1);border-radius:20px;padding:2px 10px;">● Synced</span>';
        html += '<button id="disconnectBankBtn' + i + '" style="font-size:0.78rem;color:var(--text-muted);background:none;border:none;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit;min-height:44px;min-width:44px;">Disconnect</button>';
        html += '</div></div>';
      }

      if (data.pending_review_count > 0) {
        html += '<p style="font-size:0.82rem;color:var(--text-muted);margin-top:0.75rem;">';
        html += '<a href="/app/money" style="color:var(--orange);font-weight:600;text-decoration:none;">' + data.pending_review_count + ' transaction' + (data.pending_review_count !== 1 ? 's' : '') + ' to review</a></p>';
      }

      html += '<button id="connectAnotherBankBtn" style="margin-top:0.75rem;background:var(--cream-dark);color:var(--navy);border:1.5px solid var(--border);padding:0.5rem 1rem;border-radius:8px;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:\u27e8DM Sans\u27e9,sans-serif;min-height:44px;">+ Connect another account</button>';
      html += '<div id="bankErrorMsg" style="display:none;margin-top:0.75rem;font-size:0.82rem;color:#E05252;padding:0.6rem 0.9rem;background:#FFF0EE;border-radius:8px;"></div>';
      container.innerHTML = html;

      // Disconnect handlers
      for (var j = 0; j < items.length; j++) {
        var dbBtn = document.getElementById('disconnectBankBtn' + j);
        if (dbBtn) {
          (function (itemId, instName) {
            dbBtn.addEventListener('click', function () {
              if (confirm('Disconnect ' + instName + '? This will remove the connection and stop syncing.')) {
                disconnectBankAccount(itemId);
              }
            });
          })(items[j].id, items[j].institution_name || 'this account');
        }
      }

      // Connect another handler
      attachConnectBankHandlers('connectAnotherBankBtn', opts.onConnected);
    })
    .catch(function (err) {
      console.error('[plaid-service] Failed to load bank status:', err);
      container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);">Could not load bank sync. <button id="retryBankBtn" style="color:var(--orange);background:none;border:none;cursor:pointer;font-family:inherit;font-size:inherit;text-decoration:underline;">Retry</button></p>';
      var retryBtn = document.getElementById('retryBankBtn');
      if (retryBtn) retryBtn.addEventListener('click', function () { loadBankSyncStatus(containerId, opts); });
    });
  }

  // ── Attach Connect Bank handlers (touch + click dedup) ─────────────────────

  function attachConnectBankHandlers(btnId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    var _touchFired = false;
    btn.addEventListener('touchend', function (e) {
      e.preventDefault();
      _touchFired = true;
      initPlaidLink(btn);
    });
    btn.addEventListener('click', function () {
      if (_touchFired) { _touchFired = false; return; }
      initPlaidLink(btn);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  global.PlaidService = {
    initPlaidLink: initPlaidLink,
    openPlaidLink: function (linkToken) { openPlaidLink(linkToken, null, null, null); },
    disconnectBankAccount: disconnectBankAccount,
    reconnectBankAccount: reconnectBankAccount,
    loadBankSyncStatus: loadBankSyncStatus,
    showBankSyncToast: showBankSyncToast,
    relativeTime: relativeTime,
  };

})(window);