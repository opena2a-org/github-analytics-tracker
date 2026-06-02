const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    // Order by traffic (most-viewed first) so the dashboard defaults to a
    // repo that actually has data, not whichever was added most recently.
    // Each repo carries its total views/clones/stars for client-side sorting.
    const repos = db.prepare(`
      SELECT
        r.*,
        COALESCE((SELECT SUM(count) FROM traffic_views WHERE repo_id = r.id), 0)  AS totalViews,
        COALESCE((SELECT SUM(count) FROM traffic_clones WHERE repo_id = r.id), 0) AS totalClones,
        COALESCE((SELECT total_stars FROM stargazers WHERE repo_id = r.id ORDER BY date DESC LIMIT 1), 0) AS stars,
        COALESCE((SELECT total_forks FROM forks WHERE repo_id = r.id ORDER BY date DESC LIMIT 1), 0) AS forks
      FROM repositories r
      ORDER BY totalViews DESC, totalClones DESC, r.full_name ASC
    `).all();
    res.status(200).json(repos);
  } catch (error) {
    console.error('Error fetching repos:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  } finally {
    db.close();
  }
}
