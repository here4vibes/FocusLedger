# FocusLedger iOS — Build Guide

FocusLedger uses [Capacitor](https://capacitorjs.com/) to wrap the live web app in a native iOS shell for App Store distribution. The app loads `https://focusledger.polsia.app` at runtime — there is no offline bundle.

## Prerequisites (macOS only)

| Tool | Version | Install |
|------|---------|---------|
| Xcode | 15+ | App Store |
| CocoaPods | 1.14+ | `sudo gem install cocoapods` |
| Node.js | 18+ | `brew install node` |
| Xcode CLI Tools | latest | `xcode-select --install` |

## First-Time Setup (run once on macOS)

```bash
# 1. Install dependencies
npm install

# 2. Generate the iOS Xcode project
npx cap add ios

# 3. Install CocoaPods dependencies
cd ios/App && pod install && cd ../..

# 4. Sync web assets and config into the native project
npx cap sync ios

# 5. Open in Xcode
npx cap open ios
```

## After the First-Time Setup

Any time you change `capacitor.config.ts`:

```bash
npx cap sync ios
npx cap open ios
```

## Xcode Configuration (do once after first `cap add ios`)

In Xcode, select the `App` target → `General`:

1. **Deployment Target** → iOS 16.0
2. **Bundle Identifier** → `net.focusledger.app`
3. **Display Name** → `FocusLedger`
4. **Version** → `1.0.0`, **Build** → `1`

In `Info.plist`, add:

```xml
<!-- Allow loading focusledger.polsia.app over HTTPS (ATS is already HTTPS — no exception needed) -->

<!-- Privacy usage strings (for future native features) -->
<key>NSCameraUsageDescription</key>
<string>FocusLedger uses your camera to scan documents for your Life vault.</string>

<key>NSFaceIDUsageDescription</key>
<string>FocusLedger uses Face ID to keep your financial data secure.</string>

<key>NSUserNotificationsUsageDescription</key>
<string>FocusLedger sends reminders for tasks and bill due dates.</string>

<!-- Privacy policy URL -->
<key>NSPrivacyPolicyURL</key>
<string>https://focusledger.polsia.app/privacy</string>
```

## App Icon

Place a 1024×1024 PNG at:

```
ios/App/App/Assets.xcassets/AppIcon.appiconset/Icon-1024.png
```

Xcode will generate all required sizes from it. Use [Bakery](https://apps.apple.com/us/app/bakery-simple-icon-creator/id1575220747) or [appicon.co](https://www.appicon.co/) to generate the full icon set if you want to be explicit.

## Google OAuth (Universal Links / Custom URL Scheme)

The app needs to return from Google's OAuth flow. Two options:

**Option A — Custom URL Scheme** (simpler, sufficient for now):
- Add `focusledger` to `CFBundleURLTypes` in `Info.plist`
- Server callback URL: `focusledger://oauth/callback`
- Requires updating the OAuth redirect on the server side

**Option B — Universal Links** (preferred long-term):
- Host `/.well-known/apple-app-site-association` on `focusledger.polsia.app`
- Configure the `Associated Domains` entitlement in Xcode: `applinks:focusledger.polsia.app`
- Requires an Apple Developer Team ID

For the initial scaffolding, Option A is ready to configure. Option B is a follow-up task.

## Building for Simulator

```bash
# In Xcode: select an iPhone 15 simulator, press ▶
# Or from command line:
npx cap run ios
```

## Verify Checklist

- [ ] App loads `https://focusledger.polsia.app` in the native shell
- [ ] Login / signup flow completes (Google OAuth redirects correctly)
- [ ] Bottom navigation works across main pages
- [ ] Status bar not occluded (safe area insets applied)
- [ ] No content behind notch / Dynamic Island

## Commit the ios/ Directory

After `npx cap add ios`, commit the generated Xcode project:

```bash
git add ios/
git commit -m "ios: add Capacitor Xcode project scaffold"
```

The `Pods/` directory and `DerivedData/` are already in `.gitignore`.

## Building for Distribution (App Store)

1. Set up your Apple Developer account and signing certificates in Xcode
2. Archive: **Product → Archive**
3. Distribute via Xcode Organizer → **App Store Connect**

## Siri Shortcuts Integration

All implementation files are in `ios-native/SiriShortcuts/`. Drop them into `App/App/` in Xcode.

### Files

| File | Purpose |
|------|---------|
| `FocusLedgerSiriPlugin.swift` | Capacitor plugin — receives JS calls, donates shortcuts |
| `FocusLedgerSiriPlugin.m` | Capacitor plugin bridge (Obj-C, required by Capacitor 5+) |
| `FocusIntentHandler.swift` | NSUserActivity handler — fetches tasks, speaks via AVSpeechSynthesizer |
| `KeychainHelper.swift` | Stores/reads the JWT from iOS Keychain for use by the shortcut handler |

### Xcode Setup

1. **Add files**: Drag all 4 files from `ios-native/SiriShortcuts/` into `App/App/` in Xcode (check "Copy items if needed").

2. **Info.plist**: Add the two activity types so iOS recognizes them:
   ```xml
   <key>NSUserActivityTypes</key>
   <array>
     <string>net.focusledger.app.focus-today</string>
     <string>net.focusledger.app.add-task</string>
   </array>
   ```

3. **AppDelegate.swift**: Handle activity continuations:
   ```swift
   override func application(_ application: UIApplication,
     continue userActivity: NSUserActivity,
     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
     if userActivity.activityType == "net.focusledger.app.focus-today" {
       FocusIntentHandler.shared.handleFocusActivity(userActivity, in: window)
       return true
     }
     if userActivity.activityType == "net.focusledger.app.add-task" {
       // Navigate to task creation — post a notification or call the Capacitor bridge
       NotificationCenter.default.post(name: Notification.Name("OpenNewTask"), object: nil)
       return true
     }
     return false
   }
   ```

4. **Siri permission**: Add to `Info.plist`:
   ```xml
   <key>NSSiriUsageDescription</key>
   <string>FocusLedger uses Siri so you can ask what your focus is today.</string>
   ```

5. **Capabilities**: In Xcode → App target → Signing & Capabilities → `+` → add **Siri**.

### JWT Storage (Required for Shortcuts to Work)

After a successful login in the web layer, store the JWT in the Keychain so the Siri handler can access it without the app being open:

```js
// In your JS auth success callback (e.g. routes/auth.js response handler in the frontend):
import { Capacitor } from '@capacitor/core';

if (Capacitor.isNativePlatform() && Capacitor.platform === 'ios') {
  await Capacitor.Plugins.FocusLedgerSiri?.storeJWT({ token: yourJWT });
}
```

On logout:
```js
await Capacitor.Plugins.FocusLedgerSiri?.clearJWT();
```

### Shortcut Donation

Import and call from the web layer after key user actions:

```js
import { donateCheckinShortcut, donateAddTaskShortcut } from '/js/siri-shortcuts.js';

// After morning check-in completes:
await donateCheckinShortcut();

// After any task is created:
await donateAddTaskShortcut();
```

### Backend API

The shortcut calls `GET /api/siri/today-focus` (JWT Bearer auth) and receives:

```json
{
  "spoken_text": "You have 3 tasks today. 1: Submit tax forms. 2: Call Dr. Lee. 3: Review bank statement.",
  "task_count": 3,
  "tasks": [{ "id": 1, "title": "Submit tax forms", "due_date": "2026-05-18" }]
}
```

### Testing

1. Run the app in Simulator
2. Go to Settings → Siri & Search → check FocusLedger appears
3. Say "Hey Siri, what's my focus today?" — you should hear your tasks read back
4. Open the Shortcuts app — both shortcuts should appear under FocusLedger

### Verify Checklist

- [ ] `NSUserActivityTypes` in `Info.plist` (both activity types)
- [ ] `NSSiriUsageDescription` in `Info.plist`
- [ ] Siri capability enabled in Xcode
- [ ] JWT stored in Keychain after login
- [ ] Shortcut donation fires after check-in and task creation
- [ ] "Hey Siri, what's my focus today?" reads back tasks correctly
- [ ] Graceful fallback if network is unavailable

## Native Features (Future Tasks)

These are NOT in scope for the current implementation:

- **Biometrics (Face ID)** — `@capacitor-community/biometric-auth`
- **Haptics** — `@capacitor/haptics`
- **Share Sheet** — `@capacitor/share`
- **Interactive Widget Checkboxes** — iOS 17 AppIntents (v2 widget enhancement)

## Troubleshooting

**`pod install` fails**: Run `pod repo update` then retry.

**"No bundle URL present"**: Run `npx cap sync ios` and rebuild.

**White screen in simulator**: Verify the `server.url` in `capacitor.config.ts` is reachable.

**Signing error in Xcode**: Go to `Signing & Capabilities` tab, select your Team, enable automatic signing.
