const Database = require('better-sqlite3');
const path = require('path');
const { groupByCanonical, pickCanonical } = require('../../lib/repos');

export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    // Order by traffic (most-viewed first) so the dashboard defaults to a
    // repo that actually has data, not whichever was added most recently.
    // Each repo carries its total views/clones/stars for client-side sorting.
    const rows = db.prepare(`
      SELECT
        r.*,
        COALESCE((SELECT SUM(count) FROM traffic_views WHERE repo_id = r.id), 0)  AS totalViews,
        COALESCE((SELECT SUM(count) FROM traffic_clones WHERE repo_id = r.id), 0) AS totalClones,
        COALESCE((SELECT total_stars FROM stargazers WHERE repo_id = r.id ORDER BY date DESC LIMIT 1), 0) AS stars,
        COALESCE((SELECT total_forks FROM forks WHERE repo_id = r.id ORDER BY date DESC LIMIT 1), 0) AS forks
      FROM repositories r
    `).all();

    // Collapse stale transfer/rename twins into one logical repo: sum the
    // (disjoint) traffic histories, take stars/forks from the canonical (live)
    // row, and drill into that row's id. Keeps this list consistent with the
    // overview totals and the Star Growth chart. See lib/repos.js.
    const repos = [];
    for (const [canon, group] of groupByCanonical(rows)) {
      const c = pickCanonical(group, canon);
      const slash = canon.indexOf('/');
      repos.push({
        ...c,
        id: c.id,
        full_name: canon,
        owner: slash >= 0 ? canon.slice(0, slash) : c.owner,
        repo: slash >= 0 ? canon.slice(slash + 1) : c.repo,
        totalViews: group.reduce((s, r) => s + (r.totalViews || 0), 0),
        totalClones: group.reduce((s, r) => s + (r.totalClones || 0), 0),
        stars: c.stars || 0,
        forks: c.forks || 0,
      });
    }
    repos.sort((a, b) =>
      b.totalViews - a.totalViews ||
      b.totalClones - a.totalClones ||
      a.full_name.localeCompare(b.full_name)
    );

    res.status(200).json(repos);
  } catch (error) {
    console.error('Error fetching repos:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  } finally {
    db.close();
  }
}
