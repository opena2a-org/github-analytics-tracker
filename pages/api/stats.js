const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const { repo_id, days = '30' } = req.query;

  if (!repo_id) {
    return res.status(400).json({ error: 'repo_id is required' });
  }

  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const repoId = parseInt(repo_id);
    const daysNum = days === 'all' ? 999999 : parseInt(days);

    // Calculate date range
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);
    const startDateStr = startDate.toISOString().split('T')[0];

    // Get views
    const views = db.prepare(`
      SELECT date, count, uniques
      FROM traffic_views
      WHERE repo_id = ? AND date >= ?
      ORDER BY date ASC
    `).all(repoId, startDateStr);

    // Get clones
    const clones = db.prepare(`
      SELECT date, count, uniques
      FROM traffic_clones
      WHERE repo_id = ? AND date >= ?
      ORDER BY date ASC
    `).all(repoId, startDateStr);

    // Get referrers (aggregate over time period)
    const referrers = db.prepare(`
      SELECT referrer, SUM(count) as count, SUM(uniques) as uniques
      FROM referrers
      WHERE repo_id = ? AND date >= ?
      GROUP BY referrer
      ORDER BY count DESC
    `).all(repoId, startDateStr);

    // Get popular paths (aggregate over time period)
    const paths = db.prepare(`
      SELECT path, title, SUM(count) as count, SUM(uniques) as uniques
      FROM popular_paths
      WHERE repo_id = ? AND date >= ?
      GROUP BY path, title
      ORDER BY count DESC
    `).all(repoId, startDateStr);

    // Get latest stars and forks
    const latestStats = db.prepare(`
      SELECT
        (SELECT total_stars FROM stargazers WHERE repo_id = ? ORDER BY date DESC LIMIT 1) as latest_stars,
        (SELECT total_stars FROM stargazers WHERE repo_id = ? AND date >= ? ORDER BY date ASC LIMIT 1) as start_stars,
        (SELECT total_forks FROM forks WHERE repo_id = ? ORDER BY date DESC LIMIT 1) as latest_forks,
        (SELECT total_forks FROM forks WHERE repo_id = ? AND date >= ? ORDER BY date ASC LIMIT 1) as start_forks
    `).get(repoId, repoId, startDateStr, repoId, repoId, startDateStr);

    // Calculate summary stats
    const summary = {
      total_views: views.reduce((sum, v) => sum + v.count, 0),
      unique_views: views.reduce((sum, v) => sum + v.uniques, 0),
      total_clones: clones.reduce((sum, c) => sum + c.count, 0),
      unique_clones: clones.reduce((sum, c) => sum + c.uniques, 0),
      latest_stars: latestStats?.latest_stars || 0,
      stars_growth: (latestStats?.latest_stars || 0) - (latestStats?.start_stars || 0),
      latest_forks: latestStats?.latest_forks || 0,
      forks_growth: (latestStats?.latest_forks || 0) - (latestStats?.start_forks || 0),
    };

    res.status(200).json({
      summary,
      views,
      clones,
      referrers,
      paths,
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  } finally {
    db.close();
  }
}
