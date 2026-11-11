# Render crons: what the code expects vs what is live

**Render Blueprint sync is off for this account.** `render.yaml` is
documentation of what the code expects; changing it changes nothing in
production. Every cron below was created by hand in the Render dashboard and
only changes when someone edits it there.

Live schedules were read from the Render dashboard on **2026-11-10**. Update
this file whenever a cron is added, removed or rescheduled, in the same PR
that changes `render.yaml`.

## To do in the Render dashboard

In order of how much is broken today:

1. **`evening-checkin-sender`: set the schedule to `0 * * * *`** (it is
   `0 20 * * *`).
   The job sends each user's evening spending check-in push in the hour of
   their own `evening_time` (default 20:00 local). Run once a day at 20:00 UTC
   it only matches people for whom 20:00 UTC is that hour: nobody in the US
   (it's 3–4pm Eastern, 12–1pm Pacific). **The push is not going out.**
2. **`cold-start-nudge`: set the schedule to `0 * * * *`** (it is `0 9 * * *`).
   The job sends at 10:00 in each user's timezone. Run once a day at 09:00 UTC
   it only matches users in UTC+1. **The push is not going out for US users.**
3. **Delete `rss-sync`.** Its script (`jobs/rss-sync.js`) was removed with the
   news feed (#268), so it fails every 20 minutes.
4. **Delete `beta-reengagement-blast`.** Its script is gone too. It is
   scheduled for Feb 29 (next in 2028) and was written to email every user
   that Autopilot is "free during beta".
5. **Add `STRIPE_WEBHOOK_SECRET`** to the `focusledger` environment group (the
   signing secret of the live webhook endpoint, from the Stripe dashboard →
   Developers → Webhooks). Without it every Stripe webhook gets a 503, so
   renewals, cancellations made in Stripe and failed payments never reach the
   app. Stripe retries for up to 3 days.
6. **`DATABASE_URL`: change `sslmode=require` to `sslmode=verify-full`** in
   both the `focusledger` environment group and the web service
   (Sentry NODE-EXPRESS-4).
7. **Check `SENTRY_DSN` is in the `focusledger` environment group**, and that
   every cron has that group linked (service → Environment → Link environment
   group). Without it a cron's errors, including the cadence alarm below, stay
   in Render logs only.

Your call, not broken:

8. **`movement-break-check`, `impulse-spending-check`, `followup-email-check`
   (every 15 minutes) and `pattern-detection` (weekly) are still running.**
   `render.yaml` has had them commented out as "disabled pre-launch" since
   2026-07-21, to let the Neon database sleep between the hourly jobs; they
   were never suspended in the dashboard. Each 15-minute run wakes the
   database, which counts against Neon's free compute hours. Suspend them
   (cron → Settings → Suspend) to get that saving, or leave them running and
   say so, and `render.yaml` will be changed to match.

## Every cron

"Expected" is what the job's code needs. "Live" is the dashboard on
2026-11-10.

| Render cron | Command | Expected | Live | State |
|---|---|---|---|---|
| `morning-nudge` | `node jobs/morning-nudge.js` | `0 * * * *` | `0 * * * *` | OK |
| `evening-nudge` | `node jobs/evening-nudge.js` | `0 * * * *` | `0 * * * *` | OK |
| `task-deadline-nudge` | `node jobs/task-deadline-nudge.js` | `0 * * * *` | `0 * * * *` | OK |
| `routine-nudge-check` | `node jobs/routineNudgeCheck.js` | `0 * * * *` | `0 * * * *` | OK |
| `email-crons` | `node jobs/email-crons.js` | `0 * * * *` | `0 * * * *` | OK |
| `buddy-engagement` | `node jobs/buddy-engagement.js` | `0 * * * *` | `0 * * * *` | OK |
| `renewal-heads-up` | `node jobs/renewalHeadsUpJob.js` | `0 * * * *` | `0 * * * *` | OK |
| **`evening-checkin-sender`** | `node jobs/evening-checkin.js` | **`0 * * * *`** | **`0 20 * * *`** | **Wrong: change to hourly (item 1)** |
| **`cold-start-nudge`** | `node jobs/coldStartNudge.js` | **`0 * * * *`** | **`0 9 * * *`** | **Wrong: change to hourly (item 2)** |
| `plaid-daily-sync` | `node jobs/plaid-sync.js` | `0 6 * * *` | `0 6 * * *` | OK |
| `stash-purge` | `node jobs/stash-purge.js` | `0 2 * * *` | `0 2 * * *` | OK |
| `cross-domain-insights` | `node jobs/crossDomainInsightsJob.js` | `0 2 * * *` | `0 2 * * *` | OK |
| `daily-reveal` | `node jobs/dailyRevealJob.js` | `0 9 * * *` | `0 9 * * *` | OK |
| `movement-break-check` | `node jobs/movementBreakCheck.js` | suspended (works at `*/15 * * * *`) | `*/15 * * * *` | Running; meant to be suspended (item 8) |
| `impulse-spending-check` | `node jobs/impulseSpendingCheck.js` | suspended (works at `*/15 * * * *`) | `*/15 * * * *` | Running; meant to be suspended (item 8) |
| `followup-email-check` | `node jobs/followupEmailCheck.js` | suspended (works at `*/15 * * * *`) | `*/15 * * * *` | Running; meant to be suspended (item 8) |
| `pattern-detection` | `node jobs/patternDetectionJob.js` | suspended (works at `0 3 * * 0`) | `0 3 * * 0` | Running; meant to be suspended (item 8) |
| **`rss-sync`** | `node jobs/rss-sync.js` (file deleted) | none | `*/20 * * * *` | **Fails every run: delete (item 3)** |
| **`beta-reengagement-blast`** | script deleted | none | `0 5 29 2 *` | **Delete (item 4)** |

The commands in this table are the ones in `render.yaml`. The dashboard's
commands were confirmed for `renewal-heads-up`, `evening-checkin-sender`,
`cold-start-nudge` and `rss-sync`; check the others when you're in there.

All times are UTC. Hourly jobs run on the hour so they share one database
wake-up per hour.

## The cadence alarm

`jobs/evening-checkin.js` and `jobs/coldStartNudge.js` only send to users whose
local hour matches right now, so they are only correct when run every hour. On
each run they record a heartbeat in the `cron_heartbeats` table and compare it
with the previous one (`lib/cron-cadence.js`, `db/cron-heartbeats.js`). If the
previous run was more than 90 minutes ago they log an error like:

```
[evening-checkin] Render cron "evening-checkin-sender" is not running hourly: the previous run was 24 hours ago. This job sends the evening spending check-in push at each user's own evening_time, so on any other schedule most users never get it. Fix: Render dashboard → cron "evening-checkin-sender" → Settings → Schedule → 0 * * * * (see docs/render-crons.md).
```

That line reaches Sentry (every `console.error` does, when `SENTRY_DSN` is
set) as one issue per cron, and stops once the schedule is hourly. Until items
1 and 2 are done, expect it once a day from each of the two jobs, starting
with the second run after this ships (the first run has nothing to compare
with). A long Render outage or a suspended cron resuming triggers it once too;
that is accurate, not a bug.

The alarm only reports. It starts nothing and schedules nothing: the job still
runs only when Render starts it.

To see the heartbeats:

```sql
SELECT job_name, last_run_at, previous_run_at, run_count FROM cron_heartbeats;
```

## Adding or changing a cron

1. Write the job in `jobs/` and add it to `render.yaml`.
2. Create or edit the cron in the Render dashboard by hand, and link the
   `focusledger` environment group.
3. Add or update its row in the table above, with the date you checked the
   live schedule.
4. If the job filters users by their local hour, call `checkHourlyCadence`
   at the start of the run, as the two jobs above do.
