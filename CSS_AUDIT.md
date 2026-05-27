# FocusLedger CSS Architecture Audit
**Task:** #1805129 — CSS Refactor Chunk 1
**Date:** 2026-05-23
**Status:** COMPLETE

---

## 1. CSS File Map

| File | Scope | Key Classes | Notes |
|------|-------|-----------|-------|
| `public/app.html` (inline, line 30+) | /app page | `.dashboard`, `.task-card`, `.confetti-container` | **479KB of accumulated inline CSS** — largest file in project |
| `public/shared-nav.css` | ALL 17 app pages | `#shared-bottom-nav`, `.shared-nav-item`, `.page-content-wrapper` | Injected by `shared-nav.js`; the nav system for the entire app |
| `public/css/design-system.css` | Landing, app, settings, pricing | Design tokens, `.card`, `.btn`, `.app-nav` | Global design tokens loaded after page-level styles |
| `public/buddy-widget.css` | /app, /buddy, /money | `#bw-bubble`, `#bw-panel` | Floating Buddy bubble z-index: 9000 |
| `public/css/interaction-quality.css` | All pages | `.skeleton-shimmer`, `[data-stagger-list]` | Shared utilities: skeletons, stagger reveals |
| `public/insights.css` | /insights | `.insight-card`, `.card-progress` | Standalone insights page |
| `public/css/pages.css` | /story, /changelog | `.nav-hamburger` | Minimal — only landing nav and mobile drawer |
| `public/css/demo.css` | / (landing) | `.demo-section`, `.demo-task-item` | Interactive demo section only |
| `public/css/science.css` | /science | `.sci-section`, `.sci-card` | Standalone science page, self-contained |

**No dedicated app layout CSS file exists.** The `/app` page's layout lives entirely in `app.html`'s inline `<style>` block (~480KB of inline CSS and JS). This is the single biggest architectural issue.

---

## 2. The Two Broken Rules Causing `/app` Blank Page

### Broken Rule #1: Missing `.dashboard` Min-Height → Grid Collapse

**File:** `public/app.html`
**Line:** 165-173 (inline `<style>` block)
**Rule that would break the page:**
```css
.dashboard {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem;
    display: grid;
    grid-template-columns: 1.5fr 1fr;
    gap: 2rem;
    align-items: start;
    /* BROKEN: NO min-height — grid collapses to 0px height when all
       children are position:fixed or have height:0 (e.g., during
       JS-initiated loading state before task content is injected).
       Result: empty dashboard container (0px tall), nav appears at top. */
}
```

**Current state:** The `min-height: calc(100vh - 80px)` fix is **already present** on line 173 of app.html:
```css
.dashboard {
    ...
    min-height: calc(100vh - 80px); /* ← THIS FIX EXISTS, line 173 */
}
```

The fix is applied. The page renders. However, the fix is a workaround applied to a structurally broken container — the real issue is that the layout chain has no solid structural base.

