/**
 * Builds the public summary (data/summary.json) from the analytics database.
 *
 * Shape:
 *   total.*            flat totals (kept: the website and Atlas consume them)
 *   excludingCrypto.*  flat ex-CryptoServe totals
 *   series.<key>       one block per registry series (lib/series.js): scope,
 *                      includesCryptoServe, method, definition, window,
 *                      components, status
 *   collectors.<name>  per-collector ran / ok / error for the run that produced
 *                      this file, plus GitHub coverage (reposDiscovered vs rows
 *                      collected today, reposLagging)
 *
 * Every window date is read from the database (MIN/MAX(date) per source
 * table), never typed. A collector error never leaves a series marked "ok".
 */
const fs = require('fs');
const path = require('path');
const { canonicalRepoTotals, canonicalTrafficTotals } = require('./repos');
const { SERIES, SERIES_KEYS, DEFINITION_FIRST_DATES } = require('./series');

const CRYPTO_REPO = 'ecolibria/cryptoserve';

// Collector names as the workflow reports them (steps in collect-stats.yml).
const COLLECTORS = ['github', 'npm', 'pypi', 'docker', 'huggingface', 'chrome', 'telemetry'];

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function dateRange(db, table) {
  if (!tableExists(db, table)) return { first: null, asOf: null };
  const r = db.prepare(`SELECT MIN(date) AS first, MAX(date) AS asOf FROM ${table}`).get();
  return { first: r.first || null, asOf: r.asOf || null };
}

// Per-collector outcome for the run that produced this summary. The workflow
// passes each collector step's outcome as COLLECTOR_OUTCOMES (JSON,
// {"github":"success",...}); the GitHub collector additionally writes
// data/collect-github-run.json with what it discovered and what failed.
function readCollectorOutcomes(env) {
  if (!env.COLLECTOR_OUTCOMES) return null;
  try {
    const o = JSON.parse(env.COLLECTOR_OUTCOMES);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function readGithubRun(dataDir, today) {
  const p = path.join(dataDir, 'collect-github-run.json');
  if (!fs.existsSync(p)) return null;
  try {
    const run = JSON.parse(fs.readFileSync(p, 'utf8'));
    return run && run.date === today ? run : null;
  } catch {
    return null;
  }
}

function buildCollectors(db, { dataDir, env, today }) {
  const outcomes = readCollectorOutcomes(env);
  const githubRun = readGithubRun(dataDir, today);
  const collectors = {};
  for (const name of COLLECTORS) {
    const outcome = outcomes ? outcomes[name] : undefined;
    const ran = outcome === 'success' || outcome === 'failure';
    collectors[name] = {
      ran,
      ok: ran ? outcome === 'success' : null,
      error: outcome === 'failure' ? `collector step failed (see the '${name}' step in the workflow run)` : null,
    };
  }

  // GitHub coverage: what discovery returned vs what reached traffic_summary
  // today, and which live canonical repos have no row for yesterday.
  const g = collectors.github;
  const live = db.prepare(`
    SELECT id, full_name FROM repositories
    WHERE COALESCE(canonical_full_name, full_name) = full_name AND archived = 0
    ORDER BY full_name
  `).all();
  const rowsFor = db.prepare('SELECT COUNT(DISTINCT repo_id) AS n FROM traffic_summary WHERE date = ?');
  const yesterday = db.prepare("SELECT date(?, '-1 day') AS d").get(today).d;
  const hasRow = db.prepare('SELECT 1 FROM traffic_summary WHERE repo_id = ? AND date = ?');
  g.reposDiscovered = githubRun ? githubRun.reposDiscovered : null;
  g.reposCollectedToday = rowsFor.get(today).n;
  g.reposLagging = live.filter(r => !hasRow.get(r.id, yesterday)).map(r => r.full_name);
  g.reposFailed = githubRun ? (githubRun.failed || []) : [];
  // Public repos the token cannot read traffic for (403). Surfaced so the
  // coverage gate can name them; they still count toward the discovered gap
  // until declared in TRAFFIC_MISSING_ALLOWLIST (a denied repo is a fact to
  // declare, never a healthy value).
  g.trafficDenied = githubRun ? (githubRun.trafficDenied || []) : [];
  if (githubRun && g.reposFailed.length > 0) {
    g.ok = false;
    g.error = `${g.reposFailed.length} repositories failed to collect: ${g.reposFailed.map(f => f.repo).join(', ')}`;
  }
  if (githubRun && !g.ran) {
    // The run file proves the collector ran today even without step outcomes
    // (e.g. a local run of the whole pipeline).
    g.ran = true;
    if (g.ok === null) g.ok = g.reposFailed.length === 0;
  }
  return collectors;
}

// PyPI geo (BigQuery country) collector status: read from the per-run record
// the collector persists (data/pypi-country-run.json), deliberately not from
// COLLECTOR_OUTCOMES so it is buildable without a workflow change. The as-of
// is the newest stored closed day in pypi_country_daily; an absent record
// still emits the key so consumers see "not_collected" rather than nothing.
// A record whose status is outside the collector's set reports "error" so a
// corrupt or tampered file cannot smuggle an arbitrary string downstream.
const PYPI_GEO_STATUSES = new Set([
  'ok', 'empty', 'skipped_no_credentials', 'refused_cap', 'capped_month', 'error',
]);
function buildPypiGeo(db, dataDir) {
  const p = path.join(dataDir, 'pypi-country-run.json');
  let record = null;
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed.status === 'string') record = parsed;
    } catch {
      record = null;
    }
  }
  if (!record) return { status: 'not_collected', asOf: null };
  let asOf = record.asOf ?? null;
  if (tableExists(db, 'pypi_country_daily')) {
    const r = db.prepare('SELECT MAX(date) AS d FROM pypi_country_daily').get();
    if (r.d) asOf = r.d;
  }
  const status = PYPI_GEO_STATUSES.has(record.status) ? record.status : 'error';
  return { status, asOf };
}

