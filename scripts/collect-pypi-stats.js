const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const https = require('https');

require('dotenv').config();

const PYPI_PACKAGES = process.env.PYPI_PACKAGES?.split(',').map(p => p.trim()).filter(Boolean) || [];

// PyPI has no author->packages API and its profile pages are bot-gated, so we
// auto-discover packages by scanning the same GitHub orgs the rest of the
// tracker uses: find Python packaging files in each repo, read the declared
// package name, and confirm it is published on PyPI and owned by us.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_ORGS = (process.env.GITHUB_ORG || '').split(',').map(o => o.trim()).filter(Boolean);
// Set PYPI_DISCOVER=false to disable auto-discovery and use PYPI_PACKAGES only.
const PYPI_DISCOVER = (process.env.PYPI_DISCOVER || 'true').toLowerCase() !== 'false';
const DISCOVERY_ENABLED = PYPI_DISCOVER && GITHUB_ORGS.length > 0 && !!GITHUB_TOKEN;

if (PYPI_PACKAGES.length === 0 && !DISCOVERY_ENABLED) {
  console.error('Error: set PYPI_PACKAGES, or GITHUB_ORG + GITHUB_TOKEN for auto-discovery');
  console.error('  PYPI_PACKAGES=cryptoserve,cryptoserve-core,aim-sdk  (explicit, comma-separated)');
  console.error('  GITHUB_ORG=opena2a-org,ecolibria + GITHUB_TOKEN  (auto-discover from org repos)');
  process.exit(1);
}

// PEP 503 normalization: PyPI treats runs of - _ . as equivalent, case-insensitive.
function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath);

// Migrate existing databases: add source_repo if an older schema lacks it.
const hasSourceRepo = db.prepare('PRAGMA table_info(pypi_packages)').all()
  .some(c => c.name === 'source_repo');
if (!hasSourceRepo) {
  db.prepare('ALTER TABLE pypi_packages ADD COLUMN source_repo TEXT').run();
}

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
 * Fetch a URL and return the raw response body as text. Follows a single
 * redirect (raw.githubusercontent.com occasionally 302s to a CDN host).
 */
function httpGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'github-analytics-tracker', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpGetText(res.headers.location, headers).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(data);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** GET a GitHub REST API path (e.g. "/orgs/x/repos") and parse the JSON. */
async function ghGetJson(apiPath) {
  const text = await httpGetText(`https://api.github.com${apiPath}`, {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  return JSON.parse(text);
}

const PKG_FILE_RE = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/;

/** Extract the distribution name declared in a Python packaging file. */
function extractPackageName(filePath, content) {
  if (filePath.endsWith('pyproject.toml') || filePath.endsWith('setup.cfg')) {
    // [project]/[tool.poetry] name = "x"  or  [metadata] name = x
    const quoted = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (quoted) return quoted[1].trim();
    const bare = content.match(/^\s*name\s*=\s*([A-Za-z0-9._-]+)\s*$/m);
    return bare ? bare[1].trim() : null;
  }
  if (filePath.endsWith('setup.py')) {
    const m = content.match(/name\s*=\s*["']([^"']+)["']/);
    return m ? m[1].trim() : null;
  }
  return null;
}

/** True if the PyPI project's declared URLs point back to one of our orgs. */
function ownedByOrgs(info, orgs) {
  const urls = [info.home_page, ...Object.values(info.project_urls || {})]
    .filter(Boolean).join(' ').toLowerCase();
  return orgs.some(org => urls.includes(`github.com/${org.toLowerCase()}/`));
}

/**
 * Discover PyPI packages by scanning each org's public repos for Python
 * packaging files. A discovered name is kept only if it is published on PyPI
 * AND that PyPI project links back to a tracked org (rejects vendored
 * third-party copies, e.g. a bundled `mcp`). Returns canonical PyPI names.
 */
async function discoverPypiPackages(orgs) {
  const discovered = new Map(); // normalized -> canonical PyPI name

  for (const org of orgs) {
    const repos = [];
    let page = 1;
    try {
      while (true) {
        const data = await ghGetJson(`/orgs/${org}/repos?type=public&per_page=100&page=${page}`);
        if (!Array.isArray(data) || data.length === 0) break;
        for (const r of data) {
          if (!r.fork && !r.archived) repos.push(r);
        }
        if (data.length < 100) break;
        page++;
      }
    } catch (error) {
      // Not an org (e.g. a user account) or no access: try the user endpoint.
      try {
        const data = await ghGetJson(`/users/${org}/repos?type=owner&per_page=100`);
        for (const r of (Array.isArray(data) ? data : [])) {
          if (!r.fork && !r.archived) repos.push(r);
        }
      } catch (e2) {
        console.log('  %s: repo listing failed - %s', org, e2.message);
        continue;
      }
    }

    console.log('  Scanning %d repos in %s for Python packaging...', repos.length, org);

    for (const repo of repos) {
      const branch = repo.default_branch || 'main';
      let tree;
      try {
        tree = await ghGetJson(`/repos/${org}/${repo.name}/git/trees/${branch}?recursive=1`);
      } catch (error) {
        continue; // empty repo / no tree
      }
      if (!tree.tree) continue;
      if (tree.truncated) {
        console.log('    %s/%s: tree truncated, deep packaging files may be missed', org, repo.name);
      }

      const pkgFiles = tree.tree.filter(n => n.type === 'blob' && PKG_FILE_RE.test(n.path));
      for (const file of pkgFiles) {
        let name;
        try {
          const content = await httpGetText(
            `https://raw.githubusercontent.com/${org}/${repo.name}/${branch}/${file.path}`
          );
          name = extractPackageName(file.path, content);
        } catch (error) {
          continue;
        }
        if (!name) continue;

        const norm = normalizeName(name);
        if (discovered.has(norm)) continue;

        let info;
        try {
          info = (await httpGet(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)).info;
        } catch (error) {
          continue; // not published to PyPI yet
        }
        if (!ownedByOrgs(info, orgs)) {
          console.log('    skip %s (on PyPI but not linked to a tracked org)', name);
          continue;
        }

        const canonical = info.name || name;
        discovered.set(norm, { name: canonical, sourceRepo: `${org}/${repo.name}` });
        console.log('    discovered %s (%s/%s:%s)', canonical, org, repo.name, file.path);
      }
    }
  }

  return [...discovered.values()];
}

function getOrCreatePackage(name, description, version, sourceRepo) {
  let pkg = db.prepare('SELECT * FROM pypi_packages WHERE name = ?').get(name);

  if (!pkg) {
    const result = db.prepare(
      'INSERT INTO pypi_packages (name, description, version, source_repo) VALUES (?, ?, ?, ?)'
    ).run(name, description, version, sourceRepo || null);
    pkg = { id: result.lastInsertRowid, name, description, version };
    console.log('  Added new package: %s', name);
  } else {
    // Keep a previously-recorded source_repo if this run didn't resolve one
    // (e.g. the package is in the explicit list but discovery is disabled).
    db.prepare(
      'UPDATE pypi_packages SET description = ?, version = ?, source_repo = COALESCE(?, source_repo) WHERE id = ?'
    ).run(description, version, sourceRepo || null, pkg.id);
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

/**
 * Collect downloads by Python version from pypistats.org.
 *
 * Uses: GET https://pypistats.org/api/packages/{package}/python_minor
 * Returns { data: [{ category: "3.11", date: "2025-01-15", downloads: 100 }, ...] }
 *
 * We aggregate across all dates to get a recent snapshot per version,
 * then store one row per (package, date, python_version).
 */
async function collectPythonVersionStats(pkg) {
  try {
    const url = `https://pypistats.org/api/packages/${encodeURIComponent(pkg.name)}/python_minor?mirrors=false`;
    const data = await httpGet(url);

    if (!data.data || data.data.length === 0) {
      console.log('  Python versions: no data available');
      return;
    }

    // Aggregate downloads per python version across all dates in the response
    const versionMap = {};
    for (const entry of data.data) {
      if (!entry.category || entry.category === 'null') continue;
      if (!versionMap[entry.category]) {
        versionMap[entry.category] = 0;
      }
      versionMap[entry.category] += entry.downloads || 0;
    }

    const insert = db.prepare(`
      INSERT INTO pypi_python_versions (package_id, date, python_version, downloads)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(package_id, date, python_version) DO UPDATE SET
        downloads = excluded.downloads,
        collected_at = CURRENT_TIMESTAMP
    `);

    let count = 0;
    for (const [version, downloads] of Object.entries(versionMap)) {
      if (downloads > 0) {
        insert.run(pkg.id, today, version, downloads);
        count++;
      }
    }

    console.log('  Python versions: %d versions tracked', count);
  } catch (error) {
    console.error('  Python versions: failed - %s', error.message);
  }
}

/**
 * Collect downloads by operating system from pypistats.org.
 *
 * Uses: GET https://pypistats.org/api/packages/{package}/system
 * Returns { data: [{ category: "Linux", date: "2025-01-15", downloads: 500 }, ...] }
 *
 * We aggregate across all dates to get a recent snapshot per OS,
 * then store one row per (package, date, os).
 */
async function collectSystemStats(pkg) {
  try {
    const url = `https://pypistats.org/api/packages/${encodeURIComponent(pkg.name)}/system?mirrors=false`;
    const data = await httpGet(url);

    if (!data.data || data.data.length === 0) {
      console.log('  OS breakdown: no data available');
      return;
    }

    // Aggregate downloads per OS across all dates
    const osMap = {};
    for (const entry of data.data) {
      const osName = entry.category || 'unknown';
      if (!osMap[osName]) {
        osMap[osName] = 0;
      }
      osMap[osName] += entry.downloads || 0;
    }

    const insert = db.prepare(`
      INSERT INTO pypi_system_stats (package_id, date, os_name, downloads)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(package_id, date, os_name) DO UPDATE SET
        downloads = excluded.downloads,
        collected_at = CURRENT_TIMESTAMP
    `);

    let count = 0;
    for (const [osName, downloads] of Object.entries(osMap)) {
      if (downloads > 0) {
        insert.run(pkg.id, today, osName, downloads);
        count++;
      }
    }

    console.log('  OS breakdown: %d systems tracked', count);
  } catch (error) {
    console.error('  OS breakdown: failed - %s', error.message);
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

  let discovered = [];
  if (DISCOVERY_ENABLED) {
    console.log('Auto-discovering PyPI packages from GitHub orgs: %s', GITHUB_ORGS.join(', '));
    try {
      discovered = await discoverPypiPackages(GITHUB_ORGS);
      console.log('Discovered %d PyPI package(s) from org repos.', discovered.length);
    } catch (error) {
      console.error('Discovery failed (continuing with explicit list): %s', error.message);
    }
  }

  // owner/repo each discovered package came from, keyed by PEP 503 name.
  const sourceRepoByNorm = new Map();
  for (const d of discovered) sourceRepoByNorm.set(normalizeName(d.name), d.sourceRepo);

  // Merge explicit list with discovered packages, de-duplicated by PEP 503 name.
  const seen = new Set();
  const packages = [];
  for (const name of [...PYPI_PACKAGES, ...discovered.map(d => d.name)]) {
    const norm = normalizeName(name);
    if (seen.has(norm)) continue;
    seen.add(norm);
    packages.push(name);
  }

  console.log('Tracking %d PyPI packages\n', packages.length);

  for (const name of packages) {
    console.log('\nCollecting stats for %s...', name);

    const sourceRepo = sourceRepoByNorm.get(normalizeName(name)) || null;
    const metadata = await fetchPackageMetadata(name);
    const pkgRecord = getOrCreatePackage(name, metadata.description, metadata.version, sourceRepo);
    await collectDownloads(pkgRecord);
    await collectPythonVersionStats(pkgRecord);
    await collectSystemStats(pkgRecord);
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
