const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');

const {
  collect,
  PER_QUERY_CAP_BYTES,
  MONTH_CAP_BYTES,
  BUDGET_FILE,
  RUN_FILE,
} = require('../scripts/collect-pypi-country-stats');

const SCRIPT = join(__dirname, '..', 'scripts', 'collect-pypi-country-stats.js');

// The tracked population as committed in data/analytics.db (ids 1-7).
const SEVEN = [
  'cryptoserve', 'cryptoserve-core', 'cryptoserve-auto', 'cryptoserve-client',
  'aim-sdk', 'aicomply', 'nanomind-analyst',
];

// Injected clock. Closed days are strictly before this UTC date, so the 30
// candidate days are 2026-09-01 (D-1) back through 2026-08-03 (D-30).
const NOW = new Date('2026-09-02T12:34:56Z');
const DAY_MS = 86400000;

/** ISO day `offset` days before NOW's UTC date (dayBefore(1) = yesterday). */
function dayBefore(offset) {
  return new Date(Date.UTC(2026, 8, 2) - offset * DAY_MS).toISOString().slice(0, 10);
}

const ALL_CANDIDATES = Array.from({ length: 30 }, (_, i) => dayBefore(i + 1));

const tmp = () => mkdtempSync(join(tmpdir(), 'pypi-country-'));

