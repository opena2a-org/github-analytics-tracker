const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath, { readonly: true });

const today = new Date().toISOString().split('T')[0];

function formatDate(dateString) {
  const date = new Date(dateString + 'T00:00:00Z');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function getRepositoryStats() {
  const repos = db.prepare('SELECT * FROM repositories ORDER BY full_name').all();

  return repos.map(repo => {
    // All-time totals from daily data (sum of daily counts).
    // Note: SUM(uniques) is an upper bound - a visitor on multiple days
    // is counted once per day, so the true unique count is lower.
    const views = db.prepare(`
      SELECT
        COALESCE(SUM(count), 0) as total_views,
        COALESCE(SUM(uniques), 0) as daily_unique_sum,
        COUNT(DISTINCT date) as days_tracked,
        MIN(date) as first_date,
        MAX(date) as last_date
      FROM traffic_views
      WHERE repo_id = ?
    `).get(repo.id);

    const clones = db.prepare(`
      SELECT
        COALESCE(SUM(count), 0) as total_clones,
        COALESCE(SUM(uniques), 0) as daily_unique_sum
      FROM traffic_clones
      WHERE repo_id = ?
    `).get(repo.id);

    // Most recent 14-day API summary - has properly deduplicated uniques
    const recentSummary = db.prepare(`
      SELECT views_count, views_uniques, clones_count, clones_uniques
      FROM traffic_summary
      WHERE repo_id = ?
      ORDER BY date DESC
      LIMIT 1
    `).get(repo.id);

    // Get latest stars and forks
    const stars = db.prepare(`
      SELECT COALESCE(total_stars, 0) as stars
      FROM stargazers
      WHERE repo_id = ?
      ORDER BY date DESC
      LIMIT 1
    `).get(repo.id);

    const forks = db.prepare(`
      SELECT COALESCE(total_forks, 0) as forks
      FROM forks
      WHERE repo_id = ?
      ORDER BY date DESC
      LIMIT 1
    `).get(repo.id);

    // Get daily breakdown for detailed report
    const dailyStats = db.prepare(`
      SELECT
        COALESCE(v.date, c.date) as date,
        COALESCE(v.count, 0) as views,
        COALESCE(v.uniques, 0) as unique_visitors,
        COALESCE(c.count, 0) as clones,
        COALESCE(c.uniques, 0) as unique_cloners
      FROM
        (SELECT date, count, uniques FROM traffic_views WHERE repo_id = ?) v
      FULL OUTER JOIN
        (SELECT date, count, uniques FROM traffic_clones WHERE repo_id = ?) c
      ON v.date = c.date
      ORDER BY date DESC
    `).all(repo.id, repo.id);

    // Get most recent referrers (latest snapshot)
    const latestReferrerDate = db.prepare(`
      SELECT MAX(date) as date FROM referrers WHERE repo_id = ?
    `).get(repo.id);

    const referrers = latestReferrerDate?.date ? db.prepare(`
      SELECT referrer, count, uniques
      FROM referrers
      WHERE repo_id = ? AND date = ?
      ORDER BY count DESC
    `).all(repo.id, latestReferrerDate.date) : [];

    return {
      ...repo,
      total_views: views.total_views,
      total_clones: clones.total_clones,
      days_tracked: views.days_tracked,
      first_date: views.first_date,
      last_date: views.last_date,
      // 14-day API uniques (properly deduplicated)
      recent_unique_visitors: recentSummary?.views_uniques || 0,
      recent_unique_cloners: recentSummary?.clones_uniques || 0,
      recent_views: recentSummary?.views_count || 0,
      recent_clones: recentSummary?.clones_count || 0,
      stars: stars?.stars || 0,
      forks: forks?.forks || 0,
      dailyStats,
      referrers,
    };
  });
}

function generateAnalyticsMD(repoStats) {
  if (repoStats.length === 0) {
    return '# GitHub Analytics Dashboard\n\nNo data available yet.\n';
  }

  // Sort by total views descending for the summary
  const sorted = [...repoStats].sort((a, b) => b.total_views - a.total_views);
  const topRepo = sorted[0];

  const totalViews = repoStats.reduce((sum, r) => sum + r.total_views, 0);
  const totalClones = repoStats.reduce((sum, r) => sum + r.total_clones, 0);
  const totalStars = repoStats.reduce((sum, r) => sum + r.stars, 0);

  let md = `# GitHub Analytics Dashboard

> **Last Updated:** ${formatDate(today)}
> [View Detailed Daily Report](./ANALYTICS_DETAILED.md)

## Repository Overview

| Repository | All-Time Views | All-Time Clones | Last 14d Unique Visitors | Stars | Forks | Days Tracked |
|------------|---------------|-----------------|-------------------------|-------|-------|-------------|
`;

  sorted.forEach(repo => {
    const name = repo.full_name;
    const url = `https://github.com/${name}`;
    md += `| [${name}](${url}) | ${formatNumber(repo.total_views)} | ${formatNumber(repo.total_clones)} | ${formatNumber(repo.recent_unique_visitors)} | ${repo.stars} | ${repo.forks} | ${repo.days_tracked} |\n`;
  });

  md += `
---

## Aggregate Totals

| Metric | Value |
|--------|-------|
| Repositories tracked | ${repoStats.length} |
| All-time page views | ${formatNumber(totalViews)} |
| All-time clones | ${formatNumber(totalClones)} |
| Total stars | ${formatNumber(totalStars)} |

## Top Repository: ${topRepo.full_name}

- **${formatNumber(topRepo.total_views)} all-time views** across ${topRepo.days_tracked} days of tracking
- **${formatNumber(topRepo.total_clones)} all-time clones**
- **${formatNumber(topRepo.recent_unique_visitors)} unique visitors** in the last 14 days (GitHub API deduplicated)
${topRepo.stars > 0 ? `- ${topRepo.stars} stars` : ''}

---

## Understanding the Metrics

| Metric | Description |
|--------|-------------|
| **All-Time Views** | Sum of daily page view counts since tracking began |
| **All-Time Clones** | Sum of daily git clone counts since tracking began |
| **Last 14d Unique Visitors** | Deduplicated unique visitor count from GitHub API (accurate, not summed) |
| **Stars** | Current star count snapshot |
| **Forks** | Current fork count snapshot |

> **Note on unique counts:** GitHub's traffic API provides a 14-day rolling window with properly
> deduplicated unique visitor/cloner counts. These are the most accurate unique metrics available.
> All-time unique counts cannot be accurately computed from daily data (a visitor on multiple days
> would be counted once per day), so we report the 14-day API figure instead.

---

## Data Collection

- **Method:** GitHub Actions (automated daily)
- **Schedule:** 12:00 PM UTC
- **Scope:** All public repos in the opena2a-org organization (auto-discovered)
- **Retention:** Unlimited (GitHub only keeps 14 days)

---

*Generated by [GitHub Analytics Tracker](https://github.com/opena2a-org/github-analytics-tracker)*
`;

  return md;
}

function generateDetailedMD(repoStats) {
  if (repoStats.length === 0) {
    return '# GitHub Analytics - Detailed Daily Report\n\nNo data available yet.\n';
  }

  // Get date range across all repos
  const allDates = repoStats.flatMap(r => r.dailyStats.map(d => d.date)).filter(Boolean);
  const minDate = allDates.length > 0 ? allDates[allDates.length - 1] : today;
  const maxDate = allDates.length > 0 ? allDates[0] : today;

  let md = `# GitHub Analytics - Detailed Daily Report

> **Last Updated:** ${formatDate(today)}
> **Tracking Period:** ${formatDate(minDate)} - ${formatDate(maxDate)}

---

`;

  // Sort repos by total views descending
  const sorted = [...repoStats].sort((a, b) => b.total_views - a.total_views);

  sorted.forEach(repo => {
    md += `## ${repo.full_name}

**Summary** (${repo.days_tracked} days tracked)

| Metric | All-Time Total | Last 14 Days (API) |
|--------|---------------|-------------------|
| Views | ${formatNumber(repo.total_views)} | ${formatNumber(repo.recent_views)} |
| Unique Visitors | -- | ${formatNumber(repo.recent_unique_visitors)} |
| Clones | ${formatNumber(repo.total_clones)} | ${formatNumber(repo.recent_clones)} |
| Unique Cloners | -- | ${formatNumber(repo.recent_unique_cloners)} |
| Stars | ${repo.stars} | -- |
| Forks | ${repo.forks} | -- |

`;

    // Add referrer info if available
    if (repo.referrers.length > 0) {
      md += `**Top Referrers** (last 14 days)\n\n`;
      md += `| Source | Views | Unique Visitors |\n`;
      md += `|--------|-------|----------------|\n`;
      repo.referrers.forEach(ref => {
        md += `| ${ref.referrer} | ${ref.count} | ${ref.uniques} |\n`;
      });
      md += '\n';
    }

    // Daily breakdown (last 30 days max to keep the file manageable)
    const recentDays = repo.dailyStats.slice(0, 30);
    if (recentDays.length > 0) {
      md += `**Daily Breakdown** (last ${recentDays.length} days)\n\n`;
      md += `| Date | Views | Unique Visitors | Clones | Unique Cloners |\n`;
      md += `|------|-------|-----------------|--------|----------------|\n`;

      recentDays.forEach(day => {
        md += `| ${formatDate(day.date)} | ${day.views} | ${day.unique_visitors} | ${day.clones} | ${day.unique_cloners} |\n`;
      });

      if (repo.dailyStats.length > 30) {
        md += `\n*Showing last 30 days. Full history available in the database (${repo.dailyStats.length} days total).*\n`;
      }
    }

    // Per-repo insights
    if (recentDays.length > 1) {
      const avgViews = Math.round(recentDays.reduce((sum, d) => sum + d.views, 0) / recentDays.length);
      const avgClones = Math.round(recentDays.reduce((sum, d) => sum + d.clones, 0) / recentDays.length);
      const peakDay = recentDays.reduce((max, d) => d.views > max.views ? d : max, recentDays[0]);

      md += `\n**Insights**\n`;
      md += `- Average: ~${avgViews} views/day, ~${avgClones} clones/day (last ${recentDays.length} days)\n`;
      if (peakDay.views > avgViews * 2 && peakDay.views > 10) {
        md += `- Peak traffic: ${formatDate(peakDay.date)} with ${peakDay.views} views\n`;
      }
    }

    md += `\n---\n\n`;
  });

  // Cross-repo comparison
  if (sorted.length > 1) {
    md += `## Cross-Repository Comparison

| Repository | All-Time Views | All-Time Clones | 14d Unique Visitors | Stars |
|------------|---------------|-----------------|--------------------|----|
`;
    sorted.forEach(repo => {
      md += `| ${repo.repo} | ${formatNumber(repo.total_views)} | ${formatNumber(repo.total_clones)} | ${formatNumber(repo.recent_unique_visitors)} | ${repo.stars} |\n`;
    });

    md += `\n---\n\n`;
  }

  md += `## Data Collection

- **Method:** GitHub Actions (automated daily)
- **Schedule:** 12:00 PM UTC
- **Scope:** All public repos in opena2a-org (auto-discovered)
- **Retention:** Unlimited (GitHub only keeps 14 days)
- **Note:** "Last 14 Days" figures use GitHub's API summary which properly deduplicates unique visitors.
  All-time unique counts are not reported because summing daily uniques would overcount
  (a visitor on 5 different days would be counted 5 times).

---

*Generated by [GitHub Analytics Tracker](https://github.com/opena2a-org/github-analytics-tracker)*
`;

  return md;
}

function generateBadgeJSON(repo) {
  return {
    schemaVersion: 1,
    label: "clones",
    message: String(repo.total_clones),
    color: "blue",
    namedLogo: "github",
    style: "social"
  };
}

function generateStatsJSON(repo) {
  return {
    lastUpdated: new Date().toISOString(),
    repository: repo.full_name,
    stats: {
      allTime: {
        views: repo.total_views,
        clones: repo.total_clones
      },
      recent14Days: {
        views: repo.recent_views,
        viewsUnique: repo.recent_unique_visitors,
        clones: repo.recent_clones,
        clonesUnique: repo.recent_unique_cloners
      },
      stars: repo.stars,
      forks: repo.forks
    }
  };
}

function getNpmStats() {
  // Check if npm tables exist
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='npm_packages'"
  ).get();
  if (!tableCheck) return [];

  const packages = db.prepare('SELECT * FROM npm_packages ORDER BY name').all();

  return packages.map(pkg => {
    const allTime = db.prepare(`
      SELECT
        COALESCE(SUM(downloads), 0) as total_downloads,
        COUNT(DISTINCT date) as days_tracked,
        MIN(date) as first_date,
        MAX(date) as last_date
      FROM npm_downloads
      WHERE package_id = ?
    `).get(pkg.id);

    const last7 = db.prepare(`
      SELECT COALESCE(SUM(downloads), 0) as downloads
      FROM npm_downloads
      WHERE package_id = ? AND date >= date('now', '-7 days')
    `).get(pkg.id);

    const last30 = db.prepare(`
      SELECT COALESCE(SUM(downloads), 0) as downloads
      FROM npm_downloads
      WHERE package_id = ? AND date >= date('now', '-30 days')
    `).get(pkg.id);

    const last90 = db.prepare(`
      SELECT COALESCE(SUM(downloads), 0) as downloads
      FROM npm_downloads
      WHERE package_id = ? AND date >= date('now', '-90 days')
    `).get(pkg.id);

    // Daily data for charts (last 30 days)
    const dailyDownloads = db.prepare(`
      SELECT date, downloads
      FROM npm_downloads
      WHERE package_id = ? AND date >= date('now', '-30 days')
      ORDER BY date DESC
    `).all(pkg.id);

    return {
      ...pkg,
      total_downloads: allTime.total_downloads,
      days_tracked: allTime.days_tracked,
      first_date: allTime.first_date,
      last_date: allTime.last_date,
      last7_downloads: last7.downloads,
      last30_downloads: last30.downloads,
      last90_downloads: last90.downloads,
      dailyDownloads,
    };
  });
}

