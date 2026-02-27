const Database = require('better-sqlite3');
const path = require('path');

require('dotenv').config();

const PYPI_PACKAGES = process.env.PYPI_PACKAGES?.split(',').map(p => p.trim()).filter(Boolean) || [];

if (PYPI_PACKAGES.length === 0) {
  console.error('Error: PYPI_PACKAGES environment variable is required');
  console.error('  PYPI_PACKAGES=cryptoserve,cryptoserve-core,aim-sdk  (comma-separated)');
  process.exit(1);
}

/**
 * Check whether BigQuery credentials are available.
 * Returns true if GOOGLE_APPLICATION_CREDENTIALS is set and the file exists,
 * or if GOOGLE_CLOUD_PROJECT is set (for workload identity / metadata auth).
 */
function isBigQueryAvailable() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const fs = require('fs');
    if (fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      return true;
    }
    console.log('Warning: GOOGLE_APPLICATION_CREDENTIALS is set but the file does not exist: %s',
      process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return false;
  }
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return true;
  }
  return false;
}

/**
 * Query BigQuery for country-level download stats for a given PyPI package.
 * Returns an array of { countryCode, downloads } sorted by downloads descending.
 */
async function queryCountryDownloads(bigquery, packageName) {
  const query = `
    SELECT
      country_code,
      COUNT(*) as downloads
    FROM \`bigquery-public-data.pypi.file_downloads\`
    WHERE file.project = @package_name
      AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
    GROUP BY country_code
    ORDER BY downloads DESC
    LIMIT 50
  `;

  const options = {
    query,
    params: { package_name: packageName },
    location: 'US',
  };

  const [rows] = await bigquery.query(options);
  return rows.map(row => ({
    countryCode: row.country_code || 'unknown',
    downloads: Number(row.downloads) || 0,
  }));
}

async function main() {
  console.log('PyPI Country Download Stats Collector (BigQuery)');

  if (!isBigQueryAvailable()) {
    console.log('BigQuery credentials not configured. Skipping country download stats.');
    console.log('To enable, set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_PROJECT.');
    console.log('See README for setup instructions.');
    process.exit(0);
  }

  // Dynamic import to avoid errors when BigQuery is not needed
  let BigQuery;
  try {
    const bigqueryModule = require('@google-cloud/bigquery');
    BigQuery = bigqueryModule.BigQuery;
  } catch (error) {
    console.log('BigQuery client library not installed. Skipping country download stats.');
    console.log('Install with: npm install @google-cloud/bigquery');
    process.exit(0);
  }

  const bigquery = new BigQuery();
  const today = new Date().toISOString().split('T')[0];

  const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
  const db = new Database(dbPath);

  console.log('Date: %s', today);
  console.log('Tracking %d PyPI packages\n', PYPI_PACKAGES.length);

  // Ensure pypi_country_downloads table exists (in case setup-database.js hasn't been re-run)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pypi_country_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      country_code TEXT NOT NULL,
      downloads INTEGER NOT NULL DEFAULT 0,
      collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
      UNIQUE(package_id, date, country_code)
    );
    CREATE INDEX IF NOT EXISTS idx_pypi_country_pkg_date ON pypi_country_downloads(package_id, date);
  `);

  const insert = db.prepare(`
    INSERT INTO pypi_country_downloads (package_id, date, country_code, downloads)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(package_id, date, country_code) DO UPDATE SET
      downloads = excluded.downloads,
      collected_at = CURRENT_TIMESTAMP
  `);

  for (const packageName of PYPI_PACKAGES) {
    console.log('Collecting country stats for %s...', packageName);

    // Look up the package in the pypi_packages table
    const pkg = db.prepare('SELECT id FROM pypi_packages WHERE name = ?').get(packageName);
    if (!pkg) {
      console.log('  Package not found in database. Run collect-pypi first.');
      continue;
    }

    try {
      const countryStats = await queryCountryDownloads(bigquery, packageName);

      if (countryStats.length === 0) {
        console.log('  No country data returned from BigQuery');
        continue;
      }

      let totalDownloads = 0;
      for (const stat of countryStats) {
        insert.run(pkg.id, today, stat.countryCode, stat.downloads);
        totalDownloads += stat.downloads;
      }

      console.log('  Country stats: %d countries, %d total downloads (30d)',
        countryStats.length, totalDownloads);

      if (countryStats.length > 0) {
        const top3 = countryStats.slice(0, 3).map(s => `${s.countryCode}: ${s.downloads}`).join(', ');
        console.log('  Top 3: %s', top3);
      }
    } catch (error) {
      console.error('  BigQuery error for %s: %s', packageName, error.message);
      // Continue with next package instead of crashing
      continue;
    }
  }

  console.log('\nCountry stats collection complete.');
  db.close();
}

main().catch(error => {
  console.error('Fatal error: %s', error.message);
  process.exit(1);
});
