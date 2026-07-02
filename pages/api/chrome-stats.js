const Database = require('better-sqlite3');
const path = require('path');

// Chrome Web Store stats. `users` is Google's rounded weekly-active-user count
// (a snapshot, not cumulative installs), scraped from the public listing.
export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chrome_extensions'"
    ).get();

    if (!tableCheck) {
      return res.status(200).json({ extensions: [] });
    }

    const { extension_id, days = '30' } = req.query;

    if (extension_id) {
      const extId = parseInt(extension_id);
      const daysNum = days === 'all' ? 999999 : parseInt(days);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      const startDateStr = startDate.toISOString().split('T')[0];

      const extension = db.prepare('SELECT * FROM chrome_extensions WHERE id = ?').get(extId);
      if (!extension) {
        return res.status(404).json({ error: 'Extension not found' });
      }

      const history = db.prepare(`
        SELECT date, users, rating, rating_count
        FROM chrome_stats
        WHERE extension_id = ? AND date >= ?
        ORDER BY date ASC
      `).all(extId, startDateStr);

      const latest = history.length > 0 ? history[history.length - 1] : null;
      const earliest = history.length > 0 ? history[0] : null;
      const usersGrowth = latest && earliest ? latest.users - earliest.users : 0;

      return res.status(200).json({
        extension,
        summary: {
          users: latest?.users || 0,
          rating: latest?.rating ?? null,
          ratingCount: latest?.rating_count ?? null,
          usersGrowth,
          daysTracked: history.length,
        },
        history,
      });
    }

    // Return all extensions with latest stats.
    const extensions = db.prepare('SELECT * FROM chrome_extensions ORDER BY name').all();
    const withStats = extensions.map(ext => {
      const latest = db.prepare(
        'SELECT users, rating, rating_count FROM chrome_stats WHERE extension_id = ? ORDER BY date DESC LIMIT 1'
      ).get(ext.id);
      const monthAgo = db.prepare(
        "SELECT users FROM chrome_stats WHERE extension_id = ? AND date <= date('now', '-30 days') ORDER BY date DESC LIMIT 1"
      ).get(ext.id);
      return {
        ...ext,
        users: latest?.users || 0,
        rating: latest?.rating ?? null,
        ratingCount: latest?.rating_count ?? null,
        usersGrowth30d: latest && monthAgo ? latest.users - monthAgo.users : 0,
      };
    });

    res.status(200).json({ extensions: withStats });
  } catch (error) {
    console.error('Error fetching Chrome stats:', error);
    res.status(500).json({ error: 'Failed to fetch Chrome statistics' });
  } finally {
    db.close();
  }
}