**Root cause chain:**
1. `.dashboard` has no intrinsic height (it's a grid, not flex)
2. All children are document-flow elements — when JS hasn't injected content yet, or when content height = 0, grid collapses to 0
3. Bottom nav (`position: fixed; bottom: 0`) sits at viewport bottom correctly — but the `.dashboard` content appears at the TOP of the viewport because the grid has no min-height floor
4. `min-height: calc(100vh - 80px)` floors the grid at viewport height minus 80px — but 80px is a magic number (nav height approximation), not a proper CSS calculation

**The structural fix (for the next chunk, not this audit):**
The `.dashboard` grid should use `min-height: calc(100vh - var(--nav-height, 60px))` with a CSS variable, OR the grid should be wrapped in a flex column parent with `height: 100vh` and `overflow-y: auto`.

---

### Broken Rule #2: `.confetti-container` Missing Explicit Transparent Background

**File:** `public/app.html`
**Line:** 2219-2228 (inline `<style>` block)
**Rule that broke the page:**
```css
/* BEFORE FIX — this rule caused content visibility issues */
.confetti-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 9999;
    overflow: hidden;
    /* BROKEN: No background: transparent — browser default
       (usually transparent) may resolve unexpectedly in some
       rendering contexts, causing the confetti container to
       render on top of content or consume pointer events */
}
```

**Current state:** The `background: transparent !important` fix is **already present** on line 2228:
```css
.confetti-container {
    ...
    background: transparent !important; /* ← THIS FIX EXISTS, line 2228 */
}
```

**Root cause:** The `.confetti-container` uses `position: fixed; inset: 0;` (full-viewport overlay) with `z-index: 9999`. Without an explicit transparent background, certain browser configurations or compositing layers can cause the element to render non-transparently or capture pointer events unexpectedly. The `!important` ensures it cannot be overridden.

---

## 3. Bottom Nav Positioning — "Appears at Top" Issue

**File:** `public/shared-nav.css`
**Lines:** 87-101 (mobile) and 384-526 (desktop)

**Bottom nav CSS (mobile) — CORRECT:**
```css
#shared-bottom-nav {
    position: fixed;
    bottom: 0;   /* ← CORRECT: at bottom of viewport */
    left: 0;
    right: 0;
    height: var(--nav-height); /* 60px */
    background: var(--nav-bg); /* #011e5c */
    z-index: var(--nav-z); /* 1000 */
    ...
}
```

The nav CSS is correct. On mobile it anchors to `bottom: 0`. On desktop (768px+), it transforms to a 200px left sidebar anchored to `top: 0; left: 0;`.

**Why "bottom nav appears at top" may have occurred:**
The issue was NOT the nav CSS itself — it was that `.dashboard` had no `min-height`, causing the grid to collapse to 0px when empty. This made the page content area appear as a 0-height strip at the very top of the viewport. The fixed bottom nav (at `bottom: 0`) was at the actual bottom of the viewport — but relative to the collapsed content, it looked like it was at the "top" of the layout. With the `.dashboard` `min-height` fix, the layout now fills the viewport correctly.

**Desktop sidebar override rules (line 510-525):**
```css
/* Push content right to make room for sidebar */
body.shared-nav-active {
    padding-bottom: 0;
    padding-left: var(--nav-sidebar-width); /* 200px */
}

/* Fixed navs on desktop get left offset */
.app-nav[style*="position: fixed"],
.settings-nav[style*="position: fixed"],
.portal-nav[style*="position: fixed"] {
    left: var(--nav-sidebar-width);
    width: calc(100% - var(--nav-sidebar-width));
}
```

**Contradictory rule found:**
```css
/* Line 521-525 — Catch-all for all fixed elements starting at left: 0 */
[style*="position: fixed"][style*="left: 0"],
[style*="position: fixed"][style*="left:0"] {
    left: var(--nav-sidebar-width);
    width: calc(100% - var(--nav-sidebar-width));
}
```

This is a very broad rule that could affect ANY fixed-positioned element with `left: 0`. If another component uses `position: fixed; left: 0;` (e.g., a tooltip, modal overlay, or floating button), it would be incorrectly shifted 200px right on desktop. The confetti-container (line 2219: `position: fixed; top: 0; left: 0;`) would be shifted on desktop if it uses `left: 0` in an inline style.

**Status:** This is an unintended side effect — the catch-all is too broad.

---

## 4. CSS Class Chain: `.dashboard` → Task List → Task Cards

```
body                                    (shared-nav.js adds class: shared-nav-active)
  └── .dashboard                        (app.html line 165: CSS Grid, 1.5fr 1fr)
        ├── .tasks-column               (left grid column)
        │     ├── .column-header        (flex, space-between)
        │     ├── .add-task-form        (inline card wrapper)
        │     ├── .task-limit-banner
        │     ├── .nudge-banner
        │     ├── .filter-tabs         (flex row)
        │     └── .task-list            (flex col, gap: 0.5rem, id="taskList")
        │           └── [dynamically injected by JS]
        │                 └── .task-card  (warm-white bg, no border, 12px radius)
        │                       ├── .task-card-row1  (flex, space-between)
        │                       │     ├── .task-card-title  (ellipsis, nowrap)
        │                       │     └── .task-card-chevron
        │                       ├── .task-card-row2  (flex, wrap)
        │                       │     ├── .task-card-value
        │                       │     └── .task-card-time
        │                       └── .task-card-main
        │                             └── .task-checkbox  (22px square, spring animation)
        └── .spending-column           (right grid column)
              └── [expenses and budget content]
```

**Responsive override (app.html line 2531):**
```css
@media (max-width: 900px) {
    .dashboard { grid-template-columns: 1fr; } /* single column */
}
```

**Focused view override (app.html lines 4532, 4546):**
```css
body.view-tasks .dashboard {
    grid-template-columns: 1fr !important;
    max-width: 800px;
}
body.view-money .dashboard {
    grid-template-columns: 1fr !important;
    max-width: 800px;
}
```

---

## 5. Redundant and Contradictory Rules

### 5a. Scrollbar defined in 3 places
| File | Selector | Property |
|------|----------|----------|
| `public/css/design-system.css` | `::-webkit-scrollbar` | width: 6px |
| `public/shared-nav.css` | `::-webkit-scrollbar` | width: 6px |
| `public/css/science.css` | `::-webkit-scrollbar` | width: 6px |
| `public/css/pages.css` | `::-webkit-scrollbar` | width: 6px |
| `public/insights.css` | *(not present — inherits from body)* | |

**Impact:** Low (same value), but indicates no centralized scrollbar definition.

### 5b. `.task-card` defined TWICE in app.html
```css
/* First definition — line 471-479: base card style */
.task-card {
    background: var(--warm-white);    /* ✓ warm-white — correct */
    border-radius: 12px;
    padding: 0.9rem 1rem;
    transition: ...;
}
/* Hover adds shadow */
.task-card:hover {
    box-shadow: 0 4px 16px rgba(45, 42, 38, 0.06);
}

/* Second definition — line 481-485: overrides first, resets to flex-col */
.task-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}
```

The second `.task-card` block (line 481) is a duplicate selector in the same inline `<style>` block. It resets the `background`, `border-radius`, and `padding` properties (implicitly — since it doesn't repeat them, but the earlier values still apply via cascade). The `display: flex; flex-direction: column;` gets added on top.

**Issue:** The `.task-card:hover` rule from the first block still applies its `box-shadow`. The card has both `background: var(--warm-white)` (from first) and `display: flex; flex-direction: column` (from second). This is fragile — if a future agent removes the first block, the hover shadow breaks.

### 5c. `.app-nav` in design-system.css vs. app.html inline
| Location | Selector | Key properties |
|----------|----------|---------------|
| `public/css/design-system.css` line 152 | `.app-nav` | `background: var(--trust-blue)`, `backdrop-filter: none`, `border-bottom: none` |
| `public/app.html` line 79 | `.app-nav` | `position: sticky`, `top: 0`, `background: rgba(250,249,246,0.92)`, `backdrop-filter: blur(12px)` |

**Conflict:** app.html's inline `.app-nav` uses a translucent frosted-glass look (`rgba(250,249,246,0.92)` + blur), while design-system.css overrides it with solid Trust Blue + no blur. **app.html wins** (inline styles have higher specificity than external stylesheet class selectors), but the design-system.css rule is dead code that creates confusion.

### 5d. Pro badge text in app.html vs. settings.html
| Page | Badge Text | Source |
|------|-----------|--------|
| `app.html` (line 193) | `AUTOPILOT` | inline CSS |
| `settings.html` (line ~pro-badge area) | `TANDEM` | via `renderSubscription()` JS |

The badge text is inconsistent — hardcoded in some places, JS-driven in others. Recent change (2026-05-22) updated settings.html to use `plan_label` from API, but app.html still uses the hardcoded string in CSS.

### 5e. Duplicate media query for .dashboard padding (3 rules for same element)
| Line | Query | Property |
|------|-------|----------|
| 173 | (base) | `padding: 2rem` |
| 2534 | `(max-width: 900px)` | `padding: 1.25rem` |
| 2644 | `(max-width: 480px)` | `padding: 0.75rem` |

Three rules for the same element's padding across three breakpoints. This is intentional and correct — but the base padding is overridden at 900px, which itself is overridden at 480px. No issue here, just documentation.

---

## 6. CSS Architecture Issues (Root Cause of Fragmentation)

### 6a. All `/app` CSS is inline in a 479KB HTML file

`public/app.html` is 479,725 bytes — 99%+ of that is inline `<style>` and `<script>`. This means:
- CSS changes require editing a 479KB file (fragile, error-prone)
- The browser must parse ~480KB of inline CSS on every page load
- No caching of app page CSS (unlike external stylesheets which are cacheable)
- Multiple agents have added inline CSS over many cycles without coordinating
- The `design-system.css` is loaded AFTER this inline block (if at all), meaning token overrides may conflict in unexpected ways

**Evidence of accumulation:** The task-card CSS appears TWICE (duplicate selectors), confetti animation exists alongside the modern checkbox-spring animation, and there are multiple CSS variable declarations for `--navy` and `--gold` (both in `:root` in inline CSS and in design-system.css).

### 6b. No dedicated app layout stylesheet

The navigation system (`shared-nav.css`) and the main app content (`app.html` inline) are disconnected. The nav is injected dynamically via `shared-nav.js` at runtime — the CSS must accommodate this pattern, but the app layout CSS has no awareness of the nav injection chain.

### 6c. `design-system.css` is loaded AFTER page-level styles

From the design-system.css header:
> "This file loads AFTER page-level styles to override legacy tokens."

This means app.html's inline CSS sets the initial tokens, then design-system.css overrides them. But app.html also has its own `:root` block (lines 33-57) with complete token definitions — these may or may not conflict with design-system.css depending on load order. The load order depends on where `<link rel="stylesheet" href="/css/design-system.css">` appears in app.html's `<head>`.

### 6d. Z-index Stacking Context Chaos

| Element | z-index | File | Risk |
|---------|---------|------|------|
| `#bw-bubble` (Buddy) | 9000 | `buddy-widget.css` | May cover nav on mobile |
| `#bw-panel` (Buddy) | 9003 | `buddy-widget.css` | Topmost UI element |
| `#bw-panel-overlay` | 9002 | `buddy-widget.css` | Blocks all content |
| `.confetti-container` | 9999 | `app.html` inline | Always on top (transparency fixed) |
| `body > nav` (landing) | 200 | `design-system.css` | Clear separation |
| `.app-nav` (sticky) | 100 | `app.html` inline | Low, below most overlays |
| `#shared-bottom-nav` | 1000 | `shared-nav.css` | Correctly below Buddy |

**Buddy bubble z-index 9000** overlaps with the app-nav (100) and nav (1000) in a way that could cause visual conflicts on mobile — the bubble could cover the nav or content unexpectedly.

### 6e. Design System CSS variable conflicts

Two `:root` blocks define overlapping variables:

**In app.html inline (line 33):**
```css
:root {
    --orange: #c9a84c;
    --navy: #011e5c;
    --cream: #faf9f7;
    --warm-white: #fafaf8;
}
```

**In design-system.css (line 10):**
```css
:root {
    --navy: #011e5c;
    --orange: #c9a84c;
    --cream: #faf9f7;
    --warm-white: #fafaf8;
    --card-radius: 4px;
    --btn-radius: 4px;
}
```

Both files set `--navy` and `--orange` identically, so no conflict there. But `--card-radius` and `--btn-radius` are only in design-system.css, meaning app.html inline CSS cannot use them (it uses hardcoded `12px` for task cards instead of `var(--card-radius)` which is `4px`).

---

## 7. Deviations from Lightweight Research Patterns

Reference: `/docs/lightweight-ui-research.md` — Tiimo (Apple App of the Year 2025), Structured (Apple Design Award Winner), Habi

### 7a. Borders present on task items
**Target:** No borders on task items — use left-color-strip (4px) or background tint
**Current:** `.task-card` uses `background: var(--warm-white)` correctly (no border). ✅ **CLOSER**
**BUT:** `.spoke-card` still has `border: 1.5px solid var(--border)` (line 4065 in app.html). The "color over borders" approach has been partially applied to tasks but not to spoke cards.

### 7b. Warm off-white background — close but not exact
**Target:** `#F8F7F4`
**Current:** `var(--cream): #faf9f7` in design-system.css, `var(--warm-white): #fafaf8` in app.html
**Gap:** Neither matches `#F8F7F4` exactly. `--warm-white` (`#fafaf8`) is very close (only 1/255 off in green channel) — acceptable.

### 7c. Task item padding — too tight
**Target:** 16–20px vertical padding on task items
**Current:** `.task-card` has `padding: 0.9rem 1rem` (≈14px vertical)
**Gap:** Should be `padding: 1rem 1.125rem` (16–18px) per lightweight research

### 7d. Hard shadows on cards
**Target:** Soft or no shadows — `box-shadow: 0 1–2px rgba(0,0,0,0.08–0.12)`
**Current:** `.card` has `box-shadow: 0 2px 8px rgba(0,0,0,0.06)` (design-system.css line 51) — within acceptable range but on the higher end. `.task-card:hover` uses `0 4px 16px rgba(45,42,38,0.06)` — acceptable.
**Issue:** `.card` in app.html (line 200+) may have different shadow values — inconsistent card shadows across the app.

### 7e. Whitespace as divider — almost there
**Target:** 16px+ gaps between items, no horizontal rules
**Current:** `.task-list` has `gap: 0.5rem` (8px) — HALF the target gap
**Gap:** Should be `gap: 1rem` (16px) per lightweight research

### 7f. Micro-animations — partial
**Target:** 150ms ease transitions on hover; scale + fade on completion
**Current:**
- ✅ Task completion: `taskRowComplete` animation (scale + fade, 0.8s)
- ✅ Checkbox spring: `checkboxSpring` (scale 0.88→1.1→1, 0.45s)
- ✅ Nav hover: 150ms ease on `.shared-nav-item`
- ❌ Task card hover: `transition: transform 0.15s, box-shadow 0.15s` — no background color transition
- ❌ No scale effect on hover (Tiimo uses `transform: scale(1.02)` on hover)

---

## 8. Summary of All Layout Rules

### `.dashboard` (grid container)
```css
.dashboard {
    max-width: 1400px;       /* caps at 1400px */
    margin: 0 auto;          /* centered */
    padding: 2rem;            /* 32px all sides */
    display: grid;           /* CSS Grid */
    grid-template-columns: 1.5fr 1fr;  /* tasks : spending, 60/40 split */
    gap: 2rem;               /* 32px gap */
    align-items: start;      /* top-aligns columns */
    min-height: calc(100vh - 80px);  /* prevents collapse — FIXED */
}
```

### `#shared-bottom-nav` (mobile, < 768px)
```css
#shared-bottom-nav {
    position: fixed;
    bottom: 0;               /* viewport bottom */
    left: 0; right: 0;
    height: 60px;
    z-index: 1000;
    display: flex;
    flex-direction: row;      /* horizontal */
    box-shadow: 0 -2px 8px rgba(0,0,0,0.18);
}
```

### `#shared-bottom-nav` (desktop, ≥ 768px)
```css
#shared-bottom-nav {
    position: fixed;
    top: 0; left: 0;
    width: 200px;
    height: 100vh;           /* full viewport height */
    flex-direction: column;   /* vertical */
    border-right: 1px solid rgba(255,255,255,0.08);
    box-shadow: 2px 0 12px rgba(0,0,0,0.12);
}
/* body gets: padding-left: 200px to shift content right */
body.shared-nav-active {
    padding-left: 200px;
    padding-bottom: 0;       /* mobile padding cleared */
}
```

### `.task-card`
```css
.task-card {
    background: var(--warm-white);  /* #fafaf8 — warm off-white */
    border-radius: 12px;
    padding: 0.9rem 1rem;         /* ~14px vertical — should be 16px+ */
    display: flex;
    flex-direction: column;
    gap: 0.25rem;                  /* should be 0.5rem per lightweight */
    transition: transform 0.15s, box-shadow 0.15s, opacity 0.3s;
}
.task-card:hover {
    box-shadow: 0 4px 16px rgba(45,42,38,0.06);  /* soft shadow */
}
```

---

## 9. Exit Criteria Verification

- [x] `CSS_AUDIT.md` exists in repo root with complete findings
- [x] Broken Rule #1 identified: `.dashboard` missing `min-height` → grid collapse (FIXED in current code, line 173)
- [x] Broken Rule #2 identified: `.confetti-container` missing `background: transparent` (FIXED in current code, line 2228)
- [x] Bottom nav "at top" root cause explained: was a symptom of `.dashboard` collapse, not nav CSS issue
- [x] CSS class chain documented from `.dashboard` → task list → task cards
- [x] Redundant/conflicting rules documented (duplicate `.task-card`, `.app-nav` conflict, z-index stacking)
- [x] Deviations from lightweight patterns flagged (padding, gap size, micro-animations, borders on spoke cards)
- [x] Architecture issues documented (479KB inline CSS, no dedicated app stylesheet, z-index stacking chaos)