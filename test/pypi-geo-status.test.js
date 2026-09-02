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

const tmp = () => fs.mkdtempSync(path.join(tmpdir(), 'pypi-geo-'));
const noop = () => {};

function makeStore(dir, { fetchedDays = [] } = {}) {
  const p = path.join(dir, 'analytics.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE pypi_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE pypi_country_fetch_days (
      date TEXT PRIMARY KEY, row_count INTEGER NOT NULL DEFAULT 0,
      bytes_billed INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL);
  `);
  const ins = db.prepare('INSERT INTO pypi_packages (name) VALUES (?)');
  for (const name of SEVEN) ins.run(name);
  const insFetch = db.prepare('INSERT INTO pypi_country_fetch_days (date, row_count, bytes_billed, fetched_at) VALUES (?, 0, 0, ?)');
  for (const d of fetchedDays) insFetch.run(d, NOW.toISOString());
  db.close();
  return p;
}

function fakeClient({ dryBytes = 1000, billedBytes = 1000, rows = [], fail = false } = {}) {
  return {
    async query(options) {
      if (fail) throw new Error('injected client failure');
      if (options.dryRun) return { rows: [], totalBytesProcessed: dryBytes };
      return { rows, totalBytesProcessed: billedBytes };
    },
  };
}

function readStatus(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, RUN_FILE), 'utf8'));
}

function assertRecordShape(record) {
  assert.deepEqual(Object.keys(record).sort(), ['asOf', 'bytesBilled', 'daysFetched', 'runAt', 'status']);
  assert.ok(['ok', 'empty', 'skipped_no_credentials', 'refused_cap', 'capped_month', 'error'].includes(record.status),
    `unexpected status ${record.status}`);
  assert.ok(!Number.isNaN(Date.parse(record.runAt)));
  assert.ok(Number.isInteger(record.daysFetched));
  assert.ok(Number.isInteger(record.bytesBilled));
}

// ---------------------------------------------------------------------------
// AC6 — every run persists a status record; each status path lands its value
// ---------------------------------------------------------------------------

test('GAT-01.AC6 a fetching run persists status ok with asOf, daysFetched and bytesBilled', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1)) });
    const client = fakeClient({ rows: [{ project: 'cryptoserve', country_code: 'US', downloads: 3 }], billedBytes: 777 });
    const res = await collect({ client, dbPath, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 0);
    const record = readStatus(dir);
    assertRecordShape(record);
    assert.equal(record.status, 'ok');
    assert.equal(record.asOf, dayBefore(1), 'asOf is the newest stored closed day');
    assert.equal(record.daysFetched, 1);
    assert.equal(record.bytesBilled, 777);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC6 a run whose every selected day is empty persists status empty', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1)) });
    const res = await collect({ client: fakeClient({ rows: [] }), dbPath, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 0);
    const record = readStatus(dir);
    assertRecordShape(record);
    assert.equal(record.status, 'empty');
    assert.equal(record.asOf, null, 'no stored day yet: asOf is null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC6 cap refusals persist refused_cap and capped_month', async () => {
  for (const [setup, expected] of [
    [{ dryBytes: 137438953473 }, 'refused_cap'],
    [{ dryBytes: 1, seedMonth: true }, 'capped_month'],
  ]) {
    const dir = tmp();
    try {
      const dbPath = makeStore(dir);
      if (setup.seedMonth) {
        fs.writeFileSync(path.join(dir, BUDGET_FILE), JSON.stringify({
          month: '2026-09', bytesBilled: 824633720832, updatedAt: '2026-09-01T06:00:00.000Z',
        }));
      }
      const res = await collect({ client: fakeClient(setup), dbPath, now: NOW, env: {}, log: noop });
      assert.equal(res.exitCode, 1);
      const record = readStatus(dir);
      assertRecordShape(record);
      assert.equal(record.status, expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('GAT-01.AC6 no credentials persists skipped_no_credentials (exit 1 only under Actions)', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const local = await collect({ dbPath, now: NOW, env: {}, log: noop });
    assert.equal(local.exitCode, 0);
    assert.equal(readStatus(dir).status, 'skipped_no_credentials');
    assertRecordShape(readStatus(dir));
    const scheduled = await collect({ dbPath, now: NOW, env: { GITHUB_ACTIONS: 'true' }, log: noop });
    assert.equal(scheduled.exitCode, 1);
    assert.equal(readStatus(dir).status, 'skipped_no_credentials');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC6 a client failure persists status error and exits 1', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const res = await collect({ client: fakeClient({ fail: true }), dbPath, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 1);
    const record = readStatus(dir);
    assertRecordShape(record);
    assert.equal(record.status, 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC6 — lib/summary.js surfaces pypiGeo from the persisted record
// ---------------------------------------------------------------------------

test('GAT-01.AC6 buildSummary emits pypiGeo from the run record, asOf from MAX(date) of pypi_country_daily', () => {
  const dir = tmp();
  try {
    // Fixture db: the committed database plus a pypi_country_daily table, so
    // the summary's asOf comes from MAX(date) rather than the record.
    const fixtureDb = path.join(dir, 'analytics.db');
    fs.copyFileSync(COMMITTED_DB, fixtureDb);
    const db = new Database(fixtureDb);
    db.exec(`CREATE TABLE IF NOT EXISTS pypi_country_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL, date TEXT NOT NULL,
      country_code TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0,
      UNIQUE(package_id, date, country_code));`);
    db.prepare('INSERT INTO pypi_country_daily (package_id, date, country_code, downloads) VALUES (1, ?, ?, 4)')
      .run('2026-08-30', 'US');
    db.prepare('INSERT INTO pypi_country_daily (package_id, date, country_code, downloads) VALUES (1, ?, ?, 4)')
      .run('2026-08-31', 'US');
    fs.writeFileSync(path.join(dir, RUN_FILE), JSON.stringify({
      status: 'ok', asOf: '2026-08-29', runAt: '2026-09-01T06:00:00.000Z', daysFetched: 2, bytesBilled: 1234,
    }));
    const summary = buildSummary(db, { dataDir: dir, env: {} });
    db.close();
    assert.deepEqual(summary.pypiGeo, { status: 'ok', asOf: '2026-08-31' },
      'status from the record, asOf from MAX(date) of pypi_country_daily');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC6 buildSummary without the record emits not_collected, never omits pypiGeo', () => {
  const dir = tmp();
  try {
    const db = new Database(COMMITTED_DB, { readonly: true });
    const summary = buildSummary(db, { dataDir: dir, env: {} });
    db.close();
    assert.deepEqual(summary.pypiGeo, { status: 'not_collected', asOf: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC6 — the API payload carries countryAsOf next to countryDownloads
// ---------------------------------------------------------------------------

function makeApiFixture(dir, { countryRows = [] } = {}) {
  const p = path.join(dir, 'analytics.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE pypi_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE pypi_downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER, date TEXT, downloads INTEGER);
    CREATE TABLE pypi_country_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL, date TEXT NOT NULL,
      country_code TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0,
      UNIQUE(package_id, date, country_code));
  `);
  db.prepare('INSERT INTO pypi_packages (name) VALUES (?)').run('cryptoserve');
  db.prepare('INSERT INTO pypi_downloads (package_id, date, downloads) VALUES (1, ?, 11)').run('2026-08-31');
  const ins = db.prepare('INSERT INTO pypi_country_downloads (package_id, date, country_code, downloads) VALUES (1, ?, ?, ?)');
  for (const r of countryRows) ins.run(r.date, r.cc, r.dl);
  db.close();
  return p;
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}

