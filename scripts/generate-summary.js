/**
 * Generates a public summary JSON file with total adoption metrics
 * across all ecosystems (npm, PyPI, GitHub clones, Docker).
 *
 * Output: data/summary.json
 * Consumed by: opena2a-website social proof section
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath, { readonly: true });

try {
  // npm totals
  const npmTotal = db.prepare(`
    SELECT COALESCE(SUM(downloads), 0) as total FROM npm_downloads
  `).get();

  const npmExCrypto = db.prepare(`
    SELECT COALESCE(SUM(d.downloads), 0) as total
    FROM npm_packages p JOIN npm_downloads d ON p.id = d.package_id
    WHERE p.name != 'cryptoserve'
  `).get();

  // PyPI totals
  const pypiTotal = db.prepare(`
    SELECT COALESCE(SUM(downloads), 0) as total FROM pypi_downloads
  `).get();

  const pypiExCrypto = db.prepare(`
    SELECT COALESCE(SUM(d.downloads), 0) as total
    FROM pypi_packages p JOIN pypi_downloads d ON p.id = d.package_id
    WHERE p.name NOT LIKE 'cryptoserve%'
  `).get();

  // GitHub clones totals
  const clonesTotal = db.prepare(`
    SELECT COALESCE(SUM(count), 0) as total FROM traffic_clones
  `).get();

  const clonesExCrypto = db.prepare(`
    SELECT COALESCE(SUM(c.count), 0) as total
    FROM repositories r JOIN traffic_clones c ON r.id = c.repo_id
    WHERE r.full_name != 'ecolibria/cryptoserve'
  `).get();

  // Docker totals
  const dockerTotal = db.prepare(`
    SELECT COALESCE(MAX(pull_count), 0) as total FROM docker_pulls
  `).get();

  // GitHub views
  const viewsTotal = db.prepare(`
    SELECT COALESCE(SUM(count), 0) as total FROM traffic_views
  `).get();

  // Stars
  const starsTotal = db.prepare(`
    SELECT COALESCE(SUM(total_stars), 0) as total
    FROM stargazers
    WHERE date = (SELECT MAX(date) FROM stargazers)
  `).get();

  // Repo count
  const repoCount = db.prepare('SELECT COUNT(*) as count FROM repositories').get();

  // npm package count
  const npmPkgCount = db.prepare('SELECT COUNT(*) as count FROM npm_packages').get();

  // Total adoption (all ecosystems)
  const totalAll = npmTotal.total + pypiTotal.total + clonesTotal.total + dockerTotal.total;
  const totalExCrypto = npmExCrypto.total + pypiExCrypto.total + clonesExCrypto.total + dockerTotal.total;

  const summary = {
    lastUpdated: new Date().toISOString(),
    total: {
      adoption: totalAll,
      adoptionExCrypto: totalExCrypto,
      npm: npmTotal.total,
      pypi: pypiTotal.total,
      clones: clonesTotal.total,
      docker: dockerTotal.total,
      views: viewsTotal.total,
      stars: starsTotal.total,
      repos: repoCount.count,
      npmPackages: npmPkgCount.count,
    },
    excludingCrypto: {
      npm: npmExCrypto.total,
      pypi: pypiExCrypto.total,
      clones: clonesExCrypto.total,
      docker: dockerTotal.total,
    },
  };

  const outPath = path.join(__dirname, '..', 'data', 'summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Summary written to ${outPath}`);
  console.log(`  Total adoption: ${totalAll.toLocaleString()}`);
  console.log(`  Excl. CryptoServe: ${totalExCrypto.toLocaleString()}`);
} catch (err) {
  console.error('Error generating summary:', err);
  process.exit(1);
} finally {
  db.close();
}
