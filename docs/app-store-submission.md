# App Store submission checklist (founder)

What you do, in order, to get FocusLedger for iOS through App Review. Written
2026-11-11 against the code in this repo. Items marked **UNVERIFIED** could
not be checked from a cloud session (no Apple account, no device, no Mac).

Older notes (`docs/ios-launch.md`, `docs/ios-launch-runbook.md`,
`docs/ios-app-store-listing.md`, `README-ios.md`) describe an earlier plan
(RevenueCat in-app purchase, Codemagic). Where they disagree with this file,
this file is current.

## What the app does about Apple's rules

| Rule | What the code does |
|---|---|
| **3.1.1 no web purchases** | Inside the app there is no price, no upgrade or checkout button, no pricing link, no billing portal, no promo-code box. Free users see "You're on the Free plan."; at the cap, "You've reached the Free plan's task limit." Paid users still see their plan and can cancel. `/` and `/pricing` redirect to `/login`. The server refuses `POST /api/subscription/checkout` and `/portal` from the app (403 `NATIVE_APP_PURCHASE_UNAVAILABLE`) and strips upgrade sentences from API error messages. Detection: Capacitor bridge or the `FocusLedgerApp/1.0` user-agent suffix (`public/js/native-app.js`, `lib/native-app.js`). |
| **4.8 Sign in with Apple** | Built, off until you add the four `APPLE_*` env vars (step 2). Then the button appears above Google on `/login` and `/signup`. |
| **5.1.1(v) account deletion** | Settings → Delete Account (email confirmation). Deleting also revokes the Sign in with Apple token. |
| **Tracking** | The Meta Pixel never loads in the app (`native-app.js` runs first on every page and disables it). |
| **4.2 minimum functionality** | One native feature so far: Taptic feedback when a task is completed (Capacitor Haptics). See "Risks" below. |

## 1. Apple Developer account (developer.apple.com → Certificates, Identifiers & Profiles)

1. **App ID** — Identifiers → + → App IDs → App.
   - Bundle ID (explicit): `net.focusledger.app`
   - Capabilities: tick **Sign in with Apple** (leave "Enable as a primary App ID") and **Push Notifications**.
2. **Services ID** (this is what the website uses) — Identifiers → + → Services IDs.
   - Identifier: `net.focusledger.signin` (any name works; it becomes `APPLE_CLIENT_ID`).
   - Tick **Sign in with Apple** → Configure:
     - Primary App ID: `net.focusledger.app`
     - Domains and Subdomains: `focusledger.net`
     - Return URLs: `https://focusledger.net/api/auth/apple/callback` (exact, no trailing slash)
3. **Key** — Keys → + → name "FocusLedger Sign in with Apple" → tick **Sign in with Apple** → Configure → Primary App ID `net.focusledger.app` → Register → **Download the `.p8`** (one download only). Note the **Key ID** (10 characters).
4. **Team ID** — top right of the developer site, or Membership details (10 characters).
5. **Email relay** (so welcome and reminder emails reach "Hide My Email" users) — Services → Sign in with Apple for Email Communication → Configure → add domain `focusledger.net` and address `hello@focusledger.net`. **UNVERIFIED:** Apple checks SPF/DKIM for the domain; Resend already signs for `focusledger.net`, but confirm the row shows a green check.

## 2. Render environment (the `focusledger` env group)

| Variable | Value |
|---|---|
| `APPLE_CLIENT_ID` | the Services ID, e.g. `net.focusledger.signin` (not the bundle id) |
| `APPLE_TEAM_ID` | your Team ID |
| `APPLE_KEY_ID` | the Key ID from step 1.3 |
| `APPLE_PRIVATE_KEY` | the whole `.p8` file contents, including the BEGIN/END lines (multi-line is fine; a single line with `\n` also works) |

Optional: `APPLE_REDIRECT_URI` only if the callback is not `https://focusledger.net/api/auth/apple/callback`.

Until all four are set, `/api/auth/apple/config` returns `enabled:false`, no button is shown, and the routes answer 503 — so nothing changes for users.

**Test after setting them** (in Safari on a phone, then in the TestFlight build):
1. `/login` shows a black "Sign in with Apple" button above Google.
2. New Apple ID → lands in the app, welcome email arrives.
3. Choose "Hide My Email" → account is created with an `@privaterelay.appleid.com` address.
4. An Apple ID whose email matches an existing FocusLedger account → signs into that account (no duplicate).
5. Settings → Delete Account → after confirming, appleid.apple.com → Sign-In & Security → Sign in with Apple no longer lists FocusLedger.

