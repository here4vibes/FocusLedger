# FocusLedger — ADHD-Native UI Refactor Plan

Rooted in the same research the `/science` page stands on (Barkley on behavioral
inhibition & time sense, Gollwitzer on implementation intentions, Antonovsky on
sense of coherence, Thaler & Sunstein on nudges). Based on a three-dimension audit
of the **live** UI: information architecture, visual design system, and core flows.

## North star
Collapse FocusLedger from a sprawl of competing surfaces into **one calm,
conversation-first surface that reflects the user's real life.** For an ADHD brain
the app itself must not be a watermelon: every extra screen, choice, and competing
colour is activation energy spent before a single task gets done.

## The spine — ADHD mechanism → UI principle
| Mechanism (research) | UI principle |
|---|---|
| Task-initiation / avoidance (the "watermelon") | One obvious next action; hide the pile, show the next slice. |
| Working-memory deficit | The screen *is* the memory — never make the user hold state to act. |
| Time blindness | Make time physical: today/tomorrow/overdue, durations, nudges at the moment. |
| Delay aversion / dopamine | Immediate, visible reward on completion — on every surface. |
| Implementation intentions | "When X, I'll do Y" — tie actions to triggers/times. |
| Rejection sensitivity (RSD) | Zero punitive UI. No shame, no destructive "let go," no backlog walls. |
| Sense of coherence | Calm, ordered, meaningful — the world feels comprehensible and handled. |
| Limited bandwidth / overwhelm | One thing at a time; progressive disclosure; a quiet visual field. |

## What the audit found (headline problems)
1. **IA is a watermelon.** FOUR competing "home" screens — `/weightless` (calm chat home), `/app` (card hub), `/home`=`/portal` (command center), legacy `/app/*` SPA — on top of the 4-tab classic app. Login lands on `/app/buddy`; **the calm weightless home is effectively dead code**, siloed from the nav. Max "where am I / where do I go" load.
2. **The design system has drifted.** Four conflicting `:root` token sets; `--orange` is **gold on some pages, coral on others**; `weightless` is a separate blue/serif design language sharing nothing with the brand; dark mode is half-implemented; the main dashboard shows **5–7 saturated hues + 3 floating animated layers at once**. (The written `css/design-system.css` is excellent — the pages just left it behind.)
3. **Flows are inconsistent.** The lavish completion-reward animation fires on **one of three** surfaces; **three competing "today" views**; the promised now/later/let-go triage **isn't built** ("let go" = destructive delete with a scary confirm); time made concrete on only one page; money friction punishes legitimate planned purchases; raw diagnostic error strings leak to users.

## The plan — prioritized, sliceable

### Slice 1 — One front door (IA) · highest leverage
*Problem:* 4+ homes, the calm one is dead code, nav sprawl.
*Serves:* task-initiation, working memory, coherence.
- Make **weightless the real post-login landing** (route login → `/weightless`).
- Give weightless **lightweight navigation** into the deeper surfaces (it's siloed today).
- **Retire/merge** the redundant overviews (`home.html` hub, `portal.html`, legacy `app.html`) into weightless as the single overview.
- Clean duplicate routes + orphan pages (`tasks.html`, `score.html`, `recap.html`, aliased `/home`+`/portal`, etc.).
*Why first:* it eliminates the app-level watermelon and decides the canvas everything else lives on.

### Slice 2 — One design system (visual load)
*Problem:* 4 token sets, `--orange` ambiguity, weightless as a separate language, half-done dark mode, dashboard overload.
*Serves:* limited bandwidth / overwhelm, coherence.
- Collapse to the canonical `design-system.css` tokens; delete per-page `:root` overrides.
- Fix `--orange`: distinct names for **gold-brand** vs **coral-money**; one warm-white, one card radius, one gold, one success colour.
- **Canon decision:** weightless's calm *is* the direction — harmonize it with the brand palette (navy/gold) so the calmest screen becomes the standard, not the outlier.
- Cut simultaneous accents + floating/animated layers on the dashboard; finish or drop dark mode uniformly.

### Slice 3 — Consistent ADHD-shaped flows
*Problem:* reward inconsistency; 3 todays; no gentle triage; time concrete on one page; money friction; leaked errors.
*Serves:* dopamine/reward, time-blindness, implementation intentions, RSD.
- **Reward everywhere:** the completion dopamine (particles/streak) fires on conversation + step + money completions, not just the tasks page.
- **One "today":** the weightless radar (top 3) is the source of truth; the time-blindness timeline (`/app/today`, calibrated durations) becomes a drill-in.
- **Build the gentle triage** that's promised but missing: now/later/let-go as one low-friction interaction; "let go" = soft release, not a destructive delete.
- **Make time concrete everywhere** (calibrated durations + relative dates on all surfaces).
- **Fix money friction** (planned-purchase bypass of the 10-min wait); stop leaking diagnostic errors to users.

### Slice 4 — Polish & cleanup
Orphan pages, duplicate routes, WCAG contrast fixes (muted text on cream, nav text), motion audit (don't fire list-reveal + skeleton + buddy-pulse + page-fade at once).

## Execution notes
- One slice = one or more **small PRs**, each with CI + the Pre-Ship Checklist (Buddy bubble tap, mobile/desktop viewports, overflow, nav, changelog).
- Order: **1 → 2 → 3 → 4.** Slice 1 is the highest cognitive-load win and sets the canvas; Slice 2 is the foundation; Slice 3 is the payoff.
- **Biggest risk is Slice 1** (routing/nav touches everything). Keep the classic tabs reachable during the transition; move behind careful testing, not a big-bang.
