const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');
const { BigQuery } = require('@google-cloud/bigquery');

const {
  collect,
  estimate,
  createBigQueryAdapter,
  PER_QUERY_CAP_BYTES,
  BUDGET_FILE,
  RUN_FILE,
} = require('../scripts/collect-pypi-country-stats');

// Injected clock: D-1 is 2026-09-01.
const NOW = new Date('2026-09-02T12:34:56Z');
const DAY_MS = 86400000;
const GIB = 1073741824;

function dayBefore(offset) {
  return new Date(Date.UTC(2026, 8, 2) - offset * DAY_MS).toISOString().slice(0, 10);
}

const tmp = () => mkdtempSync(join(tmpdir(), 'pypi-country-adapter-'));

/**
 * A store with one tracked package and every candidate day fetched except the
 * newest `missing` ones (D-1 by default).
 */
function makeStore(dir, { missing = 1 } = {}) {
  const p = join(dir, 'analytics.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE pypi_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    INSERT INTO pypi_packages (name) VALUES ('aim-sdk');
    CREATE TABLE pypi_country_fetch_days (
      date TEXT PRIMARY KEY, row_count INTEGER NOT NULL DEFAULT 0,
      bytes_billed INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL);
  `);
  const insFetch = db.prepare('INSERT INTO pypi_country_fetch_days (date, fetched_at) VALUES (?, ?)');
  for (let i = missing + 1; i <= 30; i++) insFetch.run(dayBefore(i), NOW.toISOString());
  db.close();
  return p;
}

/**
 * A real @google-cloud/bigquery client whose transport is replaced by a fake
 * service. The library still builds every job request itself; the fake reads
 * the request body as BigQuery would: a dry run reports `estimate`, a billed
 * job scans `scanned` bytes and is refused with bytesBilledLimitExceeded when
 * that passes the job's configuration.query.maximumBytesBilled. An undefined
 * `estimate` leaves totalBytesProcessed out of the dry run's statistics.
 * `refuseAt` picks where the refusal reaches the client: in the job insert
 * response ('insert') or as the HTTP 400 the results read returns ('results').
 */
function stubbedBigQuery({ estimate, scanned, rows = [], refuseAt = 'insert' }) {
  const bigquery = new BigQuery({ projectId: 'test-project' });
  const inserts = [];
  const billed = [];
  const refused = new Map();
  bigquery.request = (reqOpts, callback) => {
    if (reqOpts.method === 'POST' && reqOpts.uri === '/jobs') {
      const body = reqOpts.json;
      inserts.push(body);
      const { jobReference } = body;
      if (body.configuration.dryRun) {
        const statistics = estimate === undefined ? {} : { totalBytesProcessed: String(estimate) };
        callback(null, { jobReference, status: { state: 'DONE' }, statistics });
        return;
      }
      const cap = body.configuration.query.maximumBytesBilled;
      if (cap !== undefined && scanned > Number(cap)) {
        const error = {
          reason: 'bytesBilledLimitExceeded',
          message: `Query exceeded limit for bytes billed: ${cap}. ${scanned} or higher required.`,
        };
        if (refuseAt === 'results') {
          refused.set(jobReference.jobId, error);
          callback(null, { jobReference, status: { state: 'RUNNING' } });
          return;
        }
        callback(null, { jobReference, status: { state: 'DONE', errorResult: error, errors: [error] } });
        return;
      }
      billed.push(scanned);
      callback(null, { jobReference, status: { state: 'DONE' } });
      return;
    }
    if (reqOpts.uri.startsWith('/queries/')) {
      const error = refused.get(reqOpts.uri.slice('/queries/'.length));
      if (error) {
        callback(Object.assign(new Error(error.message), { code: 400, errors: [error] }));
        return;
      }
      callback(null, {
        jobComplete: true,
        schema: { fields: [
          { name: 'project', type: 'STRING' },
          { name: 'country_code', type: 'STRING' },
          { name: 'downloads', type: 'INTEGER' },
        ] },
        rows: rows.map(r => ({ f: [{ v: r.project }, { v: r.country_code }, { v: String(r.downloads) }] })),
      });
      return;
    }
    if (/^\/?jobs\/[^/]+$/.test(reqOpts.uri)) {
      callback(null, { status: { state: 'DONE' },
        statistics: { query: { totalBytesBilled: String(scanned) } } });
      return;
    }
    callback(new Error(`unexpected request ${reqOpts.method || 'GET'} ${reqOpts.uri}`));
  };
  return { bigquery, inserts, billed };
}

function runCollect(dbPath, bigquery) {
  return collect({
    client: createBigQueryAdapter(bigquery), dbPath, now: NOW, env: {}, log: () => {},
  });
}

test('the adapter puts maximumBytesBilled in the billed job request and leaves it off the dry run', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const service = stubbedBigQuery({
      estimate: 5 * GIB, scanned: 4 * GIB,
      rows: [{ project: 'aim-sdk', country_code: 'US', downloads: 42 }],
    });
    const res = await runCollect(dbPath, service.bigquery);
    assert.equal(res.status, 'ok');
    assert.equal(res.exitCode, 0);
    assert.equal(service.inserts.length, 2, 'one dry run, one billed job');

    const [dry, billed] = service.inserts;
    assert.equal(dry.configuration.dryRun, true);
    assert.equal(dry.configuration.query.maximumBytesBilled, undefined);
    assert.equal(billed.configuration.dryRun, undefined, 'the billed job is not a dry run');
    assert.equal(Number(billed.configuration.query.maximumBytesBilled), PER_QUERY_CAP_BYTES,
      'BigQuery receives the per-query ceiling on the job it bills');

    assert.equal(res.bytesBilled, 4 * GIB);
    const db = new Database(dbPath, { readonly: true });
    const landed = db.prepare('SELECT country_code, downloads FROM pypi_country_daily WHERE date = ?').all(dayBefore(1));
    db.close();
    assert.deepEqual(landed.map(r => ({ ...r })), [{ country_code: 'US', downloads: 42 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every billed job of a three-day run carries maximumBytesBilled, not only the first', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir, { missing: 3 });
    const service = stubbedBigQuery({
      estimate: 5 * GIB, scanned: 4 * GIB,
      rows: [{ project: 'aim-sdk', country_code: 'US', downloads: 42 }],
    });
    const res = await runCollect(dbPath, service.bigquery);
    assert.equal(res.status, 'ok');
    assert.equal(res.exitCode, 0);
    assert.equal(res.daysFetched, 3);
    assert.equal(service.inserts.length, 6, 'a dry run and a billed job for each of three days');

    const dryRuns = service.inserts.filter(body => body.configuration.dryRun);
    const billedJobs = service.inserts.filter(body => !body.configuration.dryRun);
    assert.equal(dryRuns.length, 3);
    assert.equal(billedJobs.length, 3);
    for (const dry of dryRuns) {
      assert.equal(dry.configuration.query.maximumBytesBilled, undefined);
    }
    billedJobs.forEach((billed, i) => {
      assert.equal(Number(billed.configuration.query.maximumBytesBilled), PER_QUERY_CAP_BYTES,
        `billed job ${i + 1} of 3 carries the per-query ceiling`);
    });

    assert.deepEqual(service.billed, [4 * GIB, 4 * GIB, 4 * GIB]);
    assert.equal(res.bytesBilled, 12 * GIB);
    const db = new Database(dbPath, { readonly: true });
    const landed = db.prepare('SELECT date FROM pypi_country_daily ORDER BY date DESC').all().map(r => r.date);
    db.close();
    assert.deepEqual(landed, [dayBefore(1), dayBefore(2), dayBefore(3)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const refuseAt of ['insert', 'results']) {
  test(`a scan over the ceiling that the dry run under-estimated is refused by BigQuery (${refuseAt}): refused_cap, nothing billed, nothing reserved`, async () => {
    const dir = tmp();
    try {
      const dbPath = makeStore(dir);
      writeFileSync(join(dir, BUDGET_FILE), JSON.stringify({
        month: '2026-09', bytesBilled: 3 * GIB, updatedAt: '2026-09-01T06:00:00.000Z',
      }));
      const service = stubbedBigQuery({
        estimate: 100 * GIB, scanned: 200 * GIB, refuseAt,
        rows: [{ project: 'aim-sdk', country_code: 'US', downloads: 42 }],
      });
      assert.ok(100 * GIB < PER_QUERY_CAP_BYTES && 200 * GIB > PER_QUERY_CAP_BYTES);
      const res = await runCollect(dbPath, service.bigquery);
      assert.equal(res.status, 'refused_cap', 'the ceiling held, and the run says so');
      assert.equal(res.exitCode, 1);
      assert.equal(res.bytesBilled, 0);
      assert.equal(service.inserts.length, 2, 'the billed job reached BigQuery and was refused there');
      assert.deepEqual(service.billed, [], 'no job scanned past the ceiling');
      assert.equal(JSON.parse(readFileSync(join(dir, RUN_FILE), 'utf8')).status, 'refused_cap');
      assert.equal(JSON.parse(readFileSync(join(dir, BUDGET_FILE), 'utf8')).bytesBilled, 3 * GIB,
        'a refused job bills nothing, so its 100 GiB reservation is released');

      const db = new Database(dbPath, { readonly: true });
      const fetched = db.prepare('SELECT 1 FROM pypi_country_fetch_days WHERE date = ?').get(dayBefore(1));
      const landed = db.prepare('SELECT COUNT(*) AS n FROM pypi_country_daily').get().n;
      db.close();
      assert.equal(fetched, undefined, 'the refused day stays missing');
      assert.equal(landed, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a dry run whose statistics carry no totalBytesProcessed is refused by the adapter, before any billed job', async () => {
  const service = stubbedBigQuery({ estimate: undefined, scanned: 4 * GIB });
  await assert.rejects(
    createBigQueryAdapter(service.bigquery).query({ query: 'SELECT 1', dryRun: true }),
    /dry-run job statistics carry no readable totalBytesProcessed/,
    'the adapter throws rather than hand collect() an estimate to read');

  const dir = tmp();
  const logged = [];
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const dbPath = makeStore(dir);
    const run = stubbedBigQuery({
      estimate: undefined, scanned: 4 * GIB,
      rows: [{ project: 'aim-sdk', country_code: 'US', downloads: 42 }],
    });
    const res = await collect({
      client: createBigQueryAdapter(run.bigquery), dbPath, now: NOW, env: {},
      log: (...args) => logged.push(args.join(' ')),
    });
    assert.equal(res.status, 'error');
    assert.equal(res.exitCode, 1);
    assert.equal(res.bytesBilled, 0);
    assert.equal(run.inserts.length, 1, 'only the dry run reached BigQuery');
    assert.deepEqual(run.billed, []);
    assert.ok(errors.some(line => /no readable totalBytesProcessed/.test(line)),
      'the run fails on the adapter\'s refusal');
    assert.ok(!logged.some(line => /unreadable dry-run estimate/.test(line)),
      'collect() never received an estimate to refuse');

    const db = new Database(dbPath, { readonly: true });
    const fetched = db.prepare('SELECT 1 FROM pypi_country_fetch_days WHERE date = ?').get(dayBefore(1));
    db.close();
    assert.equal(fetched, undefined, 'the refused day stays missing');
  } finally {
    console.error = consoleError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry-run estimate through the real library sends only dry-run jobs and bills nothing', async () => {
  const dir = tmp();
  try {
    const dbPath = makeStore(dir);
    const service = stubbedBigQuery({ estimate: 12 * GIB, scanned: 12 * GIB });
    const res = await estimate({
      client: createBigQueryAdapter(service.bigquery), dbPath, now: NOW, env: {}, log: () => {},
    });
    assert.equal(res.status, 'estimated');
    assert.deepEqual(res.days, [{ date: dayBefore(1), bytes: 12 * GIB, fetched: false }]);
    assert.equal(service.inserts.length, 1);
    assert.equal(service.inserts[0].configuration.dryRun, true, 'BigQuery receives a dry-run job only');
    assert.deepEqual(service.billed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
