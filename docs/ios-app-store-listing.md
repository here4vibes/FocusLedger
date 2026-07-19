# App Store Listing + App Privacy — FocusLedger

Pre-filled so you can paste into App Store Connect. **Review anything marked ⚠️** —
those are judgment calls or need your confirmation.

## Basics
- **App name (30 char max):** `FocusLedger`
- **Subtitle (30 char max):** `Tasks & money, ADHD-native` *(alt: `Your ADHD command center`)*
- **Primary category:** Productivity  ·  **Secondary:** Finance
  - ⚠️ Flip to Finance-primary only if you want to rank in Finance charts; Productivity is the broader ADHD audience.
- **Age rating:** 4+
- **Bundle ID:** `net.focusledger.app`

## URLs
- **Marketing URL:** https://focusledger.net
- **Support URL:** https://focusledger.net/contact
- **Privacy Policy URL:** https://focusledger.net/privacy  *(required — you have this page)*

## Promotional text (170 char, editable anytime without review)
> Executive functioning on autopilot. Talk to Buddy — it drafts the email you're avoiding, catches impulse spends, and keeps your day to just what matters.

## Keywords (100 char, comma-separated, no spaces)
`adhd,focus,tasks,todo,budget,money,spending,executive function,planner,habits,impulse,neurodivergent`
- ⚠️ Don't repeat words from the app name/subtitle (Apple ignores dupes) — tune after launch using search data.

## Description
> **FocusLedger is your ADHD-native command center — tasks, money, and impulse spending in one calm conversation.**
>
> Built by a CPA with ADHD, FocusLedger puts executive functioning on autopilot. Instead of another app that piles on more to remember, you just talk to Buddy — and Buddy actually does things.
>
> **Talk to Buddy, and it acts:**
> • "Reschedule my dentist to Friday" — done, with one-tap undo.
> • "Email my landlord about the leak" — Buddy drafts it, you approve, it sends.
> • "What did I spend this week?" — a clear read from your real ledger, impulse vs planned.
>
> **Built for how ADHD brains actually work:**
> • Just the 1–3 things that matter today — not an overwhelming pile.
> • Impulse-spend detection that names the moment without shame.
> • Brain-dump anything; Buddy sorts it into now, later, and let-go.
> • Gentle nudges when you need them, quiet when you don't.
>
> **Autopilot (subscription)** adds bank sync, unlimited AI, and Buddy handling more of the admin you dread — so the avoided task stops being the ADHD tax.
>
> Your data is yours. FocusLedger is a calm companion, not another thing shouting for attention.

## "What's New" (v1.0)
> First release. Meet Buddy — talk to it, and it handles your tasks, watches your spending, and sends the emails you've been avoiding. Welcome to executive functioning on autopilot.

---

## App Privacy (the data questions)
Answer these in App Store Connect → App Privacy. Based on the current schema; ⚠️ = confirm.

**Data collected and linked to the user's identity** (used for App Functionality):
- **Contact Info** — email address, name (account).
- **Financial Info** — Plaid transactions, balances, spending/expenses. ⚠️ Sensitive; label honestly.
- **User Content** — tasks, journal entries, notes, values, and Life-vault **documents** (which may include IDs/insurance — treat as sensitive).
- **Identifiers** — your internal user ID.
- **Usage Data** — in-app events. ⚠️ You describe analytics as "privacy-safe / anonymous"; if it's truly not tied to the account, you may list it as **not linked** — confirm how your analytics beacon associates events.
- **Diagnostics** — crash/performance, if you enable it.

**Not collected by the app directly:**
- **Payments** — handled by Apple (IAP) and Stripe (web). You don't store card data.

**Tracking (IDFA / cross-app):**
- ⚠️ You use a Facebook Pixel on the **landing page**. Inside the **app** (the native build), if you do NOT load the Pixel / track across apps, answer **"No, we do not track."** Confirm the app build doesn't carry ad-tracking, or you'll owe an App Tracking Transparency prompt.

**Permissions the app will request (with usage strings — for the native pack):**
- ⚠️ `NSContactsUsageDescription` — "FocusLedger uses your contacts so Buddy can address emails to the right person. Contacts stay on your device." *(If Contacts are only read on-device to fill an address and never sent to your server, you likely don't declare Contacts as "collected" — but you still need this string.)*
- `NSFaceIDUsageDescription` — "Use Face ID to unlock FocusLedger."
- Push notifications — already configured (APNs).

---

## Screenshots (you take these on your iPhone)
Apple needs **6.7"** (Pro Max) and **6.5"** sizes. Best 4–5 to capture:
1. The weightless greeting — "just what's on your radar."
2. Buddy sending the email (the review card + "Real world" receipt).
3. The money glance — impulse vs planned.
4. Brain-dump triage (now / later / let go).
5. A reschedule with the one-tap **Undo**.
- ⚠️ Take them on a clean demo account (no real financials on screen).

## Still needs you (dashboard-only, quick)
- Confirm the ⚠️ items above (analytics linkage, tracking answer, category).
- The **Paid Apps agreement + tax/banking** forms (required before a paid/IAP app can go live).
