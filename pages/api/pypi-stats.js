import Database from 'better-sqlite3';
import path from 'path';

export default function handler(req, res) {
  const dbPath = process.env.ANALYTICS_DB_PATH || path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    // Check if pypi tables exist
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_packages'"
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

      const pkg = db.prepare('SELECT * FROM pypi_packages WHERE id = ?').get(pkgId);
      if (!pkg) {
        return res.status(404).json({ error: 'Package not found' });
      }

      const downloads = db.prepare(`
        SELECT date, downloads
        FROM pypi_downloads
        WHERE package_id = ? AND date >= ?
        ORDER BY date ASC
      `).all(pkgId, startDateStr);

      const totals = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM pypi_downloads
        WHERE package_id = ? AND date >= ?
      `).get(pkgId, startDateStr);

      const allTime = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM pypi_downloads
        WHERE package_id = ?
      `).get(pkgId);

      // Get Python version breakdown (latest snapshot)
      let pythonVersions = [];
      const pyVerTableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_python_versions'"
      ).get();
      if (pyVerTableCheck) {
        const latestPyVerDate = db.prepare(
          'SELECT MAX(date) as date FROM pypi_python_versions WHERE package_id = ?'
        ).get(pkgId);

        if (latestPyVerDate?.date) {
          pythonVersions = db.prepare(`
            SELECT python_version, downloads
            FROM pypi_python_versions
            WHERE package_id = ? AND date = ?
            ORDER BY downloads DESC
          `).all(pkgId, latestPyVerDate.date);
        }
      }

      // Get OS breakdown (latest snapshot)
      let systemStats = [];
      const sysTableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_system_stats'"
      ).get();
      if (sysTableCheck) {
        const latestSysDate = db.prepare(
          'SELECT MAX(date) as date FROM pypi_system_stats WHERE package_id = ?'
        ).get(pkgId);

        if (latestSysDate?.date) {
          systemStats = db.prepare(`
            SELECT os_name, downloads
            FROM pypi_system_stats
            WHERE package_id = ? AND date = ?
            ORDER BY downloads DESC
          `).all(pkgId, latestSysDate.date);
        }
      }

      // Get country download breakdown (latest snapshot from BigQuery)
      let countryDownloads = [];
      let countryAsOf = null;
      const countryTableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_country_downloads'"
      ).get();
      if (countryTableCheck) {
        const latestCountryDate = db.prepare(
          'SELECT MAX(date) as date FROM pypi_country_downloads WHERE package_id = ?'
        ).get(pkgId);
        countryAsOf = latestCountryDate?.date || null;

        if (latestCountryDate?.date) {
          countryDownloads = db.prepare(`
            SELECT country_code AS countryCode, downloads
            FROM pypi_country_downloads
            WHERE package_id = ? AND date = ?
            ORDER BY downloads DESC
          `).all(pkgId, latestCountryDate.date);
        }
      }

      return res.status(200).json({
        package: pkg,
        summary: {
          periodDownloads: totals.total,
          allTimeDownloads: allTime.total,
        },
        downloads,
        pythonVersions,
        systemStats,
        countryDownloads,
        countryAsOf,
      });
    }

    // Return all packages with summary stats
    const packages = db.prepare('SELECT * FROM pypi_packages ORDER BY name').all();

    const packagesWithStats = packages.map(pkg => {
      const allTime = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM pypi_downloads WHERE package_id = ?
      `).get(pkg.id);

      const last30 = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM pypi_downloads WHERE package_id = ? AND date >= date('now', '-30 days')
      `).get(pkg.id);

      const last7 = db.prepare(`
        SELECT COALESCE(SUM(downloads), 0) as total
        FROM pypi_downloads WHERE package_id = ? AND date >= date('now', '-7 days')
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
    console.error('Error fetching PyPI stats:', error);
    res.status(500).json({ error: 'Failed to fetch PyPI statistics' });
  } finally {
    db.close();
  }
}
