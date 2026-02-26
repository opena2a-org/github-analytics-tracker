const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const https = require('https');

require('dotenv').config();

const PYPI_PACKAGES = process.env.PYPI_PACKAGES?.split(',').map(p => p.trim()).filter(Boolean) || [];

if (PYPI_PACKAGES.length === 0) {
  console.error('Error: PYPI_PACKAGES environment variable is required');
  console.error('  PYPI_PACKAGES=cryptoserve,cryptoserve-core,aim-sdk  (comma-separated)');
  process.exit(1);
}

const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath);

const today = new Date().toISOString().split('T')[0];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'github-analytics-tracker' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${data.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getOrCreatePackage(name, description, version) {
  let pkg = db.prepare('SELECT * FROM pypi_packages WHERE name = ?').get(name);

  if (!pkg) {
    const result = db.prepare(
      'INSERT INTO pypi_packages (name, description, version) VALUES (?, ?, ?)'
    ).run(name, description, version);
    pkg = { id: result.lastInsertRowid, name, description, version };
    console.log('  Added new package: %s', name);
  } else {
    db.prepare(
      'UPDATE pypi_packages SET description = ?, version = ? WHERE id = ?'
    ).run(description, version, pkg.id);
  }

  return pkg;
}

/**
 * Fetch package metadata from PyPI JSON API.
 */
async function fetchPackageMetadata(name) {
  try {
    const data = await httpGet(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    return {
      description: data.info?.summary || '',
      version: data.info?.version || '',
    };
  } catch (error) {
    console.log('  Metadata: failed - %s', error.message);
    return { description: '', version: '' };
  }
}

/**
 * Collect download stats from PyPI Stats API.
 *
 * The pypistats.org API provides daily download data for the last 180 days.
 * Response has a `data` array with {category, date, downloads} entries.
 * We filter to category "without_mirrors" for cleaner counts, falling
 * back to "with_mirrors" if needed.
 *
 * We skip today's data since it may still be accumulating.
 */
async function collectDownloads(pkg) {
  try {
    const url = `https://pypistats.org/api/packages/${encodeURIComponent(pkg.name)}/overall?mirrors=true`;
    const data = await httpGet(url);

    if (!data.data || data.data.length === 0) {
      console.log('  Downloads: no data available');
      return;
    }

    // Group by date, prefer "without_mirrors" category
    const dateMap = {};
    for (const entry of data.data) {
      if (!dateMap[entry.date]) {
        dateMap[entry.date] = {};
      }
      dateMap[entry.date][entry.category] = entry.downloads;
    }

    const insert = db.prepare(`
      INSERT OR REPLACE INTO pypi_downloads (package_id, date, downloads)
      VALUES (?, ?, ?)
    `);

    let storedDays = 0;
    let totalDownloads = 0;
    for (const [date, categories] of Object.entries(dateMap)) {
      // Skip today - count may not be fully settled
      if (date === today) continue;

      // Use "without_mirrors" if available, otherwise "with_mirrors"
      const downloads = categories['without_mirrors'] ?? categories['with_mirrors'] ?? 0;
      insert.run(pkg.id, date, downloads);
      totalDownloads += downloads;
      storedDays++;
    }

    console.log('  Downloads: %d days stored, %d total in range', storedDays, totalDownloads);
  } catch (error) {
    console.error('  Downloads: failed - %s', error.message);
  }
}

async function generatePypiBadgeJson() {
  const packages = db.prepare('SELECT * FROM pypi_packages').all();

  for (const pkg of packages) {
    const stats = db.prepare(`
      SELECT COALESCE(SUM(downloads), 0) as total
      FROM pypi_downloads
      WHERE package_id = ?
    `).get(pkg.id);

    const last30 = db.prepare(`
      SELECT COALESCE(SUM(downloads), 0) as total
      FROM pypi_downloads
      WHERE package_id = ? AND date >= date('now', '-30 days')
    `).get(pkg.id);

    const statsData = {
      lastUpdated: new Date().toISOString(),
      package: pkg.name,
      version: pkg.version,
      stats: {
        allTimeDownloads: stats?.total || 0,
        last30Days: last30?.total || 0
      }
    };

    const safeName = pkg.name.replace(/[@/]/g, '_');
    const statsPath = path.join(__dirname, '..', 'data', `pypi-stats-${safeName}.json`);
    fs.writeFileSync(statsPath, JSON.stringify(statsData, null, 2));
  }
}

async function main() {
  console.log('PyPI Analytics Collector');
  console.log('Date: %s', today);
  console.log('Tracking %d PyPI packages\n', PYPI_PACKAGES.length);

  for (const name of PYPI_PACKAGES) {
    console.log('\nCollecting stats for %s...', name);

    const metadata = await fetchPackageMetadata(name);
    const pkgRecord = getOrCreatePackage(name, metadata.description, metadata.version);
    await collectDownloads(pkgRecord);
  }

  console.log('\nGenerating PyPI badge JSON files...');
  await generatePypiBadgeJson();

  console.log('\nCollection complete!');
  db.close();
}

main().catch(error => {
  console.error('Fatal error: %s', error.message);
  process.exit(1);
});
