import type { CapacitorConfig } from '@capacitor/cli';

// FocusLedger iOS shell — loads the live web app from focusledger.net.
// This is NOT a static offline build. The native shell exists to distribute
// through the App Store; all business logic remains on the server.
const config: CapacitorConfig = {
  appId: 'net.focusledger.app',
  appName: 'FocusLedger',
  // webDir points at public/ for the fallback static bundle.
  // In practice, the live server URL below takes precedence at runtime.
  webDir: 'public',
  server: {
    // Live server load — the app hits the real backend on every open.
    // Remove this block only if shipping a fully offline build (not planned).
    // NOTE: was focusledger.net (pre-domain-move) — building against
    // that would have shipped an app aimed at the wrong server.
    url: 'https://focusledger.net',
    cleartext: false,
    allowNavigation: [
      'focusledger.net',
      '*.focusledger.net',
      // Google OAuth redirect domains
      'accounts.google.com',
      '*.googleapis.com',
      // Sign in with Apple (web flow). Without this the Apple page opens in
      // Safari and its form_post callback never returns to the app.
      'appleid.apple.com',
    ],
  },
  ios: {
    scheme: 'focusledger',
    // Lets the server and pages tell the App Store build from a browser, so
    // they never show prices or web checkout in the app (guideline 3.1.1).
    // Keep in sync with lib/native-app.js and public/js/native-app.js.
    appendUserAgent: 'FocusLedgerApp/1.0',
    // Minimum deployment target is set in Xcode project (see README-ios.md).
    // contentInset: 'always' keeps content below the notch/Dynamic Island.
    contentInset: 'always',
    // Scroll elasticity gives native feel without fighting the web scroll.
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
