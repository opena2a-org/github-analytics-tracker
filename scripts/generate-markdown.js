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

function getRepositoryStats() {
  const repos = db.prepare('SELECT * FROM repositories ORDER BY id').all();

  return repos.map(repo => {
    // Get total views and unique visitors
    const views = db.prepare(`
      SELECT
        COALESCE(SUM(count), 0) as total_views,
        COALESCE(SUM(uniques), 0) as unique_visitors,
        COUNT(DISTINCT date) as days_tracked
      FROM traffic_views
      WHERE repo_id = ?
    `).get(repo.id);

    // Get total clones
    const clones = db.prepare(`
      SELECT
        COALESCE(SUM(count), 0) as total_clones,
        COALESCE(SUM(uniques), 0) as unique_cloners
      FROM traffic_clones
      WHERE repo_id = ?
    `).get(repo.id);

    // Get latest stars and forks
    const starsForks = db.prepare(`
      SELECT
        COALESCE(MAX(s.total_stars), 0) as stars,
        COALESCE(MAX(f.total_forks), 0) as forks
      FROM repositories r
      LEFT JOIN stargazers s ON r.id = s.repo_id
      LEFT JOIN forks f ON r.id = f.repo_id
      WHERE r.id = ?
    `).get(repo.id);

    // Get daily breakdown
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

    return {
      ...repo,
      ...views,
      ...clones,
      ...starsForks,
      dailyStats
    };
  });
}

function generateAnalyticsMD(repoStats) {
  const totalViews = repoStats.reduce((sum, r) => sum + r.total_views, 0);
  const totalUniques = repoStats.reduce((sum, r) => sum + r.unique_visitors, 0);
  const totalClones = repoStats.reduce((sum, r) => sum + r.total_clones, 0);
  const totalUniqueCloners = repoStats.reduce((sum, r) => sum + r.unique_cloners, 0);

  // Find top performer
  const topRepo = repoStats.reduce((max, r) => r.total_views > max.total_views ? r : max, repoStats[0]);

  let md = `# 📊 GitHub Analytics Dashboard

> **Last Updated:** ${formatDate(today)}
> 📋 **[View Detailed Daily Report →](./ANALYTICS_DETAILED.md)**

## 📈 Repository Statistics

| Repository | Total Views | Unique Visitors | Total Clones | Unique Cloners | ⭐ Stars | 🔱 Forks | Days Tracked |
|------------|-------------|-----------------|--------------|----------------|----------|----------|--------------|
`;

  repoStats.forEach((repo, index) => {
    const name = repo.full_name;
    const url = `https://github.com/${name}`;
    const bold = index === 0 ? '**' : '';
    md += `| [${name}](${url}) | ${bold}${repo.total_views}${bold} | ${bold}${repo.unique_visitors}${bold} | ${bold}${repo.total_clones}${bold} | ${bold}${repo.unique_cloners}${bold} | ${repo.stars} | ${repo.forks} | ${repo.days_tracked} days |\n`;
  });

  md += `
---

## 🎯 Key Insights

### 🏆 Top Performer: ${topRepo.repo}
- **${topRepo.total_views} total views** with **${topRepo.unique_visitors} unique visitors** (${topRepo.days_tracked} days of data)
- **${topRepo.total_clones} total clones** from **${topRepo.unique_cloners} unique developers**
- Strong developer interest with consistent engagement
${topRepo.stars > 0 ? `- ${topRepo.stars} stars showing growing community engagement` : ''}

### 📊 Traffic Summary
- **Total Views Across All Repos:** ${totalViews}
- **Total Unique Visitors:** ${totalUniques}
- **Total Clones:** ${totalClones}
- **Total Unique Cloners:** ${totalUniqueCloners}

---

## 📅 Data Collection

- **Collection Method:** GitHub Actions (automated daily)
- **Collection Time:** 12:00 PM UTC (7am EST / 4am PST)
- **Data Retention:** Unlimited (GitHub only keeps 14 days)
- **Next Collection:** Automatic at next scheduled time

---

## 🔄 How This Works

This analytics dashboard is automatically updated daily by GitHub Actions. The workflow:

1. ✅ Collects traffic stats from GitHub API
2. ✅ Stores data in SQLite database (\`data/analytics.db\`)
3. ✅ Updates this summary file
4. ✅ Commits changes back to repository

**View detailed analytics:** Run \`npm run dev\` and visit http://localhost:3000

---

## 📖 Understanding the Metrics

| Metric | Description |
|--------|-------------|
| **Total Views** | All page views including repeat visits |
| **Unique Visitors** | Number of distinct users who viewed the repo |
| **Total Clones** | All git clone operations including duplicates |
| **Unique Cloners** | Number of distinct users who cloned the repo |
| **Stars** | Current star count (GitHub doesn't provide history) |
| **Forks** | Current fork count (GitHub doesn't provide history) |

---

*Generated automatically by [GitHub Analytics Tracker](https://github.com/opena2a-org/github-analytics-tracker)*
`;

  return md;
}

