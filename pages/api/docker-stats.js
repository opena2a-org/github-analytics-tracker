const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='docker_images'"
    ).get();

    if (!tableCheck) {
      return res.status(200).json({ images: [] });
    }

    const { image_id, days = '30' } = req.query;

    if (image_id) {
      const imgId = parseInt(image_id);
      const daysNum = days === 'all' ? 999999 : parseInt(days);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      const startDateStr = startDate.toISOString().split('T')[0];

      const image = db.prepare('SELECT * FROM docker_images WHERE id = ?').get(imgId);
      if (!image) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const pulls = db.prepare(`
        SELECT date, pull_count, star_count
        FROM docker_pulls
        WHERE image_id = ? AND date >= ?
        ORDER BY date ASC
      `).all(imgId, startDateStr);

      // Calculate daily pull deltas from cumulative totals
      const dailyPulls = pulls.map((row, i) => ({
        date: row.date,
        totalPulls: row.pull_count,
        dailyPulls: i > 0 ? Math.max(0, row.pull_count - pulls[i - 1].pull_count) : 0,
        stars: row.star_count,
      }));

      const latest = pulls.length > 0 ? pulls[pulls.length - 1] : null;
      const earliest = pulls.length > 0 ? pulls[0] : null;
      const pullGrowth = latest && earliest ? latest.pull_count - earliest.pull_count : 0;

      // Get tag information (latest snapshot)
      let tags = [];
      const tagTableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='docker_tags'"
      ).get();
      if (tagTableCheck) {
        const latestTagDate = db.prepare(
          'SELECT MAX(date) as date FROM docker_tags WHERE image_id = ?'
        ).get(imgId);

        if (latestTagDate?.date) {
          tags = db.prepare(`
            SELECT tag, full_size, last_updated
            FROM docker_tags
            WHERE image_id = ? AND date = ?
            ORDER BY last_updated DESC
          `).all(imgId, latestTagDate.date);
        }
      }

      return res.status(200).json({
        image,
        summary: {
          totalPulls: latest?.pull_count || 0,
          stars: latest?.star_count || 0,
          pullGrowth,
          daysTracked: pulls.length,
        },
        pulls: dailyPulls,
        tags,
      });
    }

    // Return all images with latest stats
    const images = db.prepare('SELECT * FROM docker_images ORDER BY name').all();

    const imagesWithStats = images.map(img => {
      const latest = db.prepare(`
        SELECT pull_count, star_count
        FROM docker_pulls WHERE image_id = ?
        ORDER BY date DESC LIMIT 1
      `).get(img.id);

      const weekAgo = db.prepare(`
        SELECT pull_count
        FROM docker_pulls WHERE image_id = ? AND date <= date('now', '-7 days')
        ORDER BY date DESC LIMIT 1
      `).get(img.id);

      const monthAgo = db.prepare(`
        SELECT pull_count
        FROM docker_pulls WHERE image_id = ? AND date <= date('now', '-30 days')
        ORDER BY date DESC LIMIT 1
      `).get(img.id);

      return {
        ...img,
        totalPulls: latest?.pull_count || 0,
        stars: latest?.star_count || 0,
        last7Pulls: latest && weekAgo ? latest.pull_count - weekAgo.pull_count : 0,
        last30Pulls: latest && monthAgo ? latest.pull_count - monthAgo.pull_count : 0,
      };
    });

    res.status(200).json({ images: imagesWithStats });
  } catch (error) {
    console.error('Error fetching Docker stats:', error);
    res.status(500).json({ error: 'Failed to fetch Docker statistics' });
  } finally {
    db.close();
  }
}
