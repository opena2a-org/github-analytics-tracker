const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { SERIES, SERIES_KEYS, DEFINITION_FIRST_DATES } = require('../lib/series');
const { buildSummary, seriesStatus } = require('../lib/summary');
const { checkRun } = require('../scripts/verify-run');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'analytics.db');

/*
 * Two surfaces publish the headline series: data/summary.json (built by
 * lib/summary.js from SQL) and the overview API (pages/api/overview.js, built
 * from the collapsed per-repo rows the dashboard renders). Both read the
 * registry in lib/series.js. These tests hold them together: same value per
 * key, labels only from the registry, and no page calling adoption
 * "deduplicated".
 */

test('registry: every series has key, label, method, scope, definition', () => {
  assert.deepStrictEqual(SERIES_KEYS, ['downloads', 'downloadsExCrypto', 'adoption', 'adoptionExCrypto']);
  for (const key of SERIES_KEYS) {
    const s = SERIES[key];
    assert.strictEqual(s.key, key);
    for (const f of ['label', 'method', 'scope', 'definition']) {
      assert.ok(typeof s[f] === 'string' && s[f].length > 0, `${key}.${f}`);
    }
    assert.ok(['tracked-orgs', 'tracked-orgs-ex-cryptoserve'].includes(s.scope), `${key}.scope`);
    assert.strictEqual(s.includesCryptoServe, s.scope === 'tracked-orgs');
    assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
  }
  assert.ok(!/dedup/i.test(SERIES.adoption.label), 'adoption label must not say deduplicated');
  assert.ok(!/dedup/i.test(SERIES.adoptionExCrypto.label));
  assert.ok(/excluding/.test(SERIES.downloadsExCrypto.definition) && /excluding/.test(SERIES.adoptionExCrypto.definition));
});

test('summary.total[key] === overview.series[key].value for every series key (committed database)', async () => {
  // Read-only against the committed DB.
  const db = new Database(DB_PATH, { readonly: true });
  let summary;
  try {
    summary = buildSummary(db, { env: {} });
  } finally {
    db.close();
  }

  const { computeOverview } = require('../lib/overview');
  const db2 = new Database(DB_PATH, { readonly: true });
  let overview;
  try {
    overview = computeOverview(db2, {});
  } finally {
    db2.close();
  }
  assert.ok(overview.series, 'overview exposes a series block');

  for (const key of SERIES_KEYS) {
    assert.strictEqual(typeof summary.total[key], 'number', `summary.total.${key}`);
    assert.strictEqual(summary.total[key], summary.series[key].value, `summary.total.${key} equals summary.series.${key}.value`);
    assert.strictEqual(summary.total[key], overview.series[key].value, `summary.total.${key} === overview.series.${key}.value`);
    assert.strictEqual(overview.series[key].label, SERIES[key].label, `overview label for ${key} comes from the registry`);
    assert.strictEqual(summary.series[key].definition, SERIES[key].definition);
    assert.strictEqual(summary.series[key].scope, SERIES[key].scope);
    assert.ok(['ok', 'partial'].includes(summary.series[key].status));
  }
  // The flat fields the website and Atlas consume are still there.
  for (const f of ['adoption', 'adoptionExCrypto', 'downloads', 'downloadsExCrypto', 'npm', 'pypi', 'clones', 'cloneUniques', 'docker', 'hf', 'views', 'stars', 'repos']) {
    assert.strictEqual(typeof summary.total[f], 'number', `total.${f}`);
  }
  // Overview totals that feed the dashboard agree with the summary's terms.
  assert.strictEqual(overview.totals.github.totalClones, summary.total.clones, 'twin-collapsed raw clones agree');
  assert.strictEqual(overview.totals.github.totalViews, summary.total.views, 'twin-collapsed views agree');
  assert.strictEqual(overview.totals.combined.totalAdoption, summary.total.adoption);
});