function generateDetailedMD(repoStats) {
  if (repoStats.length === 0) {
    return '# 📊 GitHub Analytics - Detailed Daily Report\n\nNo data available yet.';
  }

  // Get date range
  const allDates = repoStats.flatMap(r => r.dailyStats.map(d => d.date));
  const minDate = allDates.length > 0 ? allDates[allDates.length - 1] : today;
  const maxDate = allDates.length > 0 ? allDates[0] : today;

  let md = `# 📊 GitHub Analytics - Detailed Daily Report

> **Last Updated:** ${formatDate(today)}
> **Tracking Period:** ${formatDate(minDate)} - ${formatDate(maxDate)}

---

`;

  // Generate section for each repository
  repoStats.forEach(repo => {
    md += `## 📈 ${repo.full_name}

### Summary (${repo.days_tracked} days)
- **Total Views:** ${repo.total_views}
- **Unique Visitors:** ${repo.unique_visitors}
- **Total Clones:** ${repo.total_clones}
- **Unique Cloners:** ${repo.unique_cloners}
- **⭐ Stars:** ${repo.stars}

### Daily Breakdown

| Date | Views | Unique Visitors | Clones | Unique Cloners | Notes |
|------|-------|-----------------|--------|----------------|-------|
`;

    // Add daily stats
    repo.dailyStats.forEach((day, index) => {
      const date = formatDate(day.date);
      const isToday = day.date === today;
      const isHighViews = day.views > 150;
      const isHighClones = day.clones > 20;
      const isFirstDay = index === repo.dailyStats.length - 1;

      let notes = '';
      if (isToday) notes = '📊 Current day';
      else if (isFirstDay) notes = '🎉 Launch day!';
      else if (isHighViews && isHighClones) notes = '🚀 Peak activity';
      else if (isHighViews) notes = '🔥 Peak traffic day';
      else if (isHighClones) notes = '🔥 High clone activity';

      md += `| **${date}** | ${day.views} | ${day.unique_visitors} | ${day.clones} | ${day.unique_cloners} | ${notes} |\n`;
    });

    // Add insights for this repo
    md += `\n### Key Insights\n`;

    if (repo.dailyStats.length > 0) {
      const firstDay = repo.dailyStats[repo.dailyStats.length - 1];
      const recentDays = repo.dailyStats.slice(0, 7);
      const avgRecent = Math.round(recentDays.reduce((sum, d) => sum + d.views, 0) / recentDays.length);

      if (firstDay.views > 100 || firstDay.clones > 10) {
        md += `- **🎉 Launch Day (${formatDate(firstDay.date)}):** Strong start with **${firstDay.views} views** and **${firstDay.clones} clones**\n`;
      }
      md += `- **📊 Recent Average:** Around **${avgRecent} views/day** over last ${recentDays.length} days\n`;
      if (repo.unique_cloners > 50) {
        md += `- **👥 Strong Developer Interest:** **${repo.unique_cloners} unique cloners** shows active usage\n`;
      }
    }

    md += `\n---\n\n`;
  });

  // Add cross-repository analysis if multiple repos
  if (repoStats.length > 1) {
    md += `## 📊 Cross-Repository Analysis

### Traffic Summary

| Repository | Total Views | Total Clones | Unique Visitors | Developer Interest |
|------------|-------------|--------------|-----------------|-------------------|
`;

    repoStats.forEach(repo => {
      const interest = repo.unique_cloners > 50 ? '⭐⭐⭐⭐⭐ Very High' :
                       repo.unique_cloners > 20 ? '⭐⭐⭐⭐ High' :
                       repo.unique_cloners > 5 ? '⭐⭐⭐ Medium' :
                       '⭐⭐ Low';
      md += `| ${repo.repo} | ${repo.total_views} | ${repo.total_clones} | ${repo.unique_visitors} | ${interest} |\n`;
    });

    md += `\n---\n\n`;
  }

  md += `## 📅 Data Collection

- **Method:** GitHub Actions (automated daily)
- **Schedule:** 12:00 PM UTC (7am EST / 4am PST)
- **Retention:** Unlimited (GitHub only keeps 14 days)
- **Next Update:** Automatic

---

*Generated by [GitHub Analytics Tracker](https://github.com/opena2a-org/github-analytics-tracker)*
`;

  return md;
}

function main() {
  console.log('📝 Generating markdown files from database...');

  try {
    const repoStats = getRepositoryStats();

    if (repoStats.length === 0) {
      console.log('⚠️  No repository data found in database');
      process.exit(0);
    }

    // Generate ANALYTICS.md
    const analyticsMD = generateAnalyticsMD(repoStats);
    const analyticsPath = path.join(__dirname, '..', 'ANALYTICS.md');
    fs.writeFileSync(analyticsPath, analyticsMD);
    console.log('✅ Generated ANALYTICS.md');

    // Generate ANALYTICS_DETAILED.md
    const detailedMD = generateDetailedMD(repoStats);
    const detailedPath = path.join(__dirname, '..', 'ANALYTICS_DETAILED.md');
    fs.writeFileSync(detailedPath, detailedMD);
    console.log('✅ Generated ANALYTICS_DETAILED.md');

    console.log('\n🎉 Markdown generation complete!');
  } catch (error) {
    console.error('❌ Error generating markdown:', error.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
