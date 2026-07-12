# iOS App Store Launch Runbook

The Capacitor shell already exists (`ios/App`, `capacitor.config.ts` → loads
the live site from focusledger.net). Server-side APNs is fully built
(`lib/apns-sender.js`, `push_tokens` table, `/api/push/register`). What
remains is the Mac-side build, Apple paperwork, and store submission.

**Requires:** a Mac with Xcode 15+, and time. Steps marked 💻 happen on the
Mac; 🌐 happen in a browser; ☁️ happen in Render.

---

## Phase 1 — Apple paperwork (🌐, ~1 day incl. approval wait)

1. Enroll in the **Apple Developer Program** ($99/yr): developer.apple.com/programs
   — enroll as an individual unless there's an LLC to bind it to (individual
   shows "Sean Hendler" as seller; an org shows the company name).
2. Once approved: **Certificates, Identifiers & Profiles** →
   - **Identifiers** → register App ID `net.focusledger.app`
     (must match `appId` in capacitor.config.ts and `APNS_BUNDLE_ID` on Render).
     Enable the **Push Notifications** capability on it.
   - **Keys** → create an **APNs Auth Key** (.p8). Download it ONCE (it can't
     be re-downloaded). Note the **Key ID** and your **Team ID** (top right).

## Phase 2 — Server config (☁️, 10 min)

Add/verify in the Render **focusledger env group** (server code already reads these):
```
APNS_KEY_ID=<Key ID from Phase 1>
APNS_TEAM_ID=<Team ID>
APNS_KEY_P8=<base64 of the .p8 file:  base64 -i AuthKey_XXXX.p8 | pbcopy>
APNS_BUNDLE_ID=net.focusledger.app
```
`lib/apns-sender.js` reads `APNS_KEY_P8` as base64-decoded key material.

## Phase 3 — Build (💻, ~1 hour first time)

```bash
git clone <repo> && cd FocusLedger
npm install
npm install @capacitor/push-notifications   # ios-push.js expects it; not yet in package.json
npx cap sync ios
npx cap open ios
```
In Xcode:
1. Select the **App** target → **Signing & Capabilities** → set your Team;
   bundle id should read `net.focusledger.app`.
2. **+ Capability** → **Push Notifications**.
3. **+ Capability** → **Background Modes** → check **Remote notifications**.
4. Set minimum iOS to **16.4** (web push parity floor; APNs works lower, but
   16.4 keeps one consistent behavior story).
5. App icons: drag the brain icon set into `Assets.xcassets/AppIcon`
   (regenerate sizes from `public/icons/fl-icon.svg` — Xcode 15 accepts a
   single 1024px image and auto-generates).
6. Build to a **physical device** (simulator can't receive push).

**Smoke test on device:** log in → Settings → toggle notifications
(registers the APNs token via `/api/push/register`) → **Send test
notification** → it should arrive natively. That button exercises the whole
production APNs path.

## Phase 4 — TestFlight (💻🌐, ~1 day incl. review)

1. Xcode → Product → **Archive** → Distribute → **App Store Connect**.
2. appstoreconnect.apple.com → the build appears under TestFlight after
   processing (~15 min).
3. Fill **export compliance** (uses standard HTTPS encryption only → exempt).
4. Add internal testers (yourself), then create a **public TestFlight link**.
5. **Campaign tie-in:** the `ios_waitlist` table already collects emails —
   send the TestFlight link to the waitlist via the admin Campaigns tab.

## Phase 5 — App Store submission (🌐, review takes 1–3 days)

App Store Connect → App Information:
- **Category:** Productivity. Secondary: Finance.
- **Privacy nutrition labels** (IMPORTANT for a finance app — answer honestly):
  - Data collected & linked to identity: contact info (email), financial info
    (transactions via Plaid), user content (tasks/journals), identifiers (user id).
  - Not used for tracking (no cross-app tracking; the FB pixel is web-only).
- **Privacy policy URL:** https://focusledger.net/privacy
- **Screenshots:** 6.7" + 6.1" required. Best five: Today timeline, Daily
  Reveal (sealed), Buddy check-in, Money tab, Focus Mode.

**Guideline 4.2 (minimum functionality) risk & mitigation** — Apple rejects
"just a website in a shell." Counters, in the review notes field:
- Native push notifications via APNs (core to the product: morning reveals)
- Registers device tokens natively; deep links into app surfaces
- Roadmap includes widgets + share extension (below)
If rejected on 4.2 anyway: ship v1.1 with the WidgetKit widget (below) and
resubmit — a native widget definitively clears the bar.

## Phase 6 — Post-launch native roadmap (each is its own Xcode project step)

1. **WidgetKit widget** — "Next up" from the Today timeline
   (`GET /api/today/timeline` already returns everything a widget needs;
   add a lightweight `/api/today/next` if payload size matters).
2. **Share extension** — share any text/URL from any app → creates a task
   (`POST /api/tasks`). This is the Todoist-parity capture move.
3. **Live Activities** — focus-session countdown on the lock screen /
   Dynamic Island (`focus_sessions` has start + planned duration).
4. **Siri App Shortcuts** — the `/api/siri/today-focus` endpoint already
   exists; wire an App Intent to read it.

## Gotchas log

- `capacitor.config.ts` previously pointed at `focusledger.polsia.app`
  (stale domain) — fixed 2026-07-13. If the app loads a blank screen, check
  this first.
- Remote-URL Capacitor apps: App Review sees LIVE production. Don't ship
  breaking web deploys during the review window.
- The service worker (`sw.js`) is not used inside the native shell; push
  arrives via APNs (`ios-push.js`), not web push. Both paths already exist
  server-side and are selected per-device automatically.
