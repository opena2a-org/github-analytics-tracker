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

    // Resolve the canonical repo and all its twin rows (stale rows left behind by
    // a transfer/rename). Traffic is summed across the twins so the chart shows
    // the full history (the twin date ranges are disjoint), while snapshots
    // (stars/forks/referrers/etc.) come from the canonical row. See lib/repos.js.
    const self = db.prepare(
      'SELECT id, full_name, canonical_full_name FROM repositories WHERE id = ?'
    ).get(repoId);
    const canon = self?.canonical_full_name || self?.full_name;
    const twinIds = canon
      ? db.prepare(
          'SELECT id FROM repositories WHERE COALESCE(canonical_full_name, full_name) = ?'
        ).all(canon).map(r => r.id)
      : [repoId];
    const canonId = (canon && db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(canon)?.id) || repoId;
    const twinPlaceholders = twinIds.map(() => '?').join(',');

    // Get views (summed across twins by date — disjoint histories combine)
    const views = db.prepare(`
      SELECT date, SUM(count) AS count, SUM(uniques) AS uniques
      FROM traffic_views
      WHERE repo_id IN (${twinPlaceholders}) AND date >= ?
      GROUP BY date
      ORDER BY date ASC
    `).all(...twinIds, startDateStr);

    // Get clones (summed across twins by date)
    const clones = db.prepare(`
      SELECT date, SUM(count) AS count, SUM(uniques) AS uniques
      FROM traffic_clones
      WHERE repo_id IN (${twinPlaceholders}) AND date >= ?
      GROUP BY date
      ORDER BY date ASC
    `).all(...twinIds, startDateStr);

    // Get latest referrer snapshot (most recent date, not aggregated across dates)
    const latestReferrerDate = db.prepare(`
      SELECT MAX(date) as date FROM referrers WHERE repo_id = ? AND date >= ?
    `).get(canonId, startDateStr);

    const referrers = latestReferrerDate?.date ? db.prepare(`
      SELECT referrer, count, uniques
      FROM referrers
      WHERE repo_id = ? AND date = ?
      ORDER BY count DESC
    `).all(canonId, latestReferrerDate.date) : [];

    // Get latest popular paths snapshot (most recent date)
    const latestPathDate = db.prepare(`
      SELECT MAX(date) as date FROM popular_paths WHERE repo_id = ? AND date >= ?
    `).get(canonId, startDateStr);

    const paths = latestPathDate?.date ? db.prepare(`
      SELECT path, title, count, uniques
      FROM popular_paths
      WHERE repo_id = ? AND date = ?
      ORDER BY count DESC
    `).all(canonId, latestPathDate.date) : [];

    // Get latest stars and forks
    const latestStats = db.prepare(`
      SELECT
        (SELECT total_stars FROM stargazers WHERE repo_id = ? ORDER BY date DESC LIMIT 1) as latest_stars,
        (SELECT total_stars FROM stargazers WHERE repo_id = ? AND date >= ? ORDER BY date ASC LIMIT 1) as start_stars,
        (SELECT total_forks FROM forks WHERE repo_id = ? ORDER BY date DESC LIMIT 1) as latest_forks,
        (SELECT total_forks FROM forks WHERE repo_id = ? AND date >= ? ORDER BY date ASC LIMIT 1) as start_forks
    `).get(canonId, canonId, startDateStr, canonId, canonId, startDateStr);

    // Get most recent 14-day API summary (accurate unique counts)
    const recentSummary = db.prepare(`
      SELECT views_count, views_uniques, clones_count, clones_uniques
      FROM traffic_summary
      WHERE repo_id = ?
      ORDER BY date DESC
      LIMIT 1
    `).get(canonId);

    const summary = {
      totalViews: views.reduce((sum, v) => sum + v.count, 0),
      totalClones: clones.reduce((sum, c) => sum + c.count, 0),
      // 14-day API uniques (properly deduplicated by GitHub)
      recentUniqueVisitors: recentSummary?.views_uniques || 0,
      recentUniqueCloners: recentSummary?.clones_uniques || 0,
      latestStars: latestStats?.latest_stars || 0,
      starsGrowth: (latestStats?.latest_stars || 0) - (latestStats?.start_stars || 0),
      latestForks: latestStats?.latest_forks || 0,
      forksGrowth: (latestStats?.latest_forks || 0) - (latestStats?.start_forks || 0),
    };

    // Get contributors (latest snapshot)
    let contributors = [];
    const contribTableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='github_contributors'"
    ).get();
    if (contribTableCheck) {
      const latestContribDate = db.prepare(
        'SELECT MAX(date) as date FROM github_contributors WHERE repo_id = ?'
      ).get(canonId);

      if (latestContribDate?.date) {
        contributors = db.prepare(`
          SELECT login, contributions
          FROM github_contributors
          WHERE repo_id = ? AND date = ?
          ORDER BY contributions DESC
        `).all(canonId, latestContribDate.date);
      }
    }

    // Get release download counts (latest snapshot)
    let releases = [];
    const relTableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='github_releases'"
    ).get();
    if (relTableCheck) {
      const latestRelDate = db.prepare(
        'SELECT MAX(date) as date FROM github_releases WHERE repo_id = ?'
      ).get(canonId);

      if (latestRelDate?.date) {
        releases = db.prepare(`
          SELECT tag_name, release_name, published_at, total_downloads
          FROM github_releases
          WHERE repo_id = ? AND date = ?
          ORDER BY published_at DESC
        `).all(canonId, latestRelDate.date);
      }
    }

    res.status(200).json({
      summary,
      views,
      clones,
      referrers,
      paths,
      contributors,
      releases,
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  } finally {
    db.close();
  }
}
