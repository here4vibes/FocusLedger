/**
 * ios-push.js — APNs push notification registration for iOS (Capacitor) users.
 *
 * Called once on app launch. Uses @capacitor/push-notifications to:
 *   1. Detect if running in a Capacitor native context (iOS app vs browser).
 *   2. Request permission from the user.
 *   3. Register with APNs and get the device token.
 *   4. POST the token to /api/push/register so the backend can send to this device.
 *   5. Handle foreground notifications (show in-app banner).
 *   6. Handle notification taps (deep-link to relevant page).
 *
 * Only loaded in the iOS native shell — harmless no-op in a browser.
 * Included in app.html and home.html via <script> after the auth check.
 */

(function () {
  'use strict';

  // Capacitor is injected by the native shell at runtime.
  // In a browser, Capacitor is undefined and this entire module exits safely.
  const Capacitor = window.Capacitor;
  if (!Capacitor || !Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) {
    return;
  }

  // PushNotifications plugin from @capacitor/push-notifications
  const { PushNotifications } = Capacitor.Plugins;
  if (!PushNotifications) {
    return;
  }

  /**
   * POST the device token to the backend so it can be stored in push_tokens.
   * Called once per app launch after registration succeeds.
   * Token is idempotent — backend uses ON CONFLICT DO UPDATE.
   */
  async function registerTokenWithBackend(token) {
    const authToken = localStorage.getItem('focusledger_token');
    if (!authToken) return; // not logged in yet — handled on next launch after login

    try {
      const res = await fetch('/api/push/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body: JSON.stringify({ token, platform: 'ios' }),
      });
      if (!res.ok) {
        console.warn('[ios-push] Token registration failed:', res.status);
      }
    } catch (err) {
      console.warn('[ios-push] Token registration error:', err.message);
    }
  }

  /**
   * Deep-link handler: navigate to the relevant page when a notification is tapped.
   * The notification data.url is set by the backend when building the APNs payload.
   * Falls back to /app if no URL is present.
   */
  function handleNotificationTap(notification) {
    const url = notification?.data?.url || '/app';
    // Use location.href to do a full navigation (service worker handles it)
    if (url && url.startsWith('/')) {
      window.location.href = url;
    }
  }

  /**
   * initIosPush()
   * Main entry point. Requests permission, registers for push, and wires up listeners.
   * Fails gracefully at each step — no throws, no user-visible errors.
   */
  async function initIosPush() {
    try {
      // Step 1: Check current permission status
      let permStatus = await PushNotifications.checkPermissions();

      // Step 2: Request permission if not already granted
      if (permStatus.receive === 'prompt') {
        permStatus = await PushNotifications.requestPermissions();
      }

      if (permStatus.receive !== 'granted') {
        // User denied — respect it, do nothing
        return;
      }

      // Step 3: Register with APNs — triggers the 'registration' event below
      await PushNotifications.register();

      // Step 4: Listen for the device token (fires after APNs assigns a token)
      PushNotifications.addListener('registration', async (token) => {
        await registerTokenWithBackend(token.value);
      });

      // Step 5: Handle registration errors (e.g. APNs unreachable in simulator)
      PushNotifications.addListener('registrationError', (err) => {
        console.warn('[ios-push] Registration error:', err.error);
      });

      // Step 6: Foreground notification received — show a simple in-app banner
      // WHY: APNs doesn't auto-show alerts when the app is in the foreground on iOS;
      // we handle it ourselves so the user sees something without leaving the app.
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        const title = notification?.title || 'FocusLedger';
        const body  = notification?.body  || '';
        showInAppBanner(title, body, notification?.data?.url);
      });

      // Step 7: Notification tapped (app was in background or killed)
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        handleNotificationTap(action?.notification);
      });

    } catch (err) {
      console.warn('[ios-push] Init error:', err.message);
    }
  }

  /**
   * showInAppBanner(title, body, url)
   * Displays a minimal top-of-screen banner for foreground notifications.
   * Auto-dismisses after 4 seconds. Tapping navigates to url.
   */
  function showInAppBanner(title, body, url) {
    // Only one banner at a time
    const existingBanner = document.getElementById('fl-ios-push-banner');
    if (existingBanner) existingBanner.remove();

    const banner = document.createElement('div');
    banner.id = 'fl-ios-push-banner';
    banner.style.cssText = [
      'position:fixed', 'top:env(safe-area-inset-top,0px)', 'left:0', 'right:0',
      'z-index:9999', 'background:#1a1a2e', 'color:#e8e6f0',
      'padding:12px 16px', 'display:flex', 'align-items:flex-start', 'gap:10px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)', 'cursor:pointer',
      'font-family:-apple-system,system-ui,sans-serif', 'font-size:14px',
      'animation:fl-banner-slide-in 0.25s ease-out',
    ].join(';');

    banner.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(title)}</div>
        <div style="opacity:0.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(body)}</div>
      </div>
      <button style="background:none;border:none;color:#e8e6f0;opacity:0.5;font-size:18px;cursor:pointer;padding:0;line-height:1" aria-label="Dismiss">×</button>
    `;

    // Inject animation keyframe once
    if (!document.getElementById('fl-ios-push-styles')) {
      const style = document.createElement('style');
      style.id = 'fl-ios-push-styles';
      style.textContent = '@keyframes fl-banner-slide-in{from{transform:translateY(-100%)}to{transform:translateY(0)}}';
      document.head.appendChild(style);
    }

    banner.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') {
        if (url && url.startsWith('/')) window.location.href = url;
      }
      banner.remove();
    });

    document.body.appendChild(banner);

    // Auto-dismiss after 4 seconds
    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 4000);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIosPush);
  } else {
    initIosPush();
  }

})();
