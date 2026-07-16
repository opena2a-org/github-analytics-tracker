# GitHub Analytics Tracker

[![Status: experimental](https://img.shields.io/badge/status-experimental-orange)](./STATUS.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](./package.json)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Collect Analytics](https://github.com/opena2a-org/github-analytics-tracker/actions/workflows/collect-stats.yml/badge.svg)](https://github.com/opena2a-org/github-analytics-tracker/actions/workflows/collect-stats.yml)

> **GitHub deletes your traffic data every 14 days. This doesn't.**
>
> A self-hosted multi-source analytics tracker that preserves GitHub
> traffic beyond the 14-day retention limit and aggregates download
> stats from npm, PyPI, and Docker Hub into a single dashboard.

## Why this exists

GitHub's repo Insights → Traffic page is great — for two weeks. After that, the data is gone. If you don't check daily, you never see it again. There's no historical chart, no alert, no export.

This tracker runs once a day (via GitHub Actions), pulls the API, stores everything in a local SQLite database, and gives you a Next.js dashboard with the historical chart you wish GitHub provided. It also pulls download stats from npm, PyPI, and Docker Hub so you have one place to see ecosystem adoption across all your release channels.

## What it tracks

| Source | What | Retention |
|---|---|---|
| **GitHub** traffic | Daily views + clones, with deduplicated 14-day uniques | Unlimited (this tracker) |
| **GitHub** referrers | Top traffic sources, snapshot per day | 90+ days (configurable) |
| **GitHub** popular paths | Most-visited files, snapshot per day | 90+ days (configurable) |
| **GitHub** stars + forks | Daily totals across all tracked repos | Unlimited |
| **GitHub** contributors | Top contributors per repo, snapshot per day | Unlimited |
| **GitHub** release downloads | Per-tag download counts | Unlimited |
| **npm** | Daily + last-30-day downloads per package | Unlimited |
| **npm** by version | Per-version download splits | Unlimited |
| **PyPI** | Daily downloads, by Python version, by OS | Unlimited |
| **PyPI** by country | Country-level downloads via BigQuery (optional) | Unlimited |
| **Docker Hub** | Pull counts + tag history per image | Unlimited |
| **HuggingFace** | Model downloads (all-time + rolling 30d) and likes per model | Unlimited |
| **First-party CLI** | Active users (distinct installs → WAU/MAU), version + country splits, from the Registry's coarse public adoption feed | Daily snapshots |

First-party CLI telemetry is **active users, not downloads** — a download is not a user — so it is shown distinctly and never summed into the download adoption total (same as Chrome weekly-active users).

## How it works

```
GitHub API ──┐
npm API ─────┤
PyPI API ────┤
Docker Hub ──┼──► collect-*.js ──► SQLite (data/analytics.db) ──► Next.js dashboard
HuggingFace ─┤                                                ╲
BigQuery ────┤                                                 ╲──► static JSON (data/*.json)
Registry ────┘                                                      consumable by external sites
(CLI telemetry)                                                     via raw.githubusercontent.com
```

A daily GitHub Actions cron (`6:00 AM UTC`) runs the collectors, regenerates the SQLite DB, and commits the data plus per-source static JSON artifacts back to the repo. Your dashboard reads from the DB; external sites can read the JSON directly without spinning up the dashboard.

## Quick start

```bash
git clone https://github.com/opena2a-org/github-analytics-tracker.git
cd github-analytics-tracker
npm install
cp .env.example .env       # add your GITHUB_TOKEN
npm run setup-db
npm run collect            # fetch from GitHub
npm run collect-npm        # fetch npm download stats
npm run dev                # dashboard at http://localhost:3000
```

That's it. The dashboard renders whatever's been collected so far. After running for a few days, the historical charts start filling in.

## Configure data sources

In `.env`:

```bash
GITHUB_TOKEN=ghp_...                                          # required for GitHub
GITHUB_ORG=opena2a-org,opena2a-standards,ecolibria           # auto-discovers all public repos
REPOS_TO_TRACK=owner/repo,owner/repo                          # optional extra repos
NPM_AUTHOR=ecolibria                                          # auto-discovers all packages by this user
NPM_PACKAGES=hackmyagent,opena2a-cli                          # optional extra packages
PYPI_PACKAGES=cryptoserve,aim-sdk                             # comma-separated
DOCKER_IMAGES=opena2a/aim-server,opena2a/dvaa                 # comma-separated
HF_AUTHOR=opena2a                                             # auto-discovers all HuggingFace models by this org/user
HF_MODELS=org/model,org/other                                 # optional extra models
HF_TOKEN=hf_...                                               # optional, raises HF rate limits / private repos
GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-key.json          # optional for BigQuery country stats
REGISTRY_URL=https://api.oa2a.org                             # optional; enables first-party CLI telemetry
REGISTRY_TELEMETRY_TOKEN=...                                  # optional; SA token for the gated detail view (server-side only)
ANALYTICS_TRACKER_PASSWORD=...                                # optional; gates the fine-grained telemetry view on THIS dashboard
TELEMETRY_STALE_AFTER_DAYS=2                                  # optional; consecutive failure days tolerated before the collector exits 1
```

The collector persists only the coarse, anonymous adoption feed. The fine-grained
view (command usage, reliability, by-day) is fetched live from the Registry's
authenticated endpoint behind `ANALYTICS_TRACKER_PASSWORD` and is never written to
the committed database.

## Automated daily collection

The included workflow (`.github/workflows/collect-stats.yml`) runs daily at `6:00 AM UTC`. To enable it:

1. Settings → Secrets and variables → Actions → New secret.
2. Add `GH_STATS_TOKEN` (a Personal Access Token with `repo` or `public_repo` scope).
3. Optionally set `GOOGLE_APPLICATION_CREDENTIALS_JSON` for BigQuery country stats.
4. Optionally set the `REGISTRY_URL` Actions **variable** to enable first-party CLI telemetry collection. Unset, the collector warns and skips.

### When telemetry collection stops

A collector that fails quietly is worse than one that fails outright. Two different
failures are checked, because they look nothing alike.

**The feed can't be retrieved.** A blip is tolerated; an outage is not:

| Situation | Result |
|---|---|
| `REGISTRY_URL` unset, nothing ever collected | warning, exit 0 — legitimately not provisioned |
| `REGISTRY_URL` unset, but telemetry *was* collected before | **error, exit 1** — the variable was removed |
| `REGISTRY_URL` set, nothing ever collected | **error, exit 1** — broken feed or wrong URL |
| Failing for ≤ `TELEMETRY_STALE_AFTER_DAYS` (default 2) | warning, exit 0 — transient |
| Failing for longer | **error, exit 1** — the dashboard is serving stale numbers |

**The feed responds fine but the numbers drained.** This is the shape a broken
ingest path actually takes: the adoption feed keeps answering `200` with a
structurally valid payload while the active-user counts empty out. A retrieval check
sees a healthy response and happily persists the zeros. So the collector also errors
when the feed reports `mau=0` while the last snapshot with any activity had users —
real users do not all vanish overnight.

Two details that matter, both learned the hard way:

- It keys on **MAU alone**, not on "MAU and installs are both zero". `total_installs`
  is a 90-day window and `mau` is 30-day, so a broken ingest empties MAU at T+30
  while installs coasts to T+90. Requiring both would wave through ~60 days of a dead
  pipeline. Installs still reporting while actives are zero is corroboration, not a
  reason to stay quiet.
- It compares against the **last snapshot that had users**, not yesterday. Comparing
  to yesterday makes the alert self-silencing: day one fires, its zeros become the
  baseline, and every later day sees zero-following-zero and reports healthy. Keying
  on the last live snapshot keeps the alarm ringing and states the growing gap.

The zeros are still recorded as reported (we don't suppress what the feed said); the
point is to raise the alarm. A real decline is not an outage — only reaching zero is.
A fleet that has never reported an active user is not an outage either.

Failures emit GitHub Actions annotations so they surface in the run summary, and a
final step re-raises the failure **after** the day's data is committed — so the run
goes red and the scheduled-run notification fires, without a telemetry outage costing
the other collectors their data. A failed run never writes: zeros must not overwrite
a good snapshot.

Untrusted feed text (HTTP error bodies) is sanitized before it reaches any log line —
the Actions runner parses `::command::` lines on both stdout and stderr, so an
unsanitized response body could otherwise forge or suppress these very annotations.

The workflow auto-discovers public repos in the orgs listed in `GITHUB_ORG`. Add a new repo to the org, the next run picks it up. No manual list maintenance.

## Architectural notes (so you can audit it)

- **DB is SQLite.** No external database. The full DB ships with the repo as `data/analytics.db` (~7 MB for 30+ repos at one year of history).
- **API endpoints are unauthenticated** because the data is already public — with one exception: `/api/telemetry-detail` (fine-grained CLI usage) is gated by `ANALYTICS_TRACKER_PASSWORD` and only served when that is set.
- **No visitor tracking, no analytics scripts, no third-party scripts** in the dashboard itself. (The "First-party CLI" source is aggregate active-user data reported by the org's own CLIs — not tracking of this dashboard's viewers.)
- **No PII.** GitHub's referrer + popular-paths APIs return only aggregate counts — no IPs, no user agents, no session data.
- **Static JSON is the canonical export.** `data/summary.json` carries cross-source totals; `data/*-stats-*.json` carry per-source per-package details. Consume directly via raw.githubusercontent.com if you don't want to run the dashboard.

## How the GitHub metrics actually work

GitHub's traffic API has subtleties worth knowing:

1. **Daily uniques cannot be summed.** A visitor on three different days appears as `uniques=1` on each of those days; summing gives 3, not 1. We store daily counts AND the 14-day rolling summary (which GitHub deduplicates correctly) so consumers can pick the right one.
2. **Today's data is partial.** The current day is still being written. We skip it on collection and only persist completed days.
3. **Referrers and popular paths are 14-day rolling snapshots, not daily breakdowns.** We store one snapshot per day; on re-runs for the same day, we replace.
4. **All-time uniques are unreported** because they would be wrong for the reason above. We surface the 14-day API figure instead.

## Database schema

| Table | Purpose |
|---|---|
| `repositories` | Tracked repos |
| `traffic_views`, `traffic_clones` | Daily counts (completed days) |
| `traffic_summary` | 14-day deduplicated uniques |
| `referrers`, `popular_paths` | Daily snapshots of 14-day rolling data |
| `stargazers`, `forks` | Daily totals |
| `github_contributors`, `github_releases` | Per-repo extras |
| `npm_packages`, `npm_downloads`, `npm_version_downloads` | npm |
| `pypi_packages`, `pypi_downloads`, `pypi_python_versions`, `pypi_system_stats`, `pypi_country_downloads` | PyPI |
| `docker_images`, `docker_pulls`, `docker_tags` | Docker Hub |
| `huggingface_models`, `huggingface_stats` | HuggingFace model downloads + likes (daily snapshots) |
| `telemetry_snapshots`, `telemetry_tool_snapshots`, `telemetry_version_snapshots`, `telemetry_country_snapshots` | First-party CLI active users (coarse daily snapshots) |

Run `sqlite3 data/analytics.db .schema` for the full DDL.

## API endpoints

All read-only, no auth. JSON responses.

```
GET /api/repos                       # list of tracked repos
GET /api/stats?repo_id=1&days=30     # per-repo stats (days: 7|14|30|90|365|all)
GET /api/overview                    # cross-source totals
GET /api/trends?repo_id=1            # daily trend data for charts
GET /api/npm-stats                   # npm package stats
GET /api/pypi-stats                  # PyPI package stats
GET /api/docker-stats                # Docker image stats
GET /api/huggingface-stats           # HuggingFace model stats
GET /api/telemetry                   # first-party CLI active users (coarse, public)
GET /api/telemetry-detail            # fine-grained CLI usage (gated by ANALYTICS_TRACKER_PASSWORD)
```

## Comparison

| | This | [ungh.cc](https://ungh.cc) | Manual |
|---|---|---|---|
| GitHub history beyond 14 days | ✓ | ✗ | ✗ |
| npm + PyPI + Docker | ✓ | ✗ | partial |
| Self-hosted (no third party sees your token) | ✓ | ✗ | ✓ |
| Dashboard included | ✓ | ✗ | ✗ |
| BigQuery country stats | ✓ optional | ✗ | ✗ |

## FAQ

**How far back can I see data?**
As far back as when you started collecting. The first run captures the available 14 days; subsequent runs append.

**What if I miss a day?**
GitHub keeps 14 days, so you have a 2-week buffer. Run the collector again to backfill.

**How much storage?**
~10-20 MB per year per 20 repos.

**Can I track private repos?**
Yes, if your `GITHUB_TOKEN` has access. Auto-discovery via `GITHUB_ORG` only picks up public repos; add private ones to `REPOS_TO_TRACK` explicitly.

**Why not all-time unique visitors?**
Daily uniques can't be summed (a visitor on 5 days = 5 in the sum, not 1). The 14-day API figure is the most accurate unique count GitHub will give you.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). For security issues, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) — built by [OpenA2A](https://opena2a.org).