test('GAT-01.AC6 pypi-stats API returns countryAsOf beside countryDownloads', async () => {
  const dir = tmp();
  try {
    const dbPath = makeApiFixture(dir, {
      countryRows: [
        { date: '2026-08-30', cc: 'US', dl: 9 },
        { date: '2026-08-31', cc: 'US', dl: 12 },
        { date: '2026-08-31', cc: 'DE', dl: 3 },
      ],
    });
    const { default: handler } = await import(pathToFileURL(path.join(ROOT, 'pages', 'api', 'pypi-stats.js')).href);
    const prev = process.env.ANALYTICS_DB_PATH;
    process.env.ANALYTICS_DB_PATH = dbPath;
    try {
      const res = mockRes();
      handler({ query: { package_id: '1' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.countryAsOf, '2026-08-31', 'countryAsOf is MAX(date) for the package');
      assert.deepEqual(res.body.countryDownloads.map(r => ({ ...r })), [
        { countryCode: 'US', downloads: 12 },
        { countryCode: 'DE', downloads: 3 },
      ], 'countryDownloads still reads the latest snapshot only');
    } finally {
      if (prev === undefined) delete process.env.ANALYTICS_DB_PATH; else process.env.ANALYTICS_DB_PATH = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC6 pypi-stats API returns countryAsOf null when no country rows exist', async () => {
  const dir = tmp();
  try {
    const dbPath = makeApiFixture(dir, { countryRows: [] });
    const { default: handler } = await import(pathToFileURL(path.join(ROOT, 'pages', 'api', 'pypi-stats.js')).href);
    const prev = process.env.ANALYTICS_DB_PATH;
    process.env.ANALYTICS_DB_PATH = dbPath;
    try {
      const res = mockRes();
      handler({ query: { package_id: '1' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.countryAsOf, null);
      assert.deepEqual(res.body.countryDownloads, []);
    } finally {
      if (prev === undefined) delete process.env.ANALYTICS_DB_PATH; else process.env.ANALYTICS_DB_PATH = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
