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

## How it works

```
GitHub API ──┐
npm API ─────┤
PyPI API ────┤
Docker Hub ──┼──► collect-*.js ──► SQLite (data/analytics.db) ──► Next.js dashboard
HuggingFace ─┤                                                ╲
BigQuery ────┘                                                 ╲──► static JSON (data/*.json)
                                                                    consumable by external sites
                                                                    via raw.githubusercontent.com
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
```

## Automated daily collection

The included workflow (`.github/workflows/collect-stats.yml`) runs daily at `6:00 AM UTC`. To enable it:

1. Settings → Secrets and variables → Actions → New secret.
2. Add `GH_STATS_TOKEN` (a Personal Access Token with `repo` or `public_repo` scope).
3. Optionally set `GOOGLE_APPLICATION_CREDENTIALS_JSON` for BigQuery country stats.

The workflow auto-discovers public repos in the orgs listed in `GITHUB_ORG`. Add a new repo to the org, the next run picks it up. No manual list maintenance.

## Architectural notes (so you can audit it)

- **DB is SQLite.** No external database. The full DB ships with the repo as `data/analytics.db` (~7 MB for 30+ repos at one year of history).
- **All API endpoints are unauthenticated** because the data is already public. If you self-host, that's by design.
- **No tracking, no telemetry, no third-party scripts** in the dashboard.
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