test('series windows are read from the database and match the dated definitions', () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const summary = buildSummary(db, { env: {} });
    const w = summary.series.downloads.window;
    const min = t => db.prepare(`SELECT MIN(date) AS d, MAX(date) AS m FROM ${t}`).get();
    assert.strictEqual(w.npm.first, min('npm_downloads').d);
    assert.strictEqual(w.npm.asOf, min('npm_downloads').m);
    assert.strictEqual(w.pypi.first, min('pypi_downloads').d);
    assert.strictEqual(w.clones.first, min('traffic_clones').d);
    assert.strictEqual(w.docker.firstSnapshot, min('docker_pulls').d);
    assert.strictEqual(w.huggingface.firstSnapshot, min('huggingface_stats').d);
    assert.ok(w.pypi.note && /180 days/.test(w.pypi.note), 'PyPI window carries the retention note');
    // The definitions' typed dates are the database's own first dates.
    assert.strictEqual(DEFINITION_FIRST_DATES.npm, w.npm.first);
    assert.strictEqual(DEFINITION_FIRST_DATES.pypi, w.pypi.first);
    assert.strictEqual(DEFINITION_FIRST_DATES.clones, w.clones.first);
    for (const key of SERIES_KEYS) {
      const def = SERIES[key].definition;
      for (const d of Object.values(DEFINITION_FIRST_DATES)) {
        if (key.startsWith('downloads')) assert.ok(def.includes(d), `${key} definition cites ${d}`);
      }
    }
    // adoption windows carry the 14-day cloner snapshot, downloads carry raw clones.
    assert.ok(summary.series.adoption.window.cloneUniques && !summary.series.adoption.window.clones);
    assert.ok(summary.series.downloads.window.clones && !summary.series.downloads.window.cloneUniques);
    assert.strictEqual(summary.series.adoption.components.cloneUniques, summary.total.cloneUniques);
    assert.strictEqual(summary.series.downloads.components.clones, summary.total.clones);
    assert.ok(summary.series.downloads.value > summary.series.adoption.value, 'gross downloads exceed the mixed-window adoption sum');
  } finally {
    db.close();
  }
});

test('a collector error never leaves a series "ok"', () => {
  const okAll = Object.fromEntries(['github', 'npm', 'pypi', 'docker', 'huggingface'].map(n => [n, { ran: true, ok: true, error: null }]));
  assert.strictEqual(seriesStatus(okAll, SERIES.downloads.sources), 'ok');
  assert.strictEqual(seriesStatus({ ...okAll, pypi: { ran: true, ok: false, error: 'x' } }, SERIES.downloads.sources), 'partial');
  assert.strictEqual(seriesStatus({ ...okAll, docker: { ran: false, ok: null, error: null } }, SERIES.adoption.sources), 'partial', 'a collector that did not run is not healthy');
  assert.strictEqual(seriesStatus({}, SERIES.adoption.sources), 'partial');
});

