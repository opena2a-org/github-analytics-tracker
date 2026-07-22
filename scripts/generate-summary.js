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
const { canonicalRepoTotals } = require('../lib/repos');

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

  // GitHub clones. Adoption counts UNIQUE CLONERS (distinct pullers), NOT the raw
  // clone count — raw count is dominated by CI/mirror re-cloning (a handful of
  // actors looping) and is not adoption. See lib/adoption.js. The raw count is
  // still surfaced as `clones` for context/transparency.
  const clonesTotal = db.prepare(`
    SELECT COALESCE(SUM(count), 0) as total FROM traffic_clones
  `).get();

  const clonesExCrypto = db.prepare(`
    SELECT COALESCE(SUM(c.count), 0) as total
    FROM repositories r JOIN traffic_clones c ON r.id = c.repo_id
    WHERE r.full_name != 'ecolibria/cryptoserve'
  `).get();

  // cryptoserve's own 14-day deduped cloners, to subtract for the ex-crypto total.
  const cryptoUniqueCloners = db.prepare(`
    SELECT COALESCE(clones_uniques, 0) AS u
    FROM traffic_summary ts JOIN repositories r ON r.id = ts.repo_id
    WHERE r.full_name = 'ecolibria/cryptoserve'
    ORDER BY ts.date DESC LIMIT 1
  `).get();

  // Docker totals: latest pull_count per image, summed across images — matching
  // the dashboard (pages/api/overview.js). MAX() across all rows silently took
  // only the single biggest image and undercounted the fleet by ~10K.
  const dockerTotal = db.prepare(`
    SELECT COALESCE(SUM(p), 0) AS total FROM (
      SELECT (SELECT pull_count FROM docker_pulls dp2
              WHERE dp2.image_id = dp.image_id ORDER BY date DESC LIMIT 1) AS p
      FROM docker_pulls dp GROUP BY dp.image_id
    )
  `).get();

  // HuggingFace model downloads: latest all-time count per model, summed —
  // matching the dashboard. Previously omitted here entirely, which was the
  // other half of the summary-vs-dashboard reconciliation gap.
  const hfTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='huggingface_stats'"
  ).get();
  const hfTotal = hfTableExists ? db.prepare(`
    SELECT COALESCE(SUM(d), 0) AS total FROM (
      SELECT (SELECT downloads_all_time FROM huggingface_stats h2
              WHERE h2.model_id = h.model_id ORDER BY date DESC LIMIT 1) AS d
      FROM huggingface_stats h GROUP BY h.model_id
    )
  `).get() : { total: 0 };

  // GitHub views
  const viewsTotal = db.prepare(`
    SELECT COALESCE(SUM(count), 0) as total FROM traffic_views
  `).get();

  // Stars + repo count, deduplicated by canonical repo. Summing total_stars on
  // the latest date would drop repos whose last snapshot predates it (e.g. an
  // archived repo), and summing per-repo latest would double-count stale
  // transfer/rename twins. canonicalRepoTotals collapses twins and counts each
  // canonical repo's latest snapshot once. See lib/repos.js.
  const canonTotals = canonicalRepoTotals(db);
  const starsTotal = { total: canonTotals.stars };
  const repoCount = { count: canonTotals.repoCount };

  // Unique cloners = 14-day deduplicated distinct cloners, deduped by canonical
  // repo (twins collapsed, snapshot from the canonical row) — identical to the
  // dashboard's totals.github.totalCloneUniques. NOT SUM(daily uniques) and NOT a
  // sum across twin rows, both of which over-count. See lib/adoption.js.
  const cloneUniquesTotal = { total: canonTotals.uniqueCloners };
  const cloneUniquesExCrypto = { total: canonTotals.uniqueCloners - (cryptoUniqueCloners?.u || 0) };

  // Chrome Web Store weekly-active users (latest snapshot per extension,
  // summed across extensions). This is NOT a download count and is deliberately
  // excluded from total adoption — surfaced separately for context.
  const chromeTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chrome_extensions'"
  ).get();
  let chromeUsers = 0, chromeExtCount = 0;
  if (chromeTableExists) {
    const exts = db.prepare('SELECT id FROM chrome_extensions').all();
    chromeExtCount = exts.length;
    const latestUsers = db.prepare(
      'SELECT users FROM chrome_stats WHERE extension_id = ? ORDER BY date DESC LIMIT 1'
    );
    for (const e of exts) chromeUsers += latestUsers.get(e.id)?.users || 0;
  }

  // First-party CLI telemetry — ACTIVE USERS (distinct installs over rolling
  // windows), from the Registry's coarse public adoption feed. This is NOT a
  // download count and is deliberately excluded from total adoption — surfaced
  // separately as the crown-jewel "real people using the tools" signal. Latest
  // snapshot only (point-in-time, like Chrome users), never summed across days.
  const telemetryTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_snapshots'"
  ).get();
  let telemetry = null;
  if (telemetryTableExists) {
    const latest = db.prepare(
      'SELECT date, total_installs, wau, mau, engaged_mau, provenance FROM telemetry_snapshots ORDER BY date DESC LIMIT 1'
    ).get();
    if (latest) {
      const toolCount = db.prepare(
        'SELECT COUNT(*) as count FROM telemetry_tool_snapshots WHERE date = ?'
      ).get(latest.date);
      const countryCount = db.prepare(
        'SELECT COUNT(*) as count FROM telemetry_country_snapshots WHERE date = ?'
      ).get(latest.date);
      telemetry = {
        asOf: latest.date,
        totalInstalls: latest.total_installs,
        wau: latest.wau,
        mau: latest.mau,
        // Sybil-dampened floor — the honest headline; mau/wau are best-effort.
        engagedMau: latest.engaged_mau ?? 0,
        tools: toolCount?.count || 0,
        countries: countryCount?.count || 0,
        // Honest basis + limits travel into the committed public JSON too.
        provenance: latest.provenance || '',
      };
    }
  }

  // npm package count
  const npmPkgCount = db.prepare('SELECT COUNT(*) as count FROM npm_packages').get();

  // Total adoption (all ecosystems). Clone term = UNIQUE CLONERS, not raw count.
  // Same formula as the dashboard's combined.totalAdoption (overview.js):
  // uniqueCloners + npm + pypi + docker + hf — the two surfaces must agree.
  const totalAll = npmTotal.total + pypiTotal.total + cloneUniquesTotal.total + dockerTotal.total + hfTotal.total;
  const totalExCrypto = npmExCrypto.total + pypiExCrypto.total + cloneUniquesExCrypto.total + dockerTotal.total + hfTotal.total;

  // Gross DOWNLOADS (all ecosystems): npm downloads + PyPI downloads + Docker
  // pulls + git clones (raw) + HF model downloads. Every term is literally a
  // download event, counted the same way the ecosystems themselves report
  // downloads (incl. CI and re-downloads — same semantics as npm's public
  // download counts). This is the marketing/headline metric; `adoption` above
  // stays the deduplicated floor. Views are NOT downloads, never included.
  const downloadsAll = npmTotal.total + pypiTotal.total + clonesTotal.total + dockerTotal.total + hfTotal.total;
  const downloadsExCrypto = npmExCrypto.total + pypiExCrypto.total + clonesExCrypto.total + dockerTotal.total + hfTotal.total;

  const summary = {
    lastUpdated: new Date().toISOString(),
    total: {
      adoption: totalAll,
      adoptionExCrypto: totalExCrypto,
      // Gross download events across npm + PyPI + Docker + git clones. The
      // website's "downloads" headline sources THIS field, never `adoption`.
      downloads: downloadsAll,
      downloadsExCrypto,
      npm: npmTotal.total,
      pypi: pypiTotal.total,
      // Distinct cloners — the term summed into `adoption`.
      cloneUniques: cloneUniquesTotal.total,
      // Raw git-clone count — context/transparency only, NOT in `adoption`.
      clones: clonesTotal.total,
      docker: dockerTotal.total,
      hf: hfTotal.total,
      views: viewsTotal.total,
      stars: starsTotal.total,
      repos: repoCount.count,
      npmPackages: npmPkgCount.count,
      // Context only — weekly-active users, not installs; not in `adoption`.
      chromeUsers,
      chromeExtensions: chromeExtCount,
      // First-party CLI active users (distinct installs), not downloads; not in
      // `adoption`. null until the telemetry feed has been collected.
      telemetry,
    },
    excludingCrypto: {
      npm: npmExCrypto.total,
      pypi: pypiExCrypto.total,
      cloneUniques: cloneUniquesExCrypto.total,
      clones: clonesExCrypto.total,
      docker: dockerTotal.total,
      downloads: downloadsExCrypto,
    },
  };

  const outPath = path.join(__dirname, '..', 'data', 'summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Summary written to ${outPath}`);
  console.log(`  Total adoption: ${totalAll.toLocaleString()}`);
  console.log(`  Excl. CryptoServe: ${totalExCrypto.toLocaleString()}`);
  console.log(`  Gross downloads: ${downloadsAll.toLocaleString()} (excl. CryptoServe: ${downloadsExCrypto.toLocaleString()})`);
} catch (err) {
  console.error('Error generating summary:', err);
  process.exit(1);
} finally {
  db.close();
}
