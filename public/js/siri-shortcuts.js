// siri-shortcuts.js
// Owns: Siri Shortcut donation triggers from the web layer.
// Does NOT own: native Swift shortcut handlers, Keychain, or SiriKit intents.
//
// This module bridges the Capacitor JS layer → native iOS.
// On non-iOS or non-Capacitor environments, all calls are silent no-ops.
//
// Usage:
//   import { donateCheckinShortcut, donateAddTaskShortcut } from './siri-shortcuts.js';
//   donateCheckinShortcut();   // call after morning check-in completes

const SIRI_PLUGIN_NAME = 'FocusLedgerSiri';

// Check if we're running inside the Capacitor native shell with our plugin loaded.
// WHY: The plugin only exists in the iOS app. Calling it on web or Android throws.
function isPluginAvailable() {
  return (
    typeof window !== 'undefined' &&
    window.Capacitor &&
    window.Capacitor.isNativePlatform() &&
    window.Capacitor.platform === 'ios' &&
    window.Capacitor.Plugins &&
    window.Capacitor.Plugins[SIRI_PLUGIN_NAME]
  );
}

async function callPlugin(method, options = {}) {
  if (!isPluginAvailable()) return;
  try {
    await window.Capacitor.Plugins[SIRI_PLUGIN_NAME][method](options);
  } catch (err) {
    // Silent: shortcut donation is non-critical. Never surface to the user.
    console.warn('[siri-shortcuts] Plugin call failed silently:', method, err?.message);
  }
}

/**
 * Donate the "What's my focus today?" shortcut.
 * Call this after the user completes a morning check-in so iOS can proactively
 * suggest it at the same time tomorrow.
 */
export async function donateCheckinShortcut() {
  await callPlugin('donateFocusShortcut', {
    title: "What's my focus today?",
    invocationPhrase: "What's my focus today",
  });
}

/**
 * Donate the "Add a task" shortcut.
 * Call this after the user creates a task so iOS learns the pattern.
 */
export async function donateAddTaskShortcut() {
  await callPlugin('donateAddTaskShortcut', {
    title: 'Add a task to FocusLedger',
    invocationPhrase: 'Add a task to FocusLedger',
  });
}