test('collectors block: step outcomes and the GitHub run record drive ran/ok/error', () => {
  const db = new Database(DB_PATH, { readonly: true });
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tracker-run-'));
  try {
    const today = new Date().toISOString().split('T')[0];
    fs.writeFileSync(path.join(dir, 'collect-github-run.json'), JSON.stringify({
      date: today, reposDiscovered: 45, repos: [], failed: [{ repo: 'o/x', error: 'HTTP 403' }],
    }));
    const env = { COLLECTOR_OUTCOMES: JSON.stringify({ github: 'success', npm: 'failure', pypi: 'success', docker: 'success', huggingface: 'success', chrome: 'success', telemetry: 'skipped' }) };
    const s = buildSummary(db, { dataDir: dir, env });
    assert.strictEqual(s.collectors.npm.ok, false);
    assert.match(s.collectors.npm.error, /npm/);
    assert.strictEqual(s.collectors.pypi.ok, true);
    assert.strictEqual(s.collectors.telemetry.ran, false, 'a skipped step did not run');
    assert.strictEqual(s.collectors.github.reposDiscovered, 45);
    assert.strictEqual(s.collectors.github.ok, false, 'a per-repo failure is a collector error');
    assert.match(s.collectors.github.error, /o\/x/);
    assert.strictEqual(typeof s.collectors.github.reposCollectedToday, 'number');
    assert.ok(Array.isArray(s.collectors.github.reposLagging));
    for (const key of SERIES_KEYS) assert.strictEqual(s.series[key].status, 'partial', `${key} partial after an npm failure`);

    // A stale run record (not today) is ignored: discovered unknown, not ran.
    fs.writeFileSync(path.join(dir, 'collect-github-run.json'), JSON.stringify({ date: '2000-01-01', reposDiscovered: 99, failed: [] }));
    const s2 = buildSummary(db, { dataDir: dir, env: {} });
    assert.strictEqual(s2.collectors.github.reposDiscovered, null);
    assert.strictEqual(s2.collectors.github.ran, false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-run: stale summary, failed collector, or uncovered repos fail the run', () => {
  const fresh = new Date('2026-08-25T06:00:00Z');
  const base = {
    lastUpdated: '2026-08-25T05:30:00Z',
    collectors: {
      github: { ran: true, ok: true, error: null, reposDiscovered: 45, reposCollectedToday: 44 },
      npm: { ran: true, ok: true, error: null },
    },
  };
  assert.deepStrictEqual(checkRun(base, { now: fresh, allowlist: ['o/private-ish'] }), []);
  assert.match(checkRun(base, { now: fresh, allowlist: [] })[0], /gap 1 exceeds the 0 allowlisted/);
  assert.match(checkRun({ ...base, lastUpdated: '2026-08-22T05:30:00Z' }, { now: fresh, allowlist: ['x'] })[0], /old \(limit 48h\)/);
  assert.match(checkRun({ ...base, collectors: { ...base.collectors, npm: { ran: true, ok: false, error: 'boom' } } }, { now: fresh, allowlist: ['x'] })[0], /collector npm failed: boom/);
  assert.match(checkRun({ collectors: {} }, { now: fresh })[0], /lastUpdated is missing/);
  // Unknown discovery (local run, no run record) cannot be judged and is not a failure.
  assert.deepStrictEqual(checkRun({ ...base, collectors: { github: { ran: false, ok: null, reposDiscovered: null, reposCollectedToday: 44 } } }, { now: fresh }), []);
});

test('pages render series only through the registry label, and never call adoption "deduplicated"', () => {
  const pagesDir = path.join(ROOT, 'pages');
  const files = fs.readdirSync(pagesDir).filter(f => f.endsWith('.js')).map(f => path.join(pagesDir, f));
  assert.ok(files.length > 0);
  let rendersSeries = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    // Every series rendered from the API must have its registry label in the same file.
    for (const key of SERIES_KEYS) {
      const renders = new RegExp(`series\\.${key}\\b`).test(src);
      if (!renders) continue;
      rendersSeries++;
      assert.ok(src.includes(`SERIES.${key}.label`), `${rel} renders series.${key} without SERIES.${key}.label`);
    }
    // No typed copy of a registry label.
    for (const key of SERIES_KEYS) {
      assert.ok(!src.includes(`'${SERIES[key].label}'`) && !src.includes(`"${SERIES[key].label}"`), `${rel} types the ${key} label instead of reading the registry`);
    }
    // The word "deduplicated" may not be attached to adoption anywhere.
    src.split('\n').forEach((line, i) => {
      if (/adoption/i.test(line) && /dedup/i.test(line)) {
        assert.fail(`${rel}:${i + 1} attaches "deduplicated" to adoption: ${line.trim()}`);
      }
    });
  }
  assert.ok(rendersSeries >= 2, 'the dashboard renders the downloads and adoption series');
  const index = fs.readFileSync(path.join(pagesDir, 'index.js'), 'utf8');
  assert.ok(!index.includes('Total ecosystem adoption'), 'the hero no longer reads "Total ecosystem adoption"');
  assert.ok(index.includes('SERIES.downloads.label'), 'the hero carries the downloads registry label');
});
