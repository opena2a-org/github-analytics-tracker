const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='huggingface_models'"
    ).get();

    if (!tableCheck) {
      return res.status(200).json({ models: [] });
    }

    const { model_id, days = '30' } = req.query;

    if (model_id) {
      const mId = parseInt(model_id);
      const daysNum = days === 'all' ? 999999 : parseInt(days);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      const startDateStr = startDate.toISOString().split('T')[0];

      const model = db.prepare('SELECT * FROM huggingface_models WHERE id = ?').get(mId);
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }

      const snapshots = db.prepare(`
        SELECT date, downloads_30d, downloads_all_time, likes
        FROM huggingface_stats
        WHERE model_id = ? AND date >= ?
        ORDER BY date ASC
      `).all(mId, startDateStr);

      // Daily download deltas derived from successive all-time snapshots.
      const series = snapshots.map((row, i) => ({
        date: row.date,
        downloadsAllTime: row.downloads_all_time,
        downloads30d: row.downloads_30d,
        likes: row.likes,
        dailyDownloads: i > 0 ? Math.max(0, row.downloads_all_time - snapshots[i - 1].downloads_all_time) : 0,
      }));

      const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
      const earliest = snapshots.length ? snapshots[0] : null;
      const periodDownloads = latest && earliest
        ? Math.max(0, latest.downloads_all_time - earliest.downloads_all_time)
        : 0;

      return res.status(200).json({
        model,
        summary: {
          downloadsAllTime: latest?.downloads_all_time || 0,
          downloads30d: latest?.downloads_30d || 0,
          likes: latest?.likes || 0,
          periodDownloads,
          daysTracked: snapshots.length,
        },
        series,
      });
    }

    // List all models with latest stats + 7d/30d snapshot deltas.
    const models = db.prepare('SELECT * FROM huggingface_models ORDER BY model_id').all();

    const modelsWithStats = models.map(m => {
      const latest = db.prepare(`
        SELECT downloads_30d, downloads_all_time, likes
        FROM huggingface_stats WHERE model_id = ?
        ORDER BY date DESC LIMIT 1
      `).get(m.id);

      const weekAgo = db.prepare(`
        SELECT downloads_all_time
        FROM huggingface_stats WHERE model_id = ? AND date <= date('now', '-7 days')
        ORDER BY date DESC LIMIT 1
      `).get(m.id);

      return {
        id: m.id,
        name: m.model_id,
        full_name: m.model_id,
        author: m.author,
        pipeline_tag: m.pipeline_tag,
        downloadsAllTime: latest?.downloads_all_time || 0,
        downloads30d: latest?.downloads_30d || 0,
        likes: latest?.likes || 0,
        last7Downloads: latest && weekAgo
          ? Math.max(0, latest.downloads_all_time - weekAgo.downloads_all_time)
          : 0,
      };
    });

    res.status(200).json({ models: modelsWithStats });
  } catch (error) {
    console.error('Error fetching HuggingFace stats:', error);
    res.status(500).json({ error: 'Failed to fetch HuggingFace statistics' });
  } finally {
    db.close();
  }
}
