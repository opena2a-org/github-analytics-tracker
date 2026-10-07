const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { format } = require('node:util');
const Database = require('better-sqlite3');

const {
  estimate,
  PER_QUERY_CAP_BYTES,
  MONTH_CAP_BYTES,
  BUDGET_FILE,
  RUN_FILE,
  parseArgs,
} = require('../scripts/collect-pypi-country-stats');

const SCRIPT = join(__dirname, '..', 'scripts', 'collect-pypi-country-stats.js');

// Injected clock: D-1 is 2026-09-01.
const NOW = new Date('2026-09-02T12:34:56Z');
const DAY_MS = 86400000;
const GIB = 1073741824;

function dayBefore(offset) {
  return new Date(Date.UTC(2026, 8, 2) - offset * DAY_MS).toISOString().slice(0, 10);
}

const ALL_CANDIDATES = Array.from({ length: 30 }, (_, i) => dayBefore(i + 1));

const tmp = () => mkdtempSync(join(tmpdir(), 'pypi-country-estimate-'));

function makeStore(dir, { fetchedDays = [], fetchTable = true } = {}) {
  const p = join(dir, 'analytics.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE pypi_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    INSERT INTO pypi_packages (name) VALUES ('aim-sdk'), ('cryptoserve');
  `);
  if (fetchTable) {
    db.exec(`
      CREATE TABLE pypi_country_fetch_days (
        date TEXT PRIMARY KEY, row_count INTEGER NOT NULL DEFAULT 0,
        bytes_billed INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL);
    `);
    const ins = db.prepare('INSERT INTO pypi_country_fetch_days (date, fetched_at) VALUES (?, ?)');
    for (const d of fetchedDays) ins.run(d, NOW.toISOString());
  }
  db.close();
  return p;
}

/** Fake client on the collector's port that records every call. */
function fakeClient(dryBytes) {
  const calls = [];
  return {
    calls,
    async query(options) {
      calls.push(options);
      if (!options.dryRun) throw new Error('estimate issued a billed query');
      return { rows: [], totalBytesProcessed: typeof dryBytes === 'function' ? dryBytes(options) : dryBytes };
    },
  };
}

function callDay(call) {
  return new Date(call.params.day_start).toISOString().slice(0, 10);
}

function runEstimate(dbPath, client, extra = {}) {
  return estimate({ client, dbPath, now: NOW, env: {}, log: () => {}, ...extra });
}

/** Every file the collector could write, read raw, so "unchanged" is byte-exact. */
function snapshot(dir) {
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : null);
  return { db: read('analytics.db'), budget: read(BUDGET_FILE), run: read(RUN_FILE) };
}

test('a dry run estimates the days the next run would fetch and bills, writes and records nothing', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.filter(d => ![dayBefore(1), dayBefore(4)].includes(d)) });
    writeFileSync(join(dir, BUDGET_FILE), JSON.stringify({ month: '2026-09', bytesBilled: 10 * GIB }) + '\n');
    writeFileSync(join(dir, RUN_FILE), JSON.stringify({ status: 'ok' }) + '\n');
    const before = snapshot(dir);

    const client = fakeClient(opts => (callDay(opts) === dayBefore(1) ? 7 * GIB : 9 * GIB));
    const res = await runEstimate(dbPath, client);

    assert.equal(res.status, 'estimated');
    assert.equal(res.exitCode, 0);
    assert.deepEqual(client.calls.map(callDay), [dayBefore(1), dayBefore(4)]);
    for (const call of client.calls) {
      assert.equal(call.dryRun, true);
      assert.equal(call.maximumBytesBilled, undefined);
      assert.deepEqual(call.params.packages, ['aim-sdk', 'cryptoserve']);
    }
    assert.deepEqual(res.days, [
      { date: dayBefore(1), bytes: 7 * GIB, fetched: false },
      { date: dayBefore(4), bytes: 9 * GIB, fetched: false },
    ]);
    assert.equal(res.estimatedBytes, 16 * GIB);
    assert.equal(res.monthToDateBytes, 10 * GIB);
    assert.equal(res.perQueryCapBytes, PER_QUERY_CAP_BYTES);
    assert.equal(res.monthCapBytes, MONTH_CAP_BYTES);

    assert.deepEqual(snapshot(dir), before, 'the store, the ledger and the run status are untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry run over the per-query ceiling reports refused_cap and exits 1 without billing', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient(opts => (callDay(opts) === dayBefore(2) ? PER_QUERY_CAP_BYTES + 1 : GIB));
    const res = await runEstimate(dbPath, client);
    assert.equal(res.status, 'refused_cap');
    assert.equal(res.exitCode, 1);
    assert.deepEqual(client.calls.map(callDay), [dayBefore(1), dayBefore(2), dayBefore(3)],
      'every day is still measured: dry runs bill nothing');
    assert.equal(res.days[1].bytes, PER_QUERY_CAP_BYTES + 1);
    assert.equal(existsSync(join(dir, BUDGET_FILE)), false);
    assert.equal(existsSync(join(dir, RUN_FILE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimates that would carry the month past its ceiling report capped_month and leave the ledger as it was', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const ledger = JSON.stringify({ month: '2026-09', bytesBilled: MONTH_CAP_BYTES - 150 * GIB }) + '\n';
    writeFileSync(join(dir, BUDGET_FILE), ledger);
    // 100 GiB per day: day one fits, day two passes the month ceiling.
    const res = await runEstimate(dbPath, fakeClient(100 * GIB));
    assert.equal(res.status, 'capped_month');
    assert.equal(res.exitCode, 1);
    assert.equal(res.estimatedBytes, 300 * GIB);
    assert.equal(readFileSync(join(dir, BUDGET_FILE), 'utf8'), ledger);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no ledger file the dry run counts the bytes the store records as billed this month', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES.slice(3) });
    const db = new Database(dbPath);
    db.prepare('UPDATE pypi_country_fetch_days SET bytes_billed = ?, fetched_at = ? WHERE date = ?')
      .run(MONTH_CAP_BYTES - 150 * GIB, '2026-09-01T06:00:00.000Z', dayBefore(4));
    db.close();
    const before = snapshot(dir);
    const res = await runEstimate(dbPath, fakeClient(100 * GIB));
    assert.equal(res.monthToDateBytes, MONTH_CAP_BYTES - 150 * GIB);
    assert.equal(res.status, 'capped_month', 'the run would be refused on its second day, as collect() is');
    assert.equal(res.exitCode, 1);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a per-query refusal on an earlier day outranks a month refusal on a later one', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    writeFileSync(join(dir, BUDGET_FILE), JSON.stringify({ month: '2026-09', bytesBilled: MONTH_CAP_BYTES - GIB }) + '\n');
    const res = await runEstimate(dbPath, fakeClient(opts => (callDay(opts) === dayBefore(1) ? PER_QUERY_CAP_BYTES + 1 : GIB)));
    assert.equal(res.status, 'refused_cap', 'the run would stop at D-1 on the per-query ceiling first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable dry-run figure is an error, never a zero-byte estimate', async () => {
  for (const bad of [null, undefined, '', '1.5e3', -1, 2.5, false]) {
    const dir = tmp();
    try {
      const dbPath = makeStore(dir);
      const res = await runEstimate(dbPath, fakeClient(bad));
      assert.equal(res.status, 'error', `figure ${String(bad)}`);
      assert.equal(res.exitCode, 1);
      assert.equal(res.estimatedBytes, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a client failure is reported as an error with exit 1', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = { async query() { throw new Error('Access Denied'); } };
    const res = await runEstimate(dbPath, client);
    assert.equal(res.status, 'error');
    assert.equal(res.exitCode, 1);
    assert.equal(existsSync(join(dir, RUN_FILE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with every candidate fetched the dry run still measures D-1, marked as already fetched', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES });
    const client = fakeClient(3 * GIB);
    const res = await runEstimate(dbPath, client);
    assert.equal(res.status, 'estimated');
    assert.deepEqual(client.calls.map(callDay), [dayBefore(1)]);
    assert.deepEqual(res.days, [{ date: dayBefore(1), bytes: 3 * GIB, fetched: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a store the collector has never run against estimates the three newest closed days', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchTable: false });
    const before = snapshot(dir);
    const client = fakeClient(GIB);
    const res = await runEstimate(dbPath, client);
    assert.equal(res.status, 'estimated');
    assert.deepEqual(client.calls.map(callDay), [dayBefore(1), dayBefore(2), dayBefore(3)]);
    assert.deepEqual(snapshot(dir), before, 'no table is created by a dry run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PYPI_PACKAGES filters the estimated population the same way it filters a collection', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const client = fakeClient(GIB);
    await runEstimate(dbPath, client, { env: { PYPI_PACKAGES: 'cryptoserve' } });
    for (const call of client.calls) assert.deepEqual(call.params.packages, ['cryptoserve']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run the collector CLI against the store in a temporary directory. The child
 * runs in that directory, so the .env it loads is the test's, never the one
 * at the repository root, which may hold real BigQuery credentials.
 */
function runScript(args, dbPath, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ANALYTICS_DB_PATH: dbPath };
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.PYPI_PACKAGES;
    delete env.GITHUB_ACTIONS;
    delete env.npm_config_dry_run;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, cwd: dirname(dbPath) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('--dry-run without credentials measures nothing, exits 1 and leaves the last run status in place', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    writeFileSync(join(dir, RUN_FILE), JSON.stringify({ status: 'ok' }) + '\n');
    const before = snapshot(dir);
    const res = await runScript(['--dry-run'], dbPath);
    assert.equal(res.status, 1, `expected exit 1; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /nothing was measured/i);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the spawned dry run loads .env from the test directory, not the repository root', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    // A key path that does not exist: the collector names it and still
    // never reaches BigQuery.
    const missingKey = join(dir, 'no-such-key.json');
    writeFileSync(join(dir, '.env'), `GOOGLE_APPLICATION_CREDENTIALS=${missingKey}\n`);
    const res = await runScript(['--dry-run'], dbPath);
    assert.ok(res.stdout.includes(missingKey), `the test directory's .env was not loaded; stdout:\n${res.stdout}`);
    assert.match(res.stdout, /nothing was measured/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const args of [['--dryrun'], ['--dry-run', 'extra'], ['--dry-run=true']]) {
  test(`the collector refuses \`${args.join(' ')}\` with a usage message and starts nothing`, async () => {
    const dir = tmp();
    try {
      const dbPath = makeStore(dir);
      const before = snapshot(dir);
      const res = await runScript(args, dbPath);
      assert.equal(res.status, 2, `expected exit 2; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
      assert.match(res.stderr, /unrecognised argument/i);
      assert.match(res.stderr, /usage:/i);
      assert.doesNotMatch(res.stdout, /credentials not configured/i, 'no collection was started');
      assert.deepEqual(snapshot(dir), before, 'no run status is written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const args of [['--help'], ['-h'], ['--help', '--dry-run']]) {
  test(`\`${args.join(' ')}\` prints the usage and exits 0 without starting a run`, async () => {
    const dir = tmp();
    try {
      const dbPath = makeStore(dir);
      const before = snapshot(dir);
      const res = await runScript(args, dbPath);
      assert.equal(res.status, 0, `expected exit 0; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
      assert.match(res.stdout, /usage:/i);
      assert.match(res.stdout, /--dry-run/);
      assert.equal(res.stderr, '');
      assert.doesNotMatch(res.stdout, /credentials not configured/i, 'no collection was started');
      assert.deepEqual(snapshot(dir), before, 'no run status is written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// What npm 11 passes on for `npm run collect:pypi-countries --dryrun`,
// `--dry_rn` and `--dyrrun`: an unknown flag given without the -- arrives as an
// npm_config_ variable, never as an argument.
for (const key of ['npm_config_dryrun', 'npm_config_dry_rn', 'npm_config_dyrrun']) {
  test(`${key}=true, a mistyped dry-run flag that npm passed on, is refused and starts nothing`, async () => {
    const dir = tmp();
    try {
      const dbPath = makeStore(dir);
      const before = snapshot(dir);
      const res = await runScript([], dbPath, { [key]: 'true' });
      assert.equal(res.status, 2, `expected exit 2; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
      assert.ok(res.stderr.includes(key), `the refusal names ${key}; stderr:\n${res.stderr}`);
      assert.match(res.stderr, /usage:/i);
      assert.doesNotMatch(res.stdout, /credentials not configured/i, 'no collection was started');
      assert.deepEqual(snapshot(dir), before, 'no run status is written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the npm options npm 11 sets for every `npm run` are not read as a mistyped dry-run flag', () => {
  const npmEnv = Object.fromEntries([
    'allow_scripts', 'cache', 'global_prefix', 'globalconfig', 'init_module', 'local_prefix',
    'loglevel', 'node_gyp', 'noproxy', 'npm_version', 'prefix', 'user_agent', 'userconfig',
  ].map(name => [`npm_config_${name}`, 'x']));
  assert.deepEqual(parseArgs([], npmEnv), { dryRun: false });
  assert.deepEqual(parseArgs([], { ...npmEnv, npm_config_dry_run: 'true' }), { dryRun: true });
});

test('npm_config_dry_run=true, which `npm run collect:pypi-countries --dry-run` sets, is a dry run', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    writeFileSync(join(dir, RUN_FILE), JSON.stringify({ status: 'ok' }) + '\n');
    const before = snapshot(dir);
    const res = await runScript([], dbPath, { npm_config_dry_run: 'true' });
    assert.equal(res.status, 1, `expected exit 1; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /nothing was measured/i);
    assert.deepEqual(snapshot(dir), before, 'a dry run writes no run status');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with every candidate fetched the verdict is worded for the next new day, not for the next run', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { fetchedDays: ALL_CANDIDATES });
    writeFileSync(join(dir, BUDGET_FILE), JSON.stringify({ month: '2026-09', bytesBilled: MONTH_CAP_BYTES - 1 }) + '\n');
    const lines = [];
    const res = await runEstimate(dbPath, fakeClient(2), { log: (...a) => lines.push(format(...a)) });
    assert.equal(res.status, 'capped_month', 'a new day of this size would pass the monthly cap');
    assert.equal(res.exitCode, 1);
    const out = lines.join('\n');
    assert.doesNotMatch(out, /next run would be refused/i, 'the next run fetches nothing, so nothing refuses it');
    assert.match(out, /next run would bill nothing/i);
    assert.match(out, /a new day of this size would be refused \(capped_month\)/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
