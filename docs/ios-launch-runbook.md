# FocusLedger — iOS Launch Runbook

Living checklist for shipping FocusLedger to the App Store. Phone-driven, cloud-built,
no hire. Owner column: **You** (taps in a dashboard) · **Me** (code/config I generate) · **Both**.

## Decisions locked
- **Monetization:** Option A — native IAP via **RevenueCat**. Stripe stays for web; iOS purchase
  grants the same `Autopilot` entitlement server-side (see `checkProStatus`).
- **Build:** cloud — **Codemagic** (no Mac required). Future builds automate on push.
- **App shell:** remote WebView (`capacitor.config.ts` → `server.url: https://focusledger.net`),
  bundle id **`net.focusledger.app`**, name **FocusLedger**.

## Two review realities this architecture creates
1. **4.2 Minimum Functionality** — a remote WebView must add real native capability or it's
   rejected as a "thin wrapper." Mitigation: ship the **native pack** (push ✅ already, + Siri
   App Intents, Contacts, Face ID unlock, native share). This doubles as the anti-Siri
   differentiation.
2. **3.1.1 In-App Purchase** — inside the app, Autopilot must be sold via IAP, never the Stripe
   web checkout. Mitigation: on iOS (`Capacitor.isNativePlatform()`) the Upgrade CTA triggers
   native RevenueCat; on web it stays Stripe. RevenueCat webhook grants Autopilot in the DB.

---

## Phase 1 — Accounts (You · ~$99 + waiting)
- [ ] **Apple Developer Program** enrollment ($99/yr). Decision: **Individual** (fast, your name
      as seller, no D-U-N-S) vs **Organization** (company name, needs legal entity + D-U-N-S).
      Recommended for a fast solo launch: **Individual** — can move to an org account later.
      Approval: minutes–48h. Do it in Safari or the Apple Developer app.
- [ ] **RevenueCat** account (free tier).
- [ ] **Codemagic** account (free tier); connect the GitHub repo.

## Phase 2 — App identity (Both)
- [ ] App Store Connect: create the app record (bundle id `net.focusledger.app`).
- [ ] **Me:** harden `capacitor.config.ts` (safe areas, status bar, keyboard, deep links).
- [ ] App icon + splash — brand mark exists (`/icons/fl-icon.svg`); **Me:** generate the icon set.

## Phase 3 — IAP + entitlement wiring (Both)
- [ ] App Store Connect: create the **Autopilot** auto-renewing subscription product ($9.99/mo,
      $100/yr) + enroll in the **Small Business Program** (15% not 30%).
- [ ] RevenueCat: add the product, define the `autopilot` **entitlement**, get the API keys.
- [ ] **Me:** add `@revenuecat/purchases-capacitor`; bridge the web Upgrade CTA → native paywall
      on iOS only.
- [x] **Me:** RevenueCat **webhook → backend** — `POST /api/revenuecat/webhook` grants/revokes
      `users.autopilot_expires_at` (what `checkProStatus` reads), so an iOS purchase = Pro on web.
      **Env to set in Render + RevenueCat dashboard:** `REVENUECAT_WEBHOOK_AUTH` (shared secret,
      any long random string — paste the same value into RevenueCat's webhook Authorization
      header) and optionally `REVENUECAT_ENTITLEMENT` (defaults to `autopilot`).
- [x] **Me:** web Upgrade CTA detects iOS → routes to native purchase (never Stripe in-app).
      Native bridge `window.FLNative.purchase` gets wired when the RevenueCat Capacitor plugin lands.
- [ ] Free-access plumbing for the feedback cohort (TestFlight = free by default; RevenueCat
      promo entitlements / existing web `promo_codes` for ongoing grants).

## Phase 4 — Native pack (Me builds · needed for 4.2 + differentiation)
- [ ] **Siri App Intents** (Swift) — "Hey Siri, tell Buddy…" / "ask Buddy what's next."
- [ ] **Contacts** — resolve "email Miles" to an address (kills the friction we hit).
- [ ] **Face ID / biometric unlock** (cheap, strong native signal for review).
- [ ] **Native share** target.

## Phase 5 — Cloud build → TestFlight (Both)
- [ ] **Me:** `codemagic.yaml` (build, auto-sign, publish to TestFlight).
- [ ] **You:** App Store Connect **API key** → paste into Codemagic (handles signing, no Keychain).
- [ ] First green build → **TestFlight**.

## Phase 6 — Feedback beta (You)
- [ ] Invite early users to **TestFlight** (up to 10k external). Everything free (sandbox IAP).
      This is the "free in exchange for feedback" cohort.
- [ ] Collect feedback; iterate (I push fixes, Codemagic rebuilds).

## Phase 7 — Store listing + submit (Both)
- [ ] **Me:** description, keywords, App Privacy answers, screenshot specs/copy.
- [ ] **You:** screenshots (take on your iPhone), **Paid Apps agreement + tax/banking** forms
      (the phone-hostile ones — borrow a bigger screen if needed).
- [ ] Submit for review; **Me:** draft fixes/appeals for any rejection.

## Phase 8 — Live + evolve (later)
- [ ] Post-launch: add the U.S. **external-purchase link** to reclaim margin from Stripe.
- [ ] Automate releases fully via Codemagic on push (stop touching any Mac).

---

## Current step
**Phase 1 → Apple Developer enrollment.** Everything downstream (App Store Connect, RevenueCat
product, TestFlight, Codemagic signing) hangs off having the account.