function generateNpmSection(npmStats) {
  if (npmStats.length === 0) return '';

  const sorted = [...npmStats].sort((a, b) => b.total_downloads - a.total_downloads);
  const totalDownloads = npmStats.reduce((sum, p) => sum + p.total_downloads, 0);
  const total30d = npmStats.reduce((sum, p) => sum + p.last30_downloads, 0);

  let md = `
---

## npm Package Downloads

| Package | Version | Last 7d | Last 30d | Last 90d | All-Time | Days Tracked |
|---------|---------|---------|----------|----------|----------|-------------|
`;

  sorted.forEach(pkg => {
    const npmUrl = `https://www.npmjs.com/package/${pkg.name}`;
    md += `| [${pkg.name}](${npmUrl}) | ${pkg.version} | ${formatNumber(pkg.last7_downloads)} | ${formatNumber(pkg.last30_downloads)} | ${formatNumber(pkg.last90_downloads)} | ${formatNumber(pkg.total_downloads)} | ${pkg.days_tracked} |\n`;
  });

  md += `
### npm Totals

| Metric | Value |
|--------|-------|
| Packages tracked | ${npmStats.length} |
| All-time downloads | ${formatNumber(totalDownloads)} |
| Last 30 days | ${formatNumber(total30d)} |

`;

  return md;
}

