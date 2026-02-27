const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    // Check if npm tables exist
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='npm_packages'"
    ).get();

    if (!tableCheck) {
      return res.status(200).json({ packages: [], downloads: [] });
    }

    const { package_id, days = '30' } = req.query;

    // If specific package requested
    if (package_id) {
      const pkgId = parseInt(package_id);
      const daysNum = days === 'all' ? 999999 : parseInt(days);

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      const startDateStr = startDate.toISOString().split('T')[0];

      const pkg = db.prepare('SELECT * FROM npm_packages WHERE id = ?').get(pkgId);
      if (!pkg) {
        return res.status(404).json({ error: 'Package not found' });
      }

      const downloads = db.prepare(`
        SELECT date, downloads
        FROM npm_downloads
        WHERE package_id = ? AND date >= ?
        ORDER BY date ASC
      `).all(pkgId, startDateStr);

      const totals = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM npm_downloads
        WHERE package_id = ? AND date >= ?
      `).get(pkgId, startDateStr);

      const allTime = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM npm_downloads
        WHERE package_id = ?
      `).get(pkgId);

      // Get version download breakdown (latest snapshot)
      let versionDownloads = [];
      const verTableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='npm_version_downloads'"
      ).get();
      if (verTableCheck) {
        const latestVerDate = db.prepare(
          'SELECT MAX(date) as date FROM npm_version_downloads WHERE package_id = ?'
        ).get(pkgId);

        if (latestVerDate?.date) {
          versionDownloads = db.prepare(`
            SELECT version, downloads
            FROM npm_version_downloads
            WHERE package_id = ? AND date = ?
            ORDER BY downloads DESC
          `).all(pkgId, latestVerDate.date);
        }
      }

      return res.status(200).json({
        package: pkg,
        summary: {
          periodDownloads: totals.total,
          allTimeDownloads: allTime.total,
        },
        downloads,
        versionDownloads,
      });
    }

    // Return all packages with summary stats
    const packages = db.prepare('SELECT * FROM npm_packages ORDER BY name').all();

    const packagesWithStats = packages.map(pkg => {
      const allTime = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM npm_downloads WHERE package_id = ?
      `).get(pkg.id);

      const last30 = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-30 days')
      `).get(pkg.id);

      const last7 = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-7 days')
      `).get(pkg.id);

      return {
        ...pkg,
        allTimeDownloads: allTime.total,
        last30Downloads: last30.total,
        last7Downloads: last7.total,
      };
    });

    res.status(200).json({ packages: packagesWithStats });
  } catch (error) {
    console.error('Error fetching npm stats:', error);
    res.status(500).json({ error: 'Failed to fetch npm statistics' });
  } finally {
    db.close();
  }
}