function seriesStatus(collectors, sources) {
  for (const name of sources) {
    const c = collectors[name];
    if (!c || c.ran !== true || c.ok !== true) return 'partial';
  }
  return 'ok';
}

/**
 * Build the summary object. `db` is an open better-sqlite3 handle (read-only
 * is fine). Options: dataDir (for the GitHub run file), env, now.
 */
function buildSummary(db, { dataDir, env = process.env, now = new Date() } = {}) {
  dataDir = dataDir || path.join(__dirname, '..', 'data');
  const today = now.toISOString().split('T')[0];

  // npm totals
  const npmTotal = db.prepare('SELECT COALESCE(SUM(downloads), 0) as total FROM npm_downloads').get();
  const npmExCrypto = db.prepare(`
    SELECT COALESCE(SUM(d.downloads), 0) as total
    FROM npm_packages p JOIN npm_downloads d ON p.id = d.package_id
    WHERE p.name != 'cryptoserve'
  `).get();

  // PyPI totals
  const pypiTotal = db.prepare('SELECT COALESCE(SUM(downloads), 0) as total FROM pypi_downloads').get();
  const pypiExCrypto = db.prepare(`
    SELECT COALESCE(SUM(d.downloads), 0) as total
    FROM pypi_packages p JOIN pypi_downloads d ON p.id = d.package_id
    WHERE p.name NOT LIKE 'cryptoserve%'
  `).get();

  // GitHub clones and views: additive daily counts, collapsed per (canonical
  // repo, date) so a transferred/renamed repo's overlapping twin rows count
  // once. See lib/repos.js. Raw clones are a term of the gross `downloads`
  // series; `adoption` uses the 14-day distinct-cloner snapshot instead.
  const traffic = canonicalTrafficTotals(db);
  const trafficExCrypto = canonicalTrafficTotals(db, { excludeCanonical: CRYPTO_REPO });
  const clonesTotal = { total: traffic.clones };
  const clonesExCrypto = { total: trafficExCrypto.clones };
  const viewsTotal = { total: traffic.views };

  // cryptoserve's own 14-day distinct cloners, to subtract for the ex-crypto total.
  const cryptoUniqueCloners = db.prepare(`
    SELECT COALESCE(clones_uniques, 0) AS u
    FROM traffic_summary ts JOIN repositories r ON r.id = ts.repo_id
    WHERE r.full_name = ?
    ORDER BY ts.date DESC LIMIT 1
  `).get(CRYPTO_REPO);

  // Docker totals: latest pull_count per image, summed across images — matching
  // the dashboard (pages/api/overview.js).
  const dockerTotal = db.prepare(`
    SELECT COALESCE(SUM(p), 0) AS total FROM (
      SELECT (SELECT pull_count FROM docker_pulls dp2
              WHERE dp2.image_id = dp.image_id ORDER BY date DESC LIMIT 1) AS p
      FROM docker_pulls dp GROUP BY dp.image_id
    )
  `).get();

  // HuggingFace model downloads: latest all-time count per model, summed —
  // matching the dashboard.
  const hfTotal = tableExists(db, 'huggingface_stats') ? db.prepare(`
    SELECT COALESCE(SUM(d), 0) AS total FROM (
      SELECT (SELECT downloads_all_time FROM huggingface_stats h2
              WHERE h2.model_id = h.model_id ORDER BY date DESC LIMIT 1) AS d
      FROM huggingface_stats h GROUP BY h.model_id
    )
  `).get() : { total: 0 };

  // Stars + repo count, one per canonical repo (twins collapsed). See lib/repos.js.
  const canonTotals = canonicalRepoTotals(db);
  const starsTotal = { total: canonTotals.stars };
  const repoCount = { count: canonTotals.repoCount };

  // Distinct cloners = GitHub's rolling 14-day distinct-cloner snapshot, taken
  // from each canonical repo's latest traffic_summary row — identical to the
  // dashboard's totals.github.totalCloneUniques. NOT SUM(daily uniques) and NOT
  // a sum across twin rows. See lib/adoption.js.
  const cloneUniquesTotal = { total: canonTotals.uniqueCloners };
  const cloneUniquesExCrypto = { total: canonTotals.uniqueCloners - (cryptoUniqueCloners?.u || 0) };

  // Chrome Web Store weekly-active users (latest snapshot per extension,
  // summed). Not a download count; excluded from every series.
  let chromeUsers = 0, chromeExtCount = 0;
  if (tableExists(db, 'chrome_extensions')) {
    const exts = db.prepare('SELECT id FROM chrome_extensions').all();
    chromeExtCount = exts.length;
    const latestUsers = db.prepare('SELECT users FROM chrome_stats WHERE extension_id = ? ORDER BY date DESC LIMIT 1');
    for (const e of exts) chromeUsers += latestUsers.get(e.id)?.users || 0;
  }

  // First-party CLI telemetry — ACTIVE USERS (distinct installs over rolling
  // windows), from the Registry's coarse public adoption feed. Not a download
  // count; excluded from every series. Latest snapshot only.
  let telemetry = null;
  if (tableExists(db, 'telemetry_snapshots')) {
    const latest = db.prepare(
      'SELECT date, total_installs, wau, mau, engaged_mau, provenance FROM telemetry_snapshots ORDER BY date DESC LIMIT 1'
    ).get();
    if (latest) {
      const toolCount = db.prepare('SELECT COUNT(*) as count FROM telemetry_tool_snapshots WHERE date = ?').get(latest.date);
      const countryCount = db.prepare('SELECT COUNT(*) as count FROM telemetry_country_snapshots WHERE date = ?').get(latest.date);
      telemetry = {
        asOf: latest.date,
        totalInstalls: latest.total_installs,
        wau: latest.wau,
        mau: latest.mau,
        engagedMau: latest.engaged_mau ?? 0,
        tools: toolCount?.count || 0,
        countries: countryCount?.count || 0,
        provenance: latest.provenance || '',
      };
    }
  }

  const npmPkgCount = db.prepare('SELECT COUNT(*) as count FROM npm_packages').get();

  // adoption: package/image/model download events + current 14-day distinct
  // cloners (mixed-window sum). Same formula as the dashboard's
  // combined.totalAdoption and series.adoption in overview.js.
  const totalAll = npmTotal.total + pypiTotal.total + cloneUniquesTotal.total + dockerTotal.total + hfTotal.total;
  const totalExCrypto = npmExCrypto.total + pypiExCrypto.total + cloneUniquesExCrypto.total + dockerTotal.total + hfTotal.total;

  // downloads: gross download events — npm + PyPI + Docker pulls + git clones
  // (raw, twin-collapsed) + HF model downloads. Views are never included.
  const downloadsAll = npmTotal.total + pypiTotal.total + clonesTotal.total + dockerTotal.total + hfTotal.total;
  const downloadsExCrypto = npmExCrypto.total + pypiExCrypto.total + clonesExCrypto.total + dockerTotal.total + hfTotal.total;

  // Windows, read from the data.
  const win = {
    npm: dateRange(db, 'npm_downloads'),
    pypi: dateRange(db, 'pypi_downloads'),
    clones: dateRange(db, 'traffic_clones'),
    docker: dateRange(db, 'docker_pulls'),
    huggingface: dateRange(db, 'huggingface_stats'),
    cloneUniques: dateRange(db, 'traffic_summary'),
  };
  // The definitions carry dated clauses; refuse to publish a definition that
  // disagrees with the database it describes.
  for (const [k, typed] of Object.entries(DEFINITION_FIRST_DATES)) {
    if (win[k].first && win[k].first !== typed) {
      throw new Error(`series definition says ${k} rows start ${typed} but the database starts ${win[k].first}`);
    }
  }
  const pypiNote = 'pypistats serves 180 days; rows before the first collection are unrecoverable, no backfill exists';
  const windowFor = (keys) => {
    const w = {};
    for (const k of keys) {
      w[k] = k === 'docker' || k === 'huggingface'
        ? { kind: 'cumulative-snapshot', firstSnapshot: win[k].first, asOf: win[k].asOf }
        : k === 'cloneUniques'
          ? { kind: 'rolling-14-day-snapshot', firstSnapshot: win[k].first, asOf: win[k].asOf }
          : { kind: 'daily-rows', first: win[k].first, asOf: win[k].asOf, ...(k === 'pypi' ? { note: pypiNote } : {}) };
    }
    return w;
  };

  const collectors = buildCollectors(db, { dataDir, env, today });

  const componentsFor = (variant, kind) => {
    const npm = variant === 'all' ? npmTotal.total : npmExCrypto.total;
    const pypi = variant === 'all' ? pypiTotal.total : pypiExCrypto.total;
    const base = { npm, pypi, docker: dockerTotal.total, huggingface: hfTotal.total };
    if (kind === 'downloads') base.clones = variant === 'all' ? clonesTotal.total : clonesExCrypto.total;
    else base.cloneUniques = variant === 'all' ? cloneUniquesTotal.total : cloneUniquesExCrypto.total;
    return base;
  };
  const values = { downloads: downloadsAll, downloadsExCrypto, adoption: totalAll, adoptionExCrypto: totalExCrypto };
  const series = {};
  for (const key of SERIES_KEYS) {
    const def = SERIES[key];
    const kind = key.startsWith('downloads') ? 'downloads' : 'adoption';
    const variant = def.includesCryptoServe ? 'all' : 'exCrypto';
    const windowKeys = kind === 'downloads'
      ? ['npm', 'pypi', 'docker', 'huggingface', 'clones']
      : ['npm', 'pypi', 'docker', 'huggingface', 'cloneUniques'];
    series[key] = {
      value: values[key],
      scope: def.scope,
      includesCryptoServe: def.includesCryptoServe,
      method: def.method,
      definition: def.definition,
      window: windowFor(windowKeys),
      components: componentsFor(variant, kind),
      status: seriesStatus(collectors, def.sources),
    };
  }

  return {
    lastUpdated: now.toISOString(),
    total: {
      adoption: totalAll,
      adoptionExCrypto: totalExCrypto,
      downloads: downloadsAll,
      downloadsExCrypto,
      npm: npmTotal.total,
      pypi: pypiTotal.total,
      cloneUniques: cloneUniquesTotal.total,
      clones: clonesTotal.total,
      docker: dockerTotal.total,
      hf: hfTotal.total,
      views: viewsTotal.total,
      stars: starsTotal.total,
      repos: repoCount.count,
      npmPackages: npmPkgCount.count,
      chromeUsers,
      chromeExtensions: chromeExtCount,
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
    series,
    collectors,
    pypiGeo: buildPypiGeo(db, dataDir),
  };
}

module.exports = { buildSummary, COLLECTORS, seriesStatus };