function generateNpmDetailedSection(npmStats) {
  if (npmStats.length === 0) return '';

  const sorted = [...npmStats].sort((a, b) => b.total_downloads - a.total_downloads);

  let md = `## npm Package Details\n\n`;

  sorted.forEach(pkg => {
    md += `### ${pkg.name} v${pkg.version}\n\n`;
    if (pkg.description) {
      md += `> ${pkg.description}\n\n`;
    }

    md += `| Period | Downloads |\n`;
    md += `|--------|-----------|\n`;
    md += `| Last 7 days | ${formatNumber(pkg.last7_downloads)} |\n`;
    md += `| Last 30 days | ${formatNumber(pkg.last30_downloads)} |\n`;
    md += `| Last 90 days | ${formatNumber(pkg.last90_downloads)} |\n`;
    md += `| All time | ${formatNumber(pkg.total_downloads)} |\n\n`;

    if (pkg.dailyDownloads.length > 0) {
      const avg = Math.round(pkg.dailyDownloads.reduce((s, d) => s + d.downloads, 0) / pkg.dailyDownloads.length);
      const peak = pkg.dailyDownloads.reduce((max, d) => d.downloads > max.downloads ? d : max, pkg.dailyDownloads[0]);

      md += `**Insights**\n`;
      md += `- Average: ~${formatNumber(avg)} downloads/day (last ${pkg.dailyDownloads.length} days)\n`;
      if (peak.downloads > avg * 2 && peak.downloads > 10) {
        md += `- Peak: ${formatDate(peak.date)} with ${formatNumber(peak.downloads)} downloads\n`;
      }
      md += '\n';
    }

    md += `---\n\n`;
  });

  return md;
}

