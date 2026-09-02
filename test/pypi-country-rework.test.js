/**
 * GAT-01 rework r4: the negative criteria from the r3 adversarial review.
 *
 * AC9  — the caps fail closed on an unreadable dry-run estimate.
 * AC10 — the month ledger can only over-count a billed query, never
 *        under-count one (reservation before the billed call; a billed figure
 *        that is not a finite non-negative number charges the estimate).
 * AC11 — the rollup replaces the whole pypi_country_downloads table so no
 *        stale snapshot at another date can shadow it through MAX(date).
 *
 * Every test here is red at a7d96361 (the r3 delivery) and green at the
 * delivered commit.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');

const { collect, BUDGET_FILE, RUN_FILE } = require('../scripts/collect-pypi-country-stats');
const { buildSummary } = require('../lib/summary');

const ROOT = path.join(__dirname, '..');
const COMMITTED_DB = path.join(ROOT, 'data', 'analytics.db');

const SEVEN = [
  'cryptoserve', 'cryptoserve-core', 'cryptoserve-auto', 'cryptoserve-client',
  'aim-sdk', 'aicomply', 'nanomind-analyst',
];
const NOW = new Date('2026-09-02T12:34:56Z');
const DAY_MS = 86400000;
const dayBefore = (n) => new Date(Date.UTC(2026, 8, 2) - n * DAY_MS).toISOString().slice(0, 10);
const ALL_CANDIDATES = Array.from({ length: 30 }, (_, i) => dayBefore(i + 1));

const tmp = () => fs.mkdtempSync(path.join(tmpdir(), 'pypi-rework-'));
const noop = () => {};

function makeStore(dir, { fetchedDays = [], daily = [], rollup = [] } = {}) {
  const p = path.join(dir, 'analytics.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE pypi_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE pypi_downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER, date TEXT, downloads INTEGER);
    CREATE TABLE pypi_country_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL, date TEXT NOT NULL,
      country_code TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0,
      UNIQUE(package_id, date, country_code));
    CREATE TABLE pypi_country_fetch_days (
      date TEXT PRIMARY KEY, row_count INTEGER NOT NULL DEFAULT 0,
      bytes_billed INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL);
    CREATE TABLE pypi_country_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL, date TEXT NOT NULL,
      country_code TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0,
      UNIQUE(package_id, date, country_code));
  `);
  const insPkg = db.prepare('INSERT INTO pypi_packages (name) VALUES (?)');
  for (const name of SEVEN) insPkg.run(name);
  const insFetch = db.prepare('INSERT INTO pypi_country_fetch_days (date, row_count, bytes_billed, fetched_at) VALUES (?, 0, 0, ?)');
  for (const d of fetchedDays) insFetch.run(d, NOW.toISOString());
  const insDaily = db.prepare('INSERT INTO pypi_country_daily (package_id, date, country_code, downloads) VALUES (?, ?, ?, ?)');
  for (const r of daily) insDaily.run(r.pkg, r.date, r.cc, r.dl);
  const insRollup = db.prepare('INSERT INTO pypi_country_downloads (package_id, date, country_code, downloads) VALUES (?, ?, ?, ?)');
  for (const r of rollup) insRollup.run(r.pkg, r.date, r.cc, r.dl);
  db.close();
  return p;
}

/**
 * Fake client for the collector's port. dryBytes may be any value (including
 * the unreadable ones AC9 exercises); billedBytes likewise; billedThrows makes
 * every billed call reject; onBilled observes the moment a billed call runs.
 */
function fakeClient(opts = {}) {
  // `in` checks, not destructuring defaults: AC9 passes dryBytes: undefined
  // on purpose and the fake must return it verbatim.
  const dryBytes = 'dryBytes' in opts ? opts.dryBytes : 1000;
  const billedBytes = 'billedBytes' in opts ? opts.billedBytes : 1000;
  const { rows = [], billedThrows = false, onBilled = null } = opts;
  const calls = [];
  return {
    calls,
    dry: () => calls.filter(c => c.dryRun),
    billed: () => calls.filter(c => !c.dryRun),
    async query(options) {
      calls.push(options);
      if (options.dryRun) return { rows: [], totalBytesProcessed: dryBytes };
      if (onBilled) onBilled(options);
      if (billedThrows) throw new Error('injected billed-call failure');
      return { rows, totalBytesProcessed: billedBytes };
    },
  };
}