function makeStore(dir, { packages = SEVEN, fetchedDays = [], daily = [] } = {}) {
  const p = join(dir, 'analytics.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE pypi_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
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
  for (const name of packages) insPkg.run(name);
  const insFetch = db.prepare('INSERT INTO pypi_country_fetch_days (date, row_count, bytes_billed, fetched_at) VALUES (?, 0, 0, ?)');
  for (const d of fetchedDays) insFetch.run(d, NOW.toISOString());
  const insDaily = db.prepare('INSERT INTO pypi_country_daily (package_id, date, country_code, downloads) VALUES (?, ?, ?, ?)');
  for (const r of daily) insDaily.run(r.pkg, r.date, r.cc, r.dl);
  db.close();
  return p;
}

/**
 * Fake BigQuery-like client implementing the collector's port: one async
 * query(options) resolving { rows, totalBytesProcessed }, recording every call.
 */
function fakeClient({ dryBytes = 1000, billedBytes = 1000, rows = [] } = {}) {
  const calls = [];
  const client = {
    calls,
    dry: () => calls.filter(c => c.dryRun),
    billed: () => calls.filter(c => !c.dryRun),
    async query(options) {
      calls.push(options);
      if (options.dryRun) {
        return { rows: [], totalBytesProcessed: typeof dryBytes === 'function' ? dryBytes(options) : dryBytes };
      }
      return {
        rows: typeof rows === 'function' ? rows(options) : rows,
        totalBytesProcessed: typeof billedBytes === 'function' ? billedBytes(options, client.billed().length) : billedBytes,
      };
    },
  };
  return client;
}

const noop = () => {};

function runCollect(dbPath, client, extra = {}) {
  return collect({ client, dbPath, now: NOW, env: {}, log: noop, ...extra });
}

function readStatus(dir) {
  return JSON.parse(readFileSync(join(dir, RUN_FILE), 'utf8'));
}

function readBudgetFile(dir) {
  return JSON.parse(readFileSync(join(dir, BUDGET_FILE), 'utf8'));
}

/** The closed day an issued call targets, from its own params. */
function callDay(call) {
  return new Date(call.params.day_start).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// AC1 — one all-package statement per closed day, injectable client
// ---------------------------------------------------------------------------

test('GAT-01.AC1 issues one all-package day-partition statement per fetched day through the injected client', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.equal(client.billed().length, 3, 'three missing days, one billed statement each');
    assert.ok(client.calls.length > 0);
    for (const call of client.calls) {
      assert.match(call.query, /file\.project IN UNNEST\(@packages\)/);
      assert.match(call.query, /FROM `bigquery-public-data\.pypi\.file_downloads`/);
      assert.match(call.query, /timestamp >= @day_start/);
      assert.match(call.query, /timestamp < @day_end/, 'half-open upper bound');
      assert.match(call.query, /GROUP BY file\.project, country_code/);
      assert.deepEqual([...call.params.packages], SEVEN, 'params.packages is the full population');
      const start = new Date(call.params.day_start).getTime();
      const end = new Date(call.params.day_end).getTime();
      assert.equal(start % DAY_MS, 0, 'day_start is a UTC midnight');
      assert.equal(end % DAY_MS, 0, 'day_end is a UTC midnight');
      assert.equal(end - start, DAY_MS, 'bounds are exactly 24 hours apart');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC2 — both byte caps enforced before any billed query, dry run first
// ---------------------------------------------------------------------------

test('GAT-01.AC2 under both caps: dry run first, then the billed call carrying maximumBytesBilled', async () => {
  const dir = tmp();
  try {
    // Only D-1 is missing, so exactly one day is fetched.
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1)) });
    const client = fakeClient({ dryBytes: 5_000_000_000, billedBytes: 4_000_000_000 });
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[0].dryRun, true, 'dry run is issued first');
    assert.ok(!client.calls[1].dryRun, 'second call is the billed query');
    assert.equal(client.calls[1].maximumBytesBilled, 137438953472,
      'billed call caps bytes at exactly 128 GiB');
    assert.equal(client.calls[0].maximumBytesBilled, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC2 refuses and exits 1 when the dry run reports over 128 GiB, never billing', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient({ dryBytes: 137438953473 });
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 1);
    assert.equal(res.status, 'refused_cap');
    assert.equal(client.dry().length, 1);
    assert.equal(client.billed().length, 0, 'no billed call after the refusing dry run');
    assert.equal(readStatus(dir).status, 'refused_cap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC2 refuses and exits 1 when month-to-date plus the estimate pass 768 GiB', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    writeFileSync(join(dir, BUDGET_FILE), JSON.stringify({
      month: '2026-09', bytesBilled: 824633720832, updatedAt: '2026-09-01T06:00:00.000Z',
    }));
    const client = fakeClient({ dryBytes: 1 });
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 1);
    assert.equal(res.status, 'capped_month');
    assert.equal(client.dry().length, 1);
    assert.equal(client.billed().length, 0, 'no billed call once the month is capped');
    assert.equal(readStatus(dir).status, 'capped_month');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC3 — the persisted month-to-date ledger
// ---------------------------------------------------------------------------

test('GAT-01.AC3 sums billed bytes into the month ledger keyed by the injected clock month', async () => {
  const dir = tmp();
  try {
    // Two missing days; billed bytes 1000 then 2000.
    const dbPath = makeStore(dir, {
      fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1) && d !== dayBefore(2)),
    });
    const client = fakeClient({ billedBytes: (options, nthBilled) => (nthBilled === 1 ? 1000 : 2000) });
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    const budget = readBudgetFile(dir);
    assert.deepEqual(Object.keys(budget).sort(), ['bytesBilled', 'month', 'updatedAt']);
    assert.equal(budget.month, '2026-09', "month is the injected clock's UTC month");
    assert.equal(budget.bytesBilled, 3000);
    assert.ok(!Number.isNaN(Date.parse(budget.updatedAt)), 'updatedAt is a parseable ISO timestamp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC3 a prior-month ledger resets to this run\'s bytes instead of carrying forward', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1)) });
    writeFileSync(join(dir, BUDGET_FILE), JSON.stringify({
      month: '2026-08', bytesBilled: 700000000000, updatedAt: '2026-08-31T06:00:00.000Z',
    }));
    const client = fakeClient({ billedBytes: 1000 });
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    const budget = readBudgetFile(dir);
    assert.equal(budget.month, '2026-09');
    assert.equal(budget.bytesBilled, 1000, 'old month total not carried forward');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC3 an unparseable ledger starts the month at 0 rather than failing', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1)) });
    writeFileSync(join(dir, BUDGET_FILE), 'not json at all {');
    const client = fakeClient({ billedBytes: 42 });
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.equal(readBudgetFile(dir).bytesBilled, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC4 — missing-day selection: newest first, at most three, 30-day window
// ---------------------------------------------------------------------------

test('GAT-01.AC4 selects exactly the newest missing candidates [D-3, D-7, D-8] in that order', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, {
      fetchedDays: [dayBefore(1), dayBefore(2), dayBefore(4), dayBefore(5), dayBefore(6)],
    });
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(client.billed().map(callDay), [dayBefore(3), dayBefore(7), dayBefore(8)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC4 with no fetch records selects exactly [D-1, D-2, D-3]', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(client.billed().map(callDay), [dayBefore(1), dayBefore(2), dayBefore(3)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC4 with every candidate fetched selects nothing and never calls the client', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES });
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.equal(res.daysFetched, 0);
    assert.equal(client.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC4 daily rows carry the closed day itself, never the collection date', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(3)) });
    const client = fakeClient({ rows: [{ project: 'cryptoserve', country_code: 'US', downloads: 5 }] });
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT package_id, date, country_code, downloads FROM pypi_country_daily').all();
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, dayBefore(3), 'row keyed by the queried closed day');
    assert.notEqual(rows[0].date, '2026-09-02', 'not the collection date');
    assert.equal(rows[0].package_id, 1);
    assert.equal(rows[0].country_code, 'US');
    assert.equal(rows[0].downloads, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC4 a zero-row day is recorded as fetched and never re-queried', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1)) });
    const first = fakeClient({ rows: [] });
    const res1 = await runCollect(dbPath, first);
    assert.equal(res1.exitCode, 0);
    assert.equal(res1.status, 'empty', 'every selected day empty reads status empty');
    assert.equal(readStatus(dir).status, 'empty');
    const second = fakeClient();
    const res2 = await runCollect(dbPath, second);
    assert.equal(res2.exitCode, 0);
    assert.equal(second.calls.length, 0, 'the empty day is not re-queried');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC5 — the 30-day total is a local SUM, no query
// ---------------------------------------------------------------------------

test('GAT-01.AC5 rewrites pypi_country_downloads as local per-(package, country) sums with zero client calls', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, {
      fetchedDays: ALL_CANDIDATES, // nothing left to fetch: the run is rollup-only
      daily: [
        { pkg: 1, date: dayBefore(1), cc: 'US', dl: 10 },
        { pkg: 1, date: dayBefore(2), cc: 'US', dl: 20 },
        { pkg: 1, date: dayBefore(3), cc: 'US', dl: 30 },
        { pkg: 1, date: dayBefore(1), cc: 'DE', dl: 5 },
        { pkg: 2, date: dayBefore(2), cc: 'US', dl: 7 },
        { pkg: 2, date: dayBefore(3), cc: 'DE', dl: 8 },
      ],
    });
    // A stale pre-existing rollup row at the as-of date must not survive the rewrite.
    {
      const db = new Database(dbPath);
      db.prepare('INSERT INTO pypi_country_downloads (package_id, date, country_code, downloads) VALUES (1, ?, ?, 999)')
        .run(dayBefore(1), 'FR');
      db.close();
    }
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.equal(client.calls.length, 0, 'the rollup issues no client call');
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT package_id, date, country_code, downloads FROM pypi_country_downloads ORDER BY package_id, country_code').all();
    db.close();
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { package_id: 1, date: dayBefore(1), country_code: 'DE', downloads: 5 },
      { package_id: 1, date: dayBefore(1), country_code: 'US', downloads: 60 },
      { package_id: 2, date: dayBefore(1), country_code: 'DE', downloads: 8 },
      { package_id: 2, date: dayBefore(1), country_code: 'US', downloads: 7 },
    ]);
    assert.deepEqual([...new Set(rows.map(r => r.date))], [dayBefore(1)],
      'a single as-of date: the newest stored closed day');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC5 a day 31 days old is excluded from the rollup sum', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, {
      fetchedDays: ALL_CANDIDATES,
      daily: [
        { pkg: 1, date: dayBefore(31), cc: 'US', dl: 1000 },
        { pkg: 1, date: dayBefore(1), cc: 'US', dl: 10 },
      ],
    });
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT date, country_code, downloads FROM pypi_country_downloads').all();
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].downloads, 10, 'the 31-day-old rows do not leak into the window');
    assert.equal(rows[0].date, dayBefore(1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC7 — scheduled run without credentials exits 1; population needs no env
// ---------------------------------------------------------------------------

function runScript(extraEnv, dbPath) {
  return new Promise((resolve) => {
    const env = { ...process.env, ANALYTICS_DB_PATH: dbPath, ...extraEnv };
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.PYPI_PACKAGES;
    if (!extraEnv.GITHUB_ACTIONS) delete env.GITHUB_ACTIONS;
    const child = spawn(process.execPath, [SCRIPT], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('GAT-01.AC7 a scheduled run without credentials persists skipped_no_credentials and exits 1', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const res = await runScript({ GITHUB_ACTIONS: '1' }, dbPath);
    assert.equal(res.status, 1, `expected exit 1; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(readStatus(dir).status, 'skipped_no_credentials');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC7 the same credential skip outside Actions exits 0 with the same status', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const res = await runScript({}, dbPath);
    assert.equal(res.status, 0, `expected exit 0; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(readStatus(dir).status, 'skipped_no_credentials');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC7 with PYPI_PACKAGES unset the population is the 7 pypi_packages rows', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient();
    const res = await collect({ client, dbPath, now: NOW, env: {}, log: noop });
    assert.equal(res.exitCode, 0);
    assert.ok(client.calls.length > 0);
    for (const call of client.calls) {
      assert.deepEqual([...call.params.packages], SEVEN);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC7 PYPI_PACKAGES, when set, filters the stored population by name', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient();
    const res = await collect({ client, dbPath, now: NOW, env: { PYPI_PACKAGES: 'aim-sdk, aicomply' }, log: noop });
    assert.equal(res.exitCode, 0);
    for (const call of client.calls) {
      assert.deepEqual([...call.params.packages], ['aim-sdk', 'aicomply']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC8 — the rejected shapes do not survive
// ---------------------------------------------------------------------------

test('GAT-01.AC8 two missing days over 7 packages make exactly 4 client calls, never 14 or 7', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, {
      fetchedDays: ALL_CANDIDATES.filter(d => d !== dayBefore(1) && d !== dayBefore(2)),
    });
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.equal(client.calls.length, 4, '2 dry runs + 2 billed, one pair per day');
    assert.equal(client.dry().length, 2);
    assert.equal(client.billed().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC8 a fully missing window queries exactly 3 days with one-day predicates', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient();
    const res = await runCollect(dbPath, client);
    assert.equal(res.exitCode, 0);
    assert.equal(client.calls.length, 6, '3 days, one dry + one billed each');
    assert.equal(client.billed().length, 3);
    for (const call of client.calls) {
      const seconds = (new Date(call.params.day_end) - new Date(call.params.day_start)) / 1000;
      assert.equal(seconds, 86400, 'no predicate wider than one day');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC8 no recorded SQL contains the rejected shapes', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient();
    await runCollect(dbPath, client);
    assert.ok(client.calls.length > 0);
    for (const call of client.calls) {
      assert.doesNotMatch(call.query, /details\./);
      assert.doesNotMatch(call.query, /LIMIT/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAT-01.AC8 guard: the collector source carries none of the rejected tokens', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const banned = /details\.|LIMIT |TIMESTAMP_SUB|CURRENT_TIMESTAMP|@package_name/;
  const offenders = source.split('\n')
    .map((line, i) => (banned.test(line) ? `${i + 1}: ${line}` : null))
    .filter(Boolean);
  assert.deepEqual(offenders, [], `rejected shapes found in collector source:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Import hygiene (supports AC1's "importable without side effects")
// ---------------------------------------------------------------------------

test('GAT-01.AC1 importing the collector executes nothing and exports the entry point', () => {
  const mod = require('../scripts/collect-pypi-country-stats');
  assert.equal(typeof mod.collect, 'function');
  assert.equal(mod.PER_QUERY_CAP_BYTES, 137438953472);
  assert.equal(mod.MONTH_CAP_BYTES, 824633720832);
});