function main() {
  console.log('Generating markdown and JSON files from database...');

  try {
    const repoStats = getRepositoryStats();
    const npmStats = getNpmStats();

    if (repoStats.length === 0 && npmStats.length === 0) {
      console.log('No data found in database');
      process.exit(0);
    }

    // Generate ANALYTICS.md (with npm section appended)
    let analyticsMD = repoStats.length > 0
      ? generateAnalyticsMD(repoStats)
      : '# Analytics Dashboard\n\n';
    analyticsMD += generateNpmSection(npmStats);
    const analyticsPath = path.join(__dirname, '..', 'ANALYTICS.md');
    fs.writeFileSync(analyticsPath, analyticsMD);
    console.log('Generated ANALYTICS.md (%d repos, %d npm packages)', repoStats.length, npmStats.length);

    // Generate ANALYTICS_DETAILED.md (with npm details appended)
    let detailedMD = repoStats.length > 0
      ? generateDetailedMD(repoStats)
      : '# Analytics - Detailed Report\n\n';
    detailedMD += generateNpmDetailedSection(npmStats);
    const detailedPath = path.join(__dirname, '..', 'ANALYTICS_DETAILED.md');
    fs.writeFileSync(detailedPath, detailedMD);
    console.log('Generated ANALYTICS_DETAILED.md');

    // Generate badge and stats JSON files for each repo
    const dataDir = path.join(__dirname, '..', 'data');
    repoStats.forEach(repo => {
      const safeName = repo.full_name.replace('/', '_');

      const badgePath = path.join(dataDir, `badge-${safeName}.json`);
      fs.writeFileSync(badgePath, JSON.stringify(generateBadgeJSON(repo), null, 2));

      const statsPath = path.join(dataDir, `stats-${safeName}.json`);
      fs.writeFileSync(statsPath, JSON.stringify(generateStatsJSON(repo), null, 2));
    });

    console.log('Generated %d badge + stats JSON files', repoStats.length);
    console.log('Done.');
  } catch (error) {
    console.error('Error generating files: %s', error.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
