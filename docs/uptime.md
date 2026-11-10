# Uptime monitoring

FocusLedger is watched by a GitHub Actions workflow in this repo,
[`.github/workflows/uptime.yml`](../.github/workflows/uptime.yml). It's inspired
by [Upptime](https://github.com/upptime/upptime) (MIT), but runs here, with no
extra repo, token or secret.

## What it checks

| URL | How often | Why |
|---|---|---|
| `https://focusledger.net/` (landing) | every 5 min | the front door |
| `https://focusledger.net/pricing` | every 5 min | where buyers go |
| `https://focusledger.net/signup` | every 5 min | where new users go |
| `https://focusledger.net/health` | hourly (at :01) | app + database + migrations |

Each check records the HTTP status and response time (shown as a table in the
run's summary page under **Actions → Uptime**). A check **fails** when its
final attempt:

- gets no response, or a status outside 2xx/3xx (redirects count as up), or
- takes longer than `SLOW_THRESHOLD_SECONDS` (default **15s**).

**Retry and cold starts.** A failed or slow first attempt is retried once after
`RETRY_DELAY_SECONDS` (20s), and only the retry decides. Each request may take
up to `MAX_TIME_SECONDS` (90s). If the Render web service is on a plan that
sleeps when idle, the first request after sleeping takes about a minute while
it boots. That first slow hit shows up in the run summary as "retried (first
try: …)" but doesn't raise an alarm; a server that is still slow or broken on
the retry does. To be stricter, lower the threshold or set the retry delay to
0; to be looser, raise the threshold. All four knobs are `env:` values at the
top of the workflow.

**Why `/health` is only hourly.** `/health` runs `SELECT 1` on Neon. Calling it
every 5 minutes would keep Neon's compute awake around the clock and use up
the free compute-hour allowance (see the "cron diet" note at the top of
`render.yaml`). The hourly check shares the wake-up the hourly crons already
cause. The three public pages are served without touching the database (no
cookie means no session lookup), so checking them every 5 minutes is free.

**Analytics.** Requests carry the header `X-FL-Automation: uptime` and a
user agent containing `FocusLedger-uptime`. `lib/analytics-filter.js`
classifies either one as `ci`, so these checks never count as visitors. (curl
doesn't run page JavaScript, so no beacon fires anyway; the filter is the
backstop.)

## How alerts arrive

- **Down:** the first failing run opens a GitHub issue labelled `uptime`,
  titled "Uptime: focusledger.net check failing (…)", with the results table
  and a link to the run. GitHub emails the repo owner about new issues
  (Settings → Notifications on github.com; "Watching" the repo makes sure).
  The run is also marked failed, which GitHub can email about too.
- **Still down:** later failing runs comment on the same issue, at most once
  an hour (`COMMENT_EVERY_MINUTES`), or sooner if the set of failing URLs
  changes. No duplicate issues.
- **Recovered:** the first fully passing run comments "Recovered" and closes
  the issue. A `/health` outage is only closed by a run that re-checked
  `/health` (an hourly or manual run).
- **Run it by hand:** Actions → Uptime → Run workflow. A manual run checks all
  four URLs.

Things to know:

- The repo is **public**, so uptime issues are public too. They contain only
  URLs, status codes and timings.
- GitHub's scheduler is best effort: "every 5 minutes" is often 5–15 in
  practice, and runs can be skipped when GitHub is busy.
- GitHub **disables scheduled workflows after 60 days with no commits** in a
  public repo. If the repo goes quiet, re-enable the workflow on the Actions
  tab.
- Public repos get Actions minutes free, so the ~9,000 short runs a month
  cost nothing.

## Optional: full Upptime with a status page

Upptime adds a public status page (on GitHub Pages), response-time graphs
and history committed to a repo. It needs its own repository and a personal
access token, so it's a founder step. About 15 minutes:

1. **Create the repo from the template.** Open
   <https://github.com/upptime/upptime>, click **Use this template → Create a
   new repository**, owner `here4vibes`, name e.g. `focusledger-status`,
   **Public** (GitHub Pages on the free plan needs a public repo). Tick
   "Include all branches" (the site builds from `gh-pages`).
2. **Create a token.** github.com → Settings → Developer settings →
   **Fine-grained tokens → Generate new token**. Resource owner `here4vibes`,
   repository access: only `focusledger-status`. Repository permissions:
   **Actions**, **Contents**, **Issues** and **Workflows**: read and write
   (Metadata: read is added automatically). Pick an expiry and put a
   reminder in your calendar to renew it.
3. **Add the secret.** In the new repo: Settings → Secrets and variables →
   Actions → **New repository secret**, name `GH_PAT`, value = the token.
4. **Edit `.upptimerc.yml`** in the new repo to:

   ```yaml
   owner: here4vibes
   repo: focusledger-status

   # Each site sends X-FL-Automation so lib/analytics-filter.js counts it as
   # our own automation ("ci"), never as a visitor.
   sites:
     - name: Landing page
       url: https://focusledger.net/
       maxResponseTime: 15000
       headers:
         - "X-FL-Automation: upptime"
     - name: Pricing
       url: https://focusledger.net/pricing
       maxResponseTime: 15000
       headers:
         - "X-FL-Automation: upptime"
     - name: Sign up
       url: https://focusledger.net/signup
       maxResponseTime: 15000
       headers:
         - "X-FL-Automation: upptime"
     # Add once Neon is on a paid plan (Upptime checks every 5 minutes, which
     # would keep the free Neon compute awake; see "Why /health is only hourly"):
     # - name: App health
     #   url: https://focusledger.net/health
     #   maxResponseTime: 15000
     #   headers:
     #     - "X-FL-Automation: upptime"

   assignees:
     - here4vibes

   status-website:
     # GitHub Pages at https://here4vibes.github.io/focusledger-status/
     baseUrl: /focusledger-status
     name: FocusLedger status
     introTitle: "Is FocusLedger up?"
     introMessage: Live status of focusledger.net, checked every 5 minutes.
     navbar:
       - title: FocusLedger
         href: https://focusledger.net
   ```

   For a custom domain such as `status.focusledger.net`, replace `baseUrl`
   with `cname: status.focusledger.net` and add a DNS `CNAME` record pointing
   `status` to `here4vibes.github.io`.
5. **Turn on Pages.** Settings → Pages → Source: **Deploy from a branch**,
   branch `gh-pages`, folder `/ (root)`. Then Actions → **Setup CI** → Run
   workflow. The status page appears a few minutes later.
6. **Keep this repo's workflow for `/health`** until `/health` is in Upptime.
   Once it is, this workflow can be deleted (or kept as a second opinion).
   Upptime opens its own issues on outages and assigns them to the people in
   `assignees`, who get emailed.