function readStatus(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, RUN_FILE), 'utf8'));
}

function readBudgetFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, BUDGET_FILE), 'utf8'));
}

function seedBudget(dir, bytesBilled) {
  fs.writeFileSync(path.join(dir, BUDGET_FILE), JSON.stringify({
    month: '2026-09', bytesBilled, updatedAt: '2026-09-01T06:00:00.000Z',
  }));
}

/** A store where only D-1 is missing, so exactly one day is selected. */
function oneMissingDay(dir, extra = {}) {
  return makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1)), ...extra });
}

// ---------------------------------------------------------------------------
// AC9 — the caps fail closed on an unreadable estimate
// ---------------------------------------------------------------------------

for (const [label, badEstimate] of [['undefined', undefined], ['a non-numeric string', 'abc'], ['a negative number', -1]]) {
  test(`GAT-01.AC9 a dry run reporting ${label} bills nothing, persists error and exits 1`, async () => {
    const dir = tmp();
    try {
      const dbPath = oneMissingDay(dir);
      const client = fakeClient({ dryBytes: badEstimate });
      const res = await collect({ client, dbPath, now: NOW, env: {}, log: noop });
      assert.equal(res.exitCode, 1, 'an unreadable estimate must not compare as 0 and bill');
      assert.equal(res.status, 'error');
      assert.equal(client.dry().length, 1);
      assert.equal(client.billed().length, 0, 'zero billed calls after the unreadable dry run');
      assert.equal(readStatus(dir).status, 'error');
      assert.ok(!fs.existsSync(path.join(dir, BUDGET_FILE)),
        'nothing was reserved or billed, so no ledger is written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// AC10 — the ledger can only over-count a billed query, never under-count
// ---------------------------------------------------------------------------

test('GAT-01.AC10 the ledger holds month-to-date plus the estimate before the billed call is issued', async () => {
  const dir = tmp();
  try {
    const dbPath = oneMissingDay(dir);
    seedBudget(dir, 1000);
    let ledgerAtBilledCall = null;
    const client = fakeClient({
      dryBytes: 5000,
      billedBytes: 4000,
      onBilled: () => { ledgerAtBilledCall = readBudgetFile(dir).bytesBilled; },
    });
    const res = await collect({ client, dbPath, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 0);
    assert.equal(ledgerAtBilledCall, 6000,
      'the reservation (prior 1000 + estimate 5000) is on disk before the billed call');
    assert.equal(readBudgetFile(dir).bytesBilled, 5000,
      'after resolution the actual billed figure replaces the reservation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC10 a billed call that throws leaves the ledger at prior month-to-date plus the estimate', async () => {
  const dir = tmp();
  try {
    const dbPath = oneMissingDay(dir);
    seedBudget(dir, 1000);
    const client = fakeClient({ dryBytes: 5000, billedThrows: true });
    const res = await collect({ client, dbPath, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 1);
    assert.equal(res.status, 'error');
    const budget = readBudgetFile(dir);
    assert.deepEqual(Object.keys(budget).sort(), ['bytesBilled', 'month', 'updatedAt'],
      'the AC3 three-key shape is unchanged');
    assert.equal(budget.month, '2026-09');
    assert.equal(budget.bytesBilled, 6000,
      'the reservation stands: the job may have run, so the estimate stays charged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, badBilled] of [['-500', -500], ['"abc"', 'abc']]) {
  test(`GAT-01.AC10 a billed figure of ${label} charges the estimate, never less`, async () => {
    const dir = tmp();
    try {
      const dbPath = oneMissingDay(dir);
      const client = fakeClient({ dryBytes: 5000, billedBytes: badBilled });
      const res = await collect({ client, dbPath, now: NOW, env: {}, log: noop });
      assert.equal(res.exitCode, 0);
      const budget = readBudgetFile(dir);
      assert.deepEqual(Object.keys(budget).sort(), ['bytesBilled', 'month', 'updatedAt']);
      assert.equal(budget.bytesBilled, 5000, 'the unreadable billed figure charges the estimate');
      assert.equal(readStatus(dir).bytesBilled, 5000, 'the run record carries the same charge');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// AC11 — the rollup replaces the whole table; no stale date shadows MAX(date)
// ---------------------------------------------------------------------------

test('GAT-01.AC11 a stale row dated after the as-of is gone after the rollup and countryAsOf equals the as-of', async () => {
  const dir = tmp();
  try {
    // Rollup-only run: every candidate fetched, daily rows stored for two
    // closed days, and two stale snapshots — one dated AFTER the as-of (the
    // base collector's run-date convention) that would win MAX(date), one
    // dated long before it.
    const dbPath = makeStore(dir, {
      fetchedDays: ALL_CANDIDATES,
      daily: [
        { pkg: 1, date: dayBefore(1), cc: 'US', dl: 10 },
        { pkg: 1, date: dayBefore(2), cc: 'US', dl: 20 },
      ],
      rollup: [
        { pkg: 1, date: '2026-09-02', cc: 'FR', dl: 888 },
        { pkg: 1, date: '2026-08-01', cc: 'FR', dl: 999 },
      ],
    });
    const client = fakeClient();
    const res = await collect({ client, dbPath, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 0);
    assert.equal(res.asOf, dayBefore(1));
    assert.equal(client.calls.length, 0, 'the rollup issues no client call');

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT package_id, date, country_code, downloads FROM pypi_country_downloads').all();
    db.close();
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { package_id: 1, date: dayBefore(1), country_code: 'US', downloads: 30 },
    ], 'only the as-of rollup rows survive; both stale snapshots are gone');

    // The MAX(date) consumer sees the rollup, not the stale 2026-09-02 row.
    const { default: handler } = await import(pathToFileURL(path.join(ROOT, 'pages', 'api', 'pypi-stats.js')).href);
    const prev = process.env.ANALYTICS_DB_PATH;
    process.env.ANALYTICS_DB_PATH = dbPath;
    try {
      const apiRes = { statusCode: null, body: null };
      apiRes.status = (code) => { apiRes.statusCode = code; return apiRes; };
      apiRes.json = (obj) => { apiRes.body = obj; return apiRes; };
      handler({ query: { package_id: '1' } }, apiRes);
      assert.equal(apiRes.statusCode, 200);
      assert.equal(apiRes.body.countryAsOf, dayBefore(1), "the API's countryAsOf equals the as-of");
    } finally {
      if (prev === undefined) delete process.env.ANALYTICS_DB_PATH; else process.env.ANALYTICS_DB_PATH = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC6 hardening carried in the rework brief (review findings 9 and 12)
// ---------------------------------------------------------------------------

test('GAT-01.AC6 a missing data directory is created so every exit path can write the status file', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const nested = path.join(dir, 'not', 'yet', 'there');
    const client = fakeClient();
    const res = await collect({ client, dbPath, dataDir: nested, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(nested, RUN_FILE), 'utf8')).status, res.status);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC6 buildSummary reports error for a run record whose status is outside the collector set', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, RUN_FILE), JSON.stringify({
      status: 'bogus', asOf: null, runAt: '2026-09-01T06:00:00.000Z', daysFetched: 0, bytesBilled: 0,
    }));
    const db = new Database(COMMITTED_DB, { readonly: true });
    const summary = buildSummary(db, { dataDir: dir, env: {} });
    db.close();
    assert.deepEqual(summary.pypiGeo, { status: 'error', asOf: null },
      'an arbitrary status string is not passed through');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
