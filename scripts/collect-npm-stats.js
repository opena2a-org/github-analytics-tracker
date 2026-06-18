const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const https = require('https');

require('dotenv').config();

const NPM_AUTHOR = process.env.NPM_AUTHOR || '';
const NPM_PACKAGES = process.env.NPM_PACKAGES?.split(',').map(p => p.trim()).filter(Boolean) || [];

if (!NPM_AUTHOR && NPM_PACKAGES.length === 0) {
  console.error('Error: Either NPM_AUTHOR or NPM_PACKAGES environment variable is required');
  console.error('  NPM_AUTHOR=ecolibria  (auto-discovers all packages by this maintainer)');
  console.error('  NPM_PACKAGES=hackmyagent,secretless-ai  (explicit list)');
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

/**
 * Discover all npm packages maintained by a given user.
 * Uses the npm registry search API with pagination.
 */
async function discoverPackages(author) {
  console.log('Discovering npm packages by %s...', author);
  const packages = [];
  let from = 0;
  const size = 250;

  while (true) {
    const url = `https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(author)}&size=${size}&from=${from}`;
    const data = await httpGet(url);

    if (!data.objects || data.objects.length === 0) break;

    for (const obj of data.objects) {
      packages.push({
        name: obj.package.name,
        description: obj.package.description || '',
        version: obj.package.version || '',
      });
    }

    if (data.objects.length < size) break;
    from += size;
  }

  console.log('Found %d npm packages by %s', packages.length, author);
  return packages;
}

function getOrCreatePackage(name, description, version) {
  let pkg = db.prepare('SELECT * FROM npm_packages WHERE name = ?').get(name);

  if (!pkg) {
    const result = db.prepare(
      'INSERT INTO npm_packages (name, description, version) VALUES (?, ?, ?)'
    ).run(name, description, version);
    pkg = { id: result.lastInsertRowid, name, description, version };
    console.log('  Added new package: %s', name);
  } else {
    // Update description and version if changed
    db.prepare(
      'UPDATE npm_packages SET description = ?, version = ? WHERE id = ?'
    ).run(description, version, pkg.id);
  }

  return pkg;
}

/**
 * Collect download stats for an npm package.
 *
 * The npm downloads API provides daily download counts.
 * We request the last 365 days to backfill on first run,
 * then subsequent runs just add new days via INSERT OR REPLACE.
 *
 * Unlike GitHub traffic, npm download counts are final for completed days -
 * no partial data issue. We still skip today since the count may not be
 * settled yet in the npm CDN aggregation pipeline.
 */
async function collectDownloads(pkg) {
  try {
    // Request all available historical data.
    // npm API supports up to ~18 months back but may return less for newer packages.
    // Use 2025-01-28 as earliest date (first publish in the org) to capture full history.
    const start = '2025-01-28';

    const url = `https://api.npmjs.org/downloads/range/${start}:${today}/${encodeURIComponent(pkg.name)}`;
    const data = await httpGet(url);

    if (!data.downloads || data.downloads.length === 0) {
      console.log('  Downloads: no data available');
      return;
    }

    const insert = db.prepare(`
      INSERT OR REPLACE INTO npm_downloads (package_id, date, downloads)
      VALUES (?, ?, ?)
    `);

    // Look up existing non-zero download count for a given date.
    // Used to avoid overwriting real data with API-outage zeros.
    const getExisting = db.prepare(`
      SELECT downloads FROM npm_downloads
      WHERE package_id = ? AND date = ? AND downloads > 0
    `);

    let storedDays = 0;
    let skippedZeros = 0;
    let totalDownloads = 0;
    for (const day of data.downloads) {
      // Skip today - count may not be fully settled
      if (day.day === today) continue;

      // Guard against npm API outages that return 0 for days that had real downloads.
      // If we already have a non-zero value stored, don't overwrite it with 0.
      if (day.downloads === 0) {
        const existing = getExisting.get(pkg.id, day.day);
        if (existing) {
          skippedZeros++;
          continue;
        }
      }

      insert.run(pkg.id, day.day, day.downloads);
      totalDownloads += day.downloads;
      storedDays++;
    }

    if (skippedZeros > 0) {
      console.log('  Downloads: %d days stored, %d total in range (%d suspicious zeros skipped)',
        storedDays, totalDownloads, skippedZeros);
    } else {
      console.log('  Downloads: %d days stored, %d total in range', storedDays, totalDownloads);
    }
  } catch (error) {
    console.error('  Downloads: failed - %s', error.message);
  }
}

/**
 * Collect downloads broken down by version for the last week.
 *
 * Uses the npm versions API: GET https://api.npmjs.org/versions/{package}/last-week
 * This returns { "versions": { "1.0.0": 100, "1.1.0": 200, ... } }
 *
 * We store a snapshot per date with version breakdowns.
 */
async function collectVersionDownloads(pkg) {
  try {
    const url = `https://api.npmjs.org/versions/${encodeURIComponent(pkg.name)}/last-week`;
    const data = await httpGet(url);

    if (!data.downloads) {
      console.log('  Version downloads: no data available');
      return;
    }

    const insert = db.prepare(`
      INSERT INTO npm_version_downloads (package_id, date, version, downloads)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(package_id, date, version) DO UPDATE SET
        downloads = excluded.downloads,
        collected_at = CURRENT_TIMESTAMP
    `);

    let versionCount = 0;
    for (const [version, downloads] of Object.entries(data.downloads)) {
      if (downloads > 0) {
        insert.run(pkg.id, today, version, downloads);
        versionCount++;
      }
    }

    console.log('  Version downloads: %d versions with downloads last week', versionCount);
  } catch (error) {
    // This endpoint may 404 for very new or private packages
    if (error.message && error.message.includes('404')) {
      console.log('  Version downloads: not available for this package');
    } else {
      console.error('  Version downloads: failed - %s', error.message);
    }
  }
}

async function generateNpmBadgeJson() {
  const packages = db.prepare('SELECT * FROM npm_packages').all();

  for (const pkg of packages) {
    const stats = db.prepare(`
      SELECT COALESCE(SUM(downloads), 0) as total
      FROM npm_downloads
      WHERE package_id = ?
    `).get(pkg.id);

    const last30 = db.prepare(`
      SELECT COALESCE(SUM(downloads), 0) as total
      FROM npm_downloads
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
    const statsPath = path.join(__dirname, '..', 'data', `npm-stats-${safeName}.json`);
    fs.writeFileSync(statsPath, JSON.stringify(statsData, null, 2));
  }
}

async function main() {
  console.log('npm Analytics Collector');
  console.log('Date: %s', today);

  // Build the package list
  let packages = NPM_PACKAGES.map(name => ({ name, description: '', version: '' }));

  if (NPM_AUTHOR) {
    const discovered = await discoverPackages(NPM_AUTHOR);
    // Merge: discovered + explicit, deduplicated by name
    const nameSet = new Set(discovered.map(p => p.name));
    const extras = packages.filter(p => !nameSet.has(p.name));
    packages = [...discovered, ...extras];
  }

  if (packages.length === 0) {
    console.error('Error: No npm packages found to track');
    process.exit(1);
  }

  // Enrich missing versions from the registry. Author-discovery supplies a
  // version, but explicitly-listed packages (NPM_PACKAGES) and scoped
  // @opena2a/* packages that author-discovery misses arrive with version ''.
  for (const pkg of packages) {
    if (pkg.version) continue;
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace('%2F', '/')}/latest`);
      if (res.ok) {
        const meta = await res.json();
        pkg.version = meta.version || '';
        if (!pkg.description) pkg.description = meta.description || '';
      }
    } catch {
      // Non-fatal: download stats do not depend on the version field.
    }
  }

  console.log('Tracking %d npm packages\n', packages.length);

  for (const pkg of packages) {
    console.log('\nCollecting stats for %s...', pkg.name);
    const pkgRecord = getOrCreatePackage(pkg.name, pkg.description, pkg.version);
    await collectDownloads(pkgRecord);
    await collectVersionDownloads(pkgRecord);
  }

  console.log('\nGenerating npm badge JSON files...');
  await generateNpmBadgeJson();

  console.log('\nCollection complete!');
  db.close();
}

main().catch(error => {
  console.error('Fatal error: %s', error.message);
  process.exit(1);
});