## 3. GitHub repo secrets (Settings → Secrets and variables → Actions)

For `.github/workflows/ios.yml` ("iOS Build & TestFlight"). Create the key at App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → + (role **App Manager**).

| Secret | Value |
|---|---|
| `ASC_KEY_ID` | the key's Key ID |
| `ASC_ISSUER_ID` | the Issuer ID shown above the key list |
| `ASC_KEY_CONTENT` | base64 of the downloaded `AuthKey_XXXX.p8`: `base64 -i AuthKey_XXXX.p8 \| pbcopy` (macOS) or `base64 -w0 AuthKey_XXXX.p8` (Linux) |

Without them the workflow only compiles an unsigned simulator build. With them, every push to `main` archives and uploads to TestFlight.

**UNVERIFIED — the signed path has never run.** Known gaps it will probably hit:
- `ios/App/App.xcodeproj` has no `DEVELOPMENT_TEAM`. `xcodebuild -allowProvisioningUpdates` needs one: add `DEVELOPMENT_TEAM=<Team ID>` to the Archive step, or set the team once in Xcode and commit.
- There is no `App.entitlements` file. Sign in with Apple on the web flow needs none, but **push needs `aps-environment`**, and the Push Notifications plugin is not in the iOS project (`ios/App/CapApp-SPM/Package.swift` has only Capacitor and Haptics). So native push does not work yet; `public/js/ios-push.js` exits quietly. Either ship v1 without push (then also remove `remote-notification` from `UIBackgroundModes` in `Info.plist`, which Apple can question when unused) or add `@capacitor/push-notifications` plus the entitlement in a follow-up.
- No app-level `PrivacyInfo.xcprivacy`. Capacitor ships its own; if the upload email warns about a missing privacy manifest (ITMS-91053), add one.
- The app record must exist in App Store Connect first (step 4).

## 4. App Store Connect listing

Create the app: My Apps → + → New App → iOS, name `FocusLedger`, primary language English (U.S.), bundle ID `net.focusledger.app`, SKU `focusledger-ios`.

| Field | Draft |
|---|---|
| **Name** (≤30) | `FocusLedger` |
| **Subtitle** (≤30) | `Tasks & money, ADHD-native` (26) |
| **Promotional text** (≤170) | `Executive functioning on autopilot. Tell Buddy what's on your mind and get your day down to the few things that matter, with your spending in the same place.` (157) |
| **Keywords** (≤100) | `adhd,todo,planner,budget,spending,executive function,habits,routine,impulse,neurodivergent,reminders` (100) |
| **Support URL** | `https://focusledger.net/contact` |
| **Marketing URL** | `https://focusledger.net` |
| **Privacy Policy URL** | `https://focusledger.net/privacy` |
| **Category** | Primary: Productivity · Secondary: Finance |
| **Price** | Free. No in-app purchases. |
| **Copyright** | `2026 FocusLedger` — **confirm the legal entity name** |

**Description** (no prices, no "subscribe", no mention of the website as a place to buy — reviewers reject listings that do):

```
FocusLedger is an ADHD-native command center: your tasks, your routines and your spending in one calm place. Built by a CPA with ADHD.

TALK TO BUDDY
Tell Buddy what's on your mind. It turns a brain dump into a short list, breaks a task you're stuck on into small steps, and checks in with you morning and evening.

JUST WHAT MATTERS TODAY
• A home screen with the one to three things on your radar, not an endless list
• Tap to complete, with a small reward each time
• Routines that forgive a missed day instead of resetting your streak
• Focus Mode with a timer that notices when you've drifted

SEE YOUR MONEY WITHOUT THE SHAME
• Log spending and sort planned from impulse in a quick check-in
• See what a purchase costs in hours of your work
• Keep bills and subscriptions in view before they renew

A PLACE FOR LIFE ADMIN
• A vault for documents, with reminders before things expire
• Insurance policies and coverage gaps at a glance
• A journal and your own values, used to rank what matters

BUILT FOR HOW ADHD BRAINS WORK
Gentle nudges when you need them, quiet when you don't. No guilt, no red badges.

Your data is yours: encrypted, never sold, and you can delete your account from Settings at any time.
```

**What's New (1.0):** `First release.`

**Screenshots:** 6.9" (1320×2868) is required; 6.5" optional. Take them on the reviewer/demo account, signed in, from the TestFlight build: Home, Tasks, a Buddy conversation, Money overview, Focus Mode. No screenshot may show a price or the pricing page.

## 5. App Privacy ("nutrition label")

App Store Connect → App Privacy. Derived from `public/privacy.html` and the code. Answer **Yes, we collect data**, then:

| Data type | Collected | Linked to user | Purpose | Source in the code |
|---|---|---|---|---|
| Contact Info → **Email Address** | Yes | Yes | App Functionality | `users.email` |
| Contact Info → **Name** | Yes | Yes | App Functionality | `users.name` (optional) |
| Financial Info → **Other Financial Info** | Yes | Yes | App Functionality | expenses, Plaid transactions, account names and balances, bills |
| User Content → **Photos or Videos** | Yes | Yes | App Functionality | receipt/note photo capture, Vault uploads |
| User Content → **Emails or Text Messages** | Yes | Yes | App Functionality | Email → Tasks reads subjects and snippets of a connected inbox |
| User Content → **Other User Content** | Yes | Yes | App Functionality | tasks, routines, journal, check-ins, Buddy messages, documents, insurance details, values |
| Identifiers → **User ID** | Yes | Yes | App Functionality | account id; Apple/Google sign-in id |
| Identifiers → **Device ID** | Yes, only if native push ships | Yes | App Functionality | APNs device token (`push_tokens`) |
| Usage Data → **Product Interaction** | Yes | Yes | Analytics | first-party page/feature events (`public/js/analytics.js` sends the session, so events tie to the account) |
| Diagnostics → **Crash Data**, **Other Diagnostic Data** | Yes | Yes | App Functionality | Sentry server error reports can include the user id |
| Sensitive Info, Health & Fitness, Location, Contacts, Browsing/Search History, Purchases, Audio | **No** | | | See notes |

Notes:
- **Tracking: answer "No".** The Meta Pixel runs only on public web pages in a browser. In the app it is switched off before it can load (`native-app.js` is the first script on every page, including `/login` and `/signup`, and defines `fbq` as a no-op so `fbevents.js` is never requested; checked by `tests/local/native-app.spec.js`). No IDFA, no ad SDK, no data shared with data brokers, so **no App Tracking Transparency prompt** is needed.
- **Purchases: No.** Nothing is bought in the app.
- **Sensitive / Health: No**, but be ready to explain: the app is for people with ADHD and stores mood/energy check-ins. It does not ask for or store a diagnosis. **Judgment call — UNVERIFIED with Apple.** If you prefer the cautious answer, declare Health & Fitness → Health (linked, App Functionality) for the energy/mood check-ins.
- **Coarse Location: No**, although the server sees IP addresses (not stored as location) and stores the time zone.
- **Audio: No** — **UNVERIFIED**: `Permissions-Policy` allows the microphone for voice input in the browser. If voice input works inside the app, Info.plist needs `NSMicrophoneUsageDescription` and this answer becomes Yes (App Functionality, linked). Test the mic button in TestFlight; if it does nothing, leave as is.
- Third parties that process data for us (not "tracking"): Anthropic (AI), Plaid, Resend, Sentry, Neon, Render, Cloudflare R2.

## 6. App Review information

**Demo account — create a new one; do not use or change the QA account.**
1. In a browser, sign up at `https://focusledger.net/signup` with an address you control, e.g. `appreview@focusledger.net`, and a strong password.
2. In the admin panel, grant that account complimentary Autopilot (`admin_pro_override`) with no expiry, so the reviewer sees every feature and never hits a plan wall.
3. Add believable data: 5–6 tasks (two completed), one routine, a morning check-in, a few manual expenses, one journal entry, one Vault document.
4. Bank data: either leave the bank unconnected (the notes below say so), or — only if production Plaid is in sandbox mode, which it is **not** expected to be — connect Plaid's sandbox bank (`user_good` / `pass_good`). **UNVERIFIED:** `PLAID_ENV` in Render was never confirmed (see CLAUDE.md "Waiting on the user").
5. Sign in once on the TestFlight build with this account before submitting.

**Sign-in required:** Yes. Username/password: the account above.

**Notes for the reviewer** (paste):

```
FocusLedger is a task, routine and spending tracker designed for adults with ADHD.

SIGN IN
Use the demo account above (email + password on the login screen). Sign in with Apple and Google are also offered.

WHAT TO TRY
1. Home: the short list of what is on your radar. Tap a task to complete it (you will feel a haptic tap).
2. Tasks tab: add a task, open it, try "I'm stuck" to break it into steps.
3. Buddy (Home screen chat or the floating button): type "plan my day".
4. Money tab: add an expense and run the spending check-in.
5. Life tab: document vault, insurance, journal.
6. Settings: plan status, notification preferences, Delete Account.

BANK CONNECTION
Linking a bank account uses Plaid and requires real online-banking credentials, so the demo account has no bank linked. All money features can be reviewed with the manually entered expenses already in the account. Bank access is read-only; the app cannot move money.

PURCHASES
The app contains no purchases, prices or links to purchase. The demo account has all features enabled.

ACCOUNT DELETION
Settings > Delete Account sends a confirmation email; confirming deletes the account and all data and revokes Sign in with Apple.

AI
Buddy uses Anthropic's Claude via our server. Content is user-initiated and not public; there is no user-to-user content apart from tasks a user chooses to share with one invited accountability partner.

Contact: hello@focusledger.net
```

