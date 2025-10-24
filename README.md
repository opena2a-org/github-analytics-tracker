# 📊 GitHub Analytics Tracker

> Preserve your GitHub repository analytics beyond the 14-day retention limit.

Track and visualize repository traffic, clones, stars, forks, referrers, and popular content with historical data storage and a beautiful dashboard.

## 🎯 Features

- **📈 Historical Data** - Store unlimited history (GitHub only keeps 14 days)
- **📊 Beautiful Dashboard** - Interactive charts and statistics
- **🔄 Automated Collection** - Daily cron job to collect stats automatically
- **🎯 Multi-Repo Support** - Track unlimited repositories
- **💾 SQLite Database** - Lightweight, no external database required
- **📱 Responsive UI** - Works on desktop and mobile
- **🔒 Secure** - No data leaves your control

## 📦 What Gets Tracked

| Metric | Description | GitHub Retention |
|--------|-------------|------------------|
| **Views** | Total and unique page views | 14 days |
| **Clones** | Total and unique git clones | 14 days |
| **Referrers** | Where your traffic comes from | 14 days |
| **Popular Paths** | Most visited files/pages | 14 days |
| **Stars** | Star count over time | No history |
| **Forks** | Fork count over time | No history |

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/opena2a-org/github-analytics-tracker.git
cd github-analytics-tracker
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create GitHub Token

1. Go to https://github.com/settings/tokens/new
2. Generate a new **Personal Access Token** with these scopes:
   - `repo` (for private repos)
   - OR `public_repo` (for public repos only)
3. Copy the token (starts with `ghp_`)

### 4. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and add your token and repositories:

```bash
GITHUB_TOKEN=ghp_your_token_here
REPOS_TO_TRACK=opena2a-org/agent-identity-management,opena2a-org/opena2a-website
```

### 5. Setup Database

```bash
npm run setup-db
```

This creates `data/analytics.db` with all required tables.

### 6. Collect Initial Data

```bash
npm run collect
```

This fetches the latest 14 days of data from GitHub and stores it locally.

### 7. Start the Dashboard

```bash
npm run dev
```

Open http://localhost:3000 to view your analytics! 🎉

## 📅 Automated Daily Collection

### Option 1: Cron Job (Linux/Mac)

```bash
# Edit crontab
crontab -e

# Add this line to run daily at 2 AM
0 2 * * * cd /path/to/github-analytics-tracker && /usr/local/bin/node scripts/collect-stats.js >> logs/collector.log 2>&1
```

### Option 2: GitHub Actions (Recommended)

Create `.github/workflows/collect-stats.yml`:

```yaml
name: Collect GitHub Stats

on:
  schedule:
    # Run daily at 02:00 UTC
    - cron: '0 2 * * *'
  workflow_dispatch:  # Allow manual trigger

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Setup database
        run: npm run setup-db

      - name: Collect stats
        env:
          GITHUB_TOKEN: ${{ secrets.GH_STATS_TOKEN }}
          REPOS_TO_TRACK: ${{ vars.REPOS_TO_TRACK }}
        run: npm run collect

      - name: Commit and push
        run: |
          git config user.name "GitHub Actions Bot"
          git config user.email "actions@github.com"
          git add data/analytics.db
          git commit -m "chore: update analytics data [skip ci]" || echo "No changes"
          git push
```

**Setup GitHub Actions:**
1. Go to repo **Settings** → **Secrets and variables** → **Actions**
2. Add secret: `GH_STATS_TOKEN` (your GitHub token)
3. Add variable: `REPOS_TO_TRACK` (your repos list)

### Option 3: System Service (systemd)

Create `/etc/systemd/system/github-analytics.service`:

```ini
[Unit]
Description=GitHub Analytics Collector
After=network.target

[Service]
Type=oneshot
User=your-user
WorkingDirectory=/path/to/github-analytics-tracker
ExecStart=/usr/bin/node scripts/collect-stats.js
```

Create timer `/etc/systemd/system/github-analytics.timer`:

```ini
[Unit]
Description=Run GitHub Analytics Collector Daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:
```bash
sudo systemctl enable github-analytics.timer
sudo systemctl start github-analytics.timer
```

## 📊 Dashboard Features

### Repository Selector
- Switch between tracked repositories
- View stats for each repo independently

### Time Range Filters
- Last 7 days
- Last 14 days (GitHub's retention)
- Last 30 days
- Last 90 days
- Last year
- All time (complete history)

### Metrics Displayed
1. **Summary Cards**
   - Total views (with unique visitors)
   - Total clones (with unique cloners)
   - Current stars (with growth)
   - Current forks (with growth)

2. **Interactive Charts**
   - Views over time (line chart)
   - Clones over time (line chart)

3. **Top Lists**
   - Top 10 referrers (where traffic comes from)
   - Top 10 popular paths (most viewed files/pages)

## 🗄️ Database Schema

The SQLite database includes these tables:

- `repositories` - Tracked repositories
- `traffic_views` - Daily view counts
- `traffic_clones` - Daily clone counts
- `referrers` - Traffic sources
- `popular_paths` - Most visited content
- `stargazers` - Star count history
- `forks` - Fork count history

All data is stored locally in `data/analytics.db`.

## 🔧 Maintenance

### Backup Database

```bash
cp data/analytics.db data/analytics-backup-$(date +%Y%m%d).db
```

### View Database

```bash
sqlite3 data/analytics.db
```

```sql
-- Example queries
SELECT * FROM repositories;
SELECT date, count, uniques FROM traffic_views WHERE repo_id = 1 ORDER BY date DESC LIMIT 30;
SELECT SUM(count) as total_views FROM traffic_views WHERE repo_id = 1;
```

### Clean Old Referrer Data

Referrers and popular paths accumulate over time. Clean old entries:

```sql
DELETE FROM referrers WHERE date < date('now', '-90 days');
DELETE FROM popular_paths WHERE date < date('now', '-90 days');
```

## 🚢 Deployment

### Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Add environment variables in Vercel dashboard:
- `GITHUB_TOKEN`
- `REPOS_TO_TRACK`

### Deploy to Railway

```bash
railway login
railway init
railway up
```

### Deploy with Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run setup-db
CMD ["npm", "start"]
EXPOSE 3000
```

## 📝 API Endpoints

The dashboard uses these API routes:

### GET /api/repos
Get list of tracked repositories.

**Response:**
```json
[
  {
    "id": 1,
    "owner": "opena2a-org",
    "repo": "agent-identity-management",
    "full_name": "opena2a-org/agent-identity-management"
  }
]
```

### GET /api/stats?repo_id=1&days=30
Get statistics for a repository.

**Parameters:**
- `repo_id` (required) - Repository ID
- `days` (optional) - Time range (7, 14, 30, 90, 365, or "all")

**Response:**
```json
{
  "summary": {
    "total_views": 1523,
    "unique_views": 892,
    "total_clones": 45,
    "unique_clones": 23,
    "latest_stars": 156,
    "stars_growth": 12,
    "latest_forks": 34,
    "forks_growth": 3
  },
  "views": [
    { "date": "2025-01-01", "count": 52, "uniques": 31 }
  ],
  "clones": [...],
  "referrers": [...],
  "paths": [...]
}
```

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

MIT License - feel free to use this for your projects!

## 🙋 FAQ

### Q: How far back can I see data?
**A:** As far back as when you started collecting! The first run captures 14 days (GitHub's limit), then each subsequent run adds new data.

### Q: Can I track private repositories?
**A:** Yes, use a token with `repo` scope instead of `public_repo`.

### Q: How much storage does it use?
**A:** Very little. 1 year of daily data for 10 repos ≈ 5-10 MB.

### Q: What if I miss a day of collection?
**A:** GitHub keeps 14 days, so you have a 2-week buffer. Just run the collector again.

### Q: Can I export the data?
**A:** Yes, the SQLite database can be queried directly or exported to CSV/JSON.

## 🔗 Links

- [GitHub API Documentation](https://docs.github.com/en/rest/metrics/traffic)
- [SQLite Documentation](https://www.sqlite.org/docs.html)
- [Next.js Documentation](https://nextjs.org/docs)
- [Recharts Documentation](https://recharts.org/)

## 💡 Tips

1. **Run collection immediately after setup** to capture the available 14 days
2. **Set up automated collection within 14 days** to avoid data gaps
3. **Backup your database regularly** - it's your only copy of historical data
4. **Monitor token rate limits** - GitHub allows 5,000 requests/hour with auth

---

Built with ❤️ by [OpenA2A](https://opena2a.org)

**Need help?** Open an issue on GitHub!
