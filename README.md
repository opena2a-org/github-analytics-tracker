# GitHub Analytics Tracker

Preserve GitHub repository analytics beyond the 14-day retention limit.

Track and visualize repository traffic, clones, stars, forks, referrers, and popular content with historical data storage and a dashboard.

## Features

- **Historical Data** - Store unlimited history (GitHub only keeps 14 days)
- **Auto-Discovery** - Automatically tracks all public repos in a GitHub organization
- **Accurate Metrics** - Uses GitHub's 14-day API summaries for proper unique visitor counts
- **Automated Collection** - Daily GitHub Actions workflow
- **Multi-Repo Support** - Track unlimited repositories
- **SQLite Database** - Lightweight, no external database required
- **Dashboard** - Interactive charts via Next.js + Recharts

## What Gets Tracked

| Metric | Description | GitHub Retention |
|--------|-------------|------------------|
| **Views** | Total and unique page views | 14 days |
| **Clones** | Total and unique git clones | 14 days |
| **Referrers** | Where your traffic comes from | 14 days |
| **Popular Paths** | Most visited files/pages | 14 days |
| **Stars** | Star count over time | No history |
| **Forks** | Fork count over time | No history |
| **14-Day Summary** | Properly deduplicated unique visitor/cloner counts | Current only |

## How Metrics Work

GitHub's traffic API has important characteristics that affect how metrics should be interpreted:

1. **Daily data vs. period summaries:** The API returns per-day view/clone counts *and* a 14-day rolling summary. Daily `uniques` counts are per-day (a visitor on 3 different days = 3 in the daily sum). The 14-day summary properly deduplicates (that same visitor = 1).

2. **Today's data is partial:** The current day's traffic is still accumulating. This tracker skips today's data point and only stores completed days to avoid inaccurate entries.

3. **Referrers and Popular Paths are 14-day snapshots:** These endpoints return cumulative data for the last 14 days, not daily breakdowns. We store one snapshot per day and replace it on re-runs to avoid duplicates.

4. **All-time unique counts are unavailable:** Because daily uniques can't be summed to get period uniques (double-counting), all-time unique visitor counts are not reported. Instead, we show the 14-day API figure which is accurately deduplicated by GitHub.

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/opena2a-org/github-analytics-tracker.git
cd github-analytics-tracker
npm install
```

### 2. Create GitHub Token

1. Go to https://github.com/settings/tokens/new
2. Generate a **Personal Access Token** with `repo` scope (or `public_repo` for public repos only)
3. Copy the token

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
GITHUB_TOKEN=ghp_your_token_here
GITHUB_ORG=opena2a-org
```

The `GITHUB_ORG` setting auto-discovers all public, non-archived, non-fork repos in the org. You can optionally add `REPOS_TO_TRACK=owner/repo1,owner/repo2` to track additional repos outside the org.

### 4. Run

```bash
npm run setup-db    # Create database tables
npm run collect     # Fetch data from GitHub API
npm run generate-md # Generate markdown reports
npm run dev         # Start the dashboard at http://localhost:3000
```

## Automated Collection (GitHub Actions)

The included workflow (`.github/workflows/collect-stats.yml`) runs daily at 12:00 PM UTC.

**Setup:**
1. Go to repo **Settings** > **Secrets and variables** > **Actions**
2. Add secret: `GH_STATS_TOKEN` - your GitHub Personal Access Token

The workflow auto-discovers all public repos in `opena2a-org` via the API. No manual repo list maintenance needed. When new repos are created in the org, they're automatically picked up on the next run.

## Database Schema

SQLite database (`data/analytics.db`):

| Table | Purpose |
|-------|---------|
| `repositories` | Tracked repositories |
| `traffic_views` | Daily view counts (completed days only) |
| `traffic_clones` | Daily clone counts (completed days only) |
| `traffic_summary` | 14-day API summary with deduplicated uniques |
| `referrers` | Traffic source snapshots (one per day) |
| `popular_paths` | Most visited content snapshots (one per day) |
| `stargazers` | Star count history |
| `forks` | Fork count history |

## API Endpoints

### GET /api/repos

Returns list of tracked repositories.

### GET /api/stats?repo_id=1&days=30

Returns statistics for a repository.

**Parameters:**
- `repo_id` (required) - Repository ID
- `days` (optional) - Time range: 7, 14, 30, 90, 365, or "all"

**Response:**
```json
{
  "summary": {
    "totalViews": 1523,
    "totalClones": 45,
    "recentUniqueVisitors": 89,
    "recentUniqueCloners": 23,
    "latestStars": 32,
    "starsGrowth": 5,
    "latestForks": 10,
    "forksGrowth": 2
  },
  "views": [{ "date": "2026-02-01", "count": 52, "uniques": 31 }],
  "clones": [],
  "referrers": [],
  "paths": []
}
```

## Maintenance

### Backup Database

```bash
cp data/analytics.db data/analytics-backup-$(date +%Y%m%d).db
```

### Query Database

```bash
sqlite3 data/analytics.db
```

```sql
SELECT * FROM repositories;
SELECT date, count, uniques FROM traffic_views WHERE repo_id = 1 ORDER BY date DESC LIMIT 30;
SELECT views_count, views_uniques FROM traffic_summary WHERE repo_id = 1 ORDER BY date DESC LIMIT 1;
```

### Clean Old Referrer/Path Snapshots

```sql
DELETE FROM referrers WHERE date < date('now', '-90 days');
DELETE FROM popular_paths WHERE date < date('now', '-90 days');
```

## FAQ

**How far back can I see data?**
As far back as when you started collecting. The first run captures up to 14 days (GitHub's limit), then each subsequent run adds new data.

**What if I miss a day of collection?**
GitHub keeps 14 days, so you have a 2-week buffer. Run the collector again to backfill.

**Can I track repos outside the org?**
Yes, add them to `REPOS_TO_TRACK` in addition to `GITHUB_ORG`.

**How much storage does it use?**
Very little. 1 year of daily data for 20 repos is approximately 10-20 MB.

**Why aren't all-time unique visitor counts shown?**
Because daily unique counts can't be accurately summed across days (a visitor on 5 different days would be counted 5 times). The 14-day API figure is the most accurate unique count available.

## License

MIT

---

Built by [OpenA2A](https://opena2a.org)