## 7. Age rating

Questionnaire answers: **None / No** for every content category (violence, sexual content, profanity, drugs, gambling, horror, medical/treatment information, contests). Unrestricted web access: **No**. User-generated content: **No** (content is private to the account; partner sharing is one invited person). Messaging and chat: **No** (Buddy is an AI assistant, not person-to-person chat). Advertising: **No**. Expected result: **4+**. **UNVERIFIED:** Apple's 2025 questionnaire added questions on AI chat and health/wellness topics; answer that the app has an AI assistant and offers no medical advice. If it asks about "medical or treatment information", answer None — the app organises tasks and money and does not diagnose or treat ADHD.

## 8. Export compliance

`Info.plist` now sets `ITSAppUsesNonExemptEncryption = false`, so App Store Connect will not ask on each build. Basis: the app uses only standard HTTPS/TLS provided by iOS and contains no proprietary or non-standard cryptography (exempt under Category 5 Part 2 Note 4 / the "standard encryption" exemption). No annual self-classification report or French declaration is needed for an exempt app. If asked anyway: "Does your app use encryption?" → Yes, only exempt (HTTPS).

## 9. Submit

1. Merge the PR, let Render deploy, set the four `APPLE_*` vars, run the step 2 tests in Safari.
2. Add the three `ASC_*` secrets; push to `main` or run the workflow; fix signing (step 3 notes) until a build shows in TestFlight.
3. On a real iPhone with the TestFlight build, signed in as a **Free** account, check: no price or upgrade button anywhere (Settings, Tasks at the 10-task cap, Money → bank sync, Email → Tasks, Partner); Sign in with Apple works and returns into the app (not Safari); Google sign-in works (see Risks); Delete Account works.
4. Fill the listing, privacy label, review info, age rating; attach the build; Submit for Review.
5. Do not deploy breaking web changes while in review: the app loads the live site.

## Risks and things not verified

- **4.2 (web wrapper).** The app is the website in a WebView plus haptics. This is the most likely rejection. Cheapest additions if it happens: native push (plugin + entitlement), Face ID unlock (`public/js/biometric.js` already expects a plugin), native share sheet.
- **3.1.3(b) multiplatform services.** Paid web subscribers can use Autopilot in the app, but the app sells nothing. Apple allows access to things bought elsewhere "provided those items are also available as in-app purchases". Reviewers often let this pass when nothing in the app mentions buying; if they don't, the options are (a) add in-app purchase (`routes/revenuecat-webhook.js` and `PricingService.nativePurchase` are the existing stubs), or (b) US storefront only with an external purchase link, which Apple has permitted in the US since May 2025. **Judgment call for you.**
- **Buddy's own words.** Buddy is an AI and could still say "upgrade" in a reply. The fixed upsell in the email-send flow is replaced in the app, and API error messages are scrubbed, but model text is not filtered.
- **Google sign-in inside the app — UNVERIFIED.** Google blocks OAuth in embedded WebViews (`disallowed_useragent`). If the Google button fails in TestFlight, hide it in the app (Apple + email remain) — a one-line change in `login.html`/`signup.html` using `FLNativeApp.isNative()`.
- **Sign in with Apple inside the app — UNVERIFIED on a device.** `capacitor.config.ts` now allows navigation to `appleid.apple.com` so the flow stays in the WebView; the nonce cookie is `SameSite=None; Secure`, which WKWebView should send on Apple's form POST. Verified here only with unit tests and a headless browser against a local server; the real Apple round trip needs your credentials.
- **Capacitor bridge on the remote site — UNVERIFIED on a device.** Haptics rely on `window.Capacitor.Plugins.Haptics` being injected into pages served from focusledger.net.
- **Terms and changelog pages** still state web prices as text; they are reachable from footers. The pricing links on them are hidden in the app. If a reviewer objects, hide those footers in the app.
- **`STRIPE_WEBHOOK_SECRET`, `sslmode`** and the other items in CLAUDE.md "Waiting on the user" are unrelated to review but still open.
