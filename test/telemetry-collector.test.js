const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');
const Database = require('better-sqlite3');

/*
 * Drives the REAL collector as a subprocess against fixture databases.
 *
 * Why this file exists: the pure classifiers in lib/telemetry.js were well
 * covered, but every defect three review rounds found lived in the impure glue
 * here — the db read, the annotation sinks, the env coercion. That glue had 0%
 * coverage. A test asserting `annotate('error', 'a\r::add-mask::x')` emits one
 * line would have caught the log-injection bug outright.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'collect-telemetry-stats.js');

function makeDb(dir, rows = []) {
  const p = join(dir, 'analytics.db');
  const db = new Database(p);
  db.exec(`CREATE TABLE telemetry_snapshots (
    date TEXT PRIMARY KEY, generated_at TEXT, provenance TEXT, retention_days INTEGER,
    wau_window_days INTEGER, mau_window_days INTEGER, total_installs INTEGER,
    wau INTEGER, mau INTEGER, engaged_mau INTEGER, engaged_min_days INTEGER,
    collected_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`CREATE TABLE telemetry_tool_snapshots (date TEXT, tool TEXT, total_installs INTEGER,
    wau INTEGER, mau INTEGER, engaged_mau INTEGER, collected_at TEXT, PRIMARY KEY (date, tool))`);
  db.exec(`CREATE TABLE telemetry_version_snapshots (date TEXT, tool TEXT, version TEXT,
    installs INTEGER, collected_at TEXT, PRIMARY KEY (date, tool, version))`);
  db.exec(`CREATE TABLE telemetry_country_snapshots (date TEXT, country_code TEXT,
    installs INTEGER, collected_at TEXT, PRIMARY KEY (date, country_code))`);
  const ins = db.prepare('INSERT INTO telemetry_snapshots (date, mau, total_installs) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(r.date, r.mau, r.totalInstalls);
  db.close();
  return p;
}

/**
 * Run the collector and collect its output.
 *
 * Async on purpose: spawnSync blocks this process's event loop, so the
 * in-process fixture server below could never accept the child's connection —
 * the child would hang until its feed timeout. Use spawn and await.
 */
function run(env, dbFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        GITHUB_ACTIONS: '1',
        TELEMETRY_DB_PATH: dbFile,
        TELEMETRY_FEED_TIMEOUT_MS: '5000',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Lines the Actions runner would parse as a workflow command. */
function commandLines(res) {
  return `${res.stdout}\n${res.stderr}`.split(/\r|\n/).filter((l) => l.trimStart().startsWith('::'));
}

function withServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(`http://127.0.0.1:${server.address().port}`));
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'telem-collector-'));

test('unset REGISTRY_URL with an empty store: warns, exit 0', async () => {
  const dir = tmp();
  try {
    const res = await run({ REGISTRY_URL: '' }, makeDb(dir));
    assert.equal(res.status, 0);
    assert.match(res.stdout, /::warning::/);
    assert.match(res.stdout, /not configured/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unset REGISTRY_URL after telemetry was collected: errors, exit 1', async () => {
  const dir = tmp();
  try {
    const res = await run({ REGISTRY_URL: '' }, makeDb(dir, [{ date: '2026-07-15', mau: 200, totalInstalls: 500 }]));
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error::/);
    assert.match(res.stdout, /2026-07-15/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt store reports UNKNOWN rather than "never succeeded"', async () => {
  const dir = tmp();
  try {
    const p = join(dir, 'analytics.db');
    writeFileSync(p, 'this is not a sqlite file at all');
    const res = await run({ REGISTRY_URL: 'http://127.0.0.1:1' }, p);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /UNKNOWN/);
    assert.doesNotMatch(res.stdout, /never succeeded/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hostile feed body cannot inject a workflow command on either stream', async () => {
  // The bug this guards: annotate() scrubbed but console.error did not, and the
  // scrub missed a bare \r. The runner parses BOTH stdout and stderr.
  const dir = tmp();
  try {
    const payload = 'boom\r::add-mask::0\r::stop-commands::deadbeef\n::error::all good here';
    await withServer(
      (req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(payload);
      },
      async (url) => {
        const res = await run({ REGISTRY_URL: url }, makeDb(dir));
        const cmds = commandLines(res);
        assert.equal(cmds.length, 1, `expected only our own annotation, got:\n${cmds.join('\n')}`);
        assert.match(cmds[0], /^::error::/);
        assert.equal(cmds.filter((l) => /^::(add-mask|stop-commands)::/.test(l)).length, 0);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hostile body on a 200 (JSON parse path) also cannot inject', async () => {
  const dir = tmp();
  try {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('x\r::add-mask::0');
      },
      async (url) => {
        const res = await run({ REGISTRY_URL: url }, makeDb(dir));
        assert.equal(commandLines(res).filter((l) => /^::add-mask::/.test(l)).length, 0);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a drained feed (mau=0, installs still live) errors — the shape a broken ingest makes', async () => {
  // The old check required mau AND installs to both be zero. installs is a
  // 90-day window and mau is 30-day, so that waved through ~60 days of a dead
  // pipeline. This is the regression guard for that.
  const dir = tmp();
  try {
    const dbFile = makeDb(dir, [{ date: '2026-06-16', mau: 200, totalInstalls: 500 }]);
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalInstalls: 333, wau: 0, mau: 0, tools: [], byCountry: [] }));
      },
      async (url) => {
        const res = await run({ REGISTRY_URL: url }, dbFile);
        assert.equal(res.status, 1, `expected an outage exit; stdout:\n${res.stdout}`);
        assert.match(res.stdout, /::error::/);
        assert.match(res.stdout, /mau=0/);
        assert.match(res.stdout, /333 install/);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the drain alert keeps firing on later days instead of self-silencing', async () => {
  // Day 1's zeros used to become the baseline, so day 2 saw zero-following-zero
  // and reported healthy — one red run, then green forever while serving zeros.
  const dir = tmp();
  try {
    const dbFile = makeDb(dir, [
      { date: '2026-06-16', mau: 200, totalInstalls: 500 },
      { date: '2026-07-15', mau: 0, totalInstalls: 333 }, // yesterday was already zero
    ]);
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalInstalls: 300, wau: 0, mau: 0, tools: [], byCountry: [] }));
      },
      async (url) => {
        const res = await run({ REGISTRY_URL: url }, dbFile);
        assert.equal(res.status, 1, 'a sustained outage must keep erroring, not go quiet');
        assert.match(res.stdout, /2026-06-16/); // compares to the last LIVE day
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a healthy feed writes and exits 0', async () => {
  const dir = tmp();
  try {
    const dbFile = makeDb(dir, [{ date: '2026-07-15', mau: 190, totalInstalls: 480 }]);
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            generatedAt: '2026-07-16T00:00:00Z',
            totalInstalls: 500,
            wau: 69,
            mau: 200,
            engagedMau: 12,
            tools: [],
            byCountry: [],
          })
        );
      },
      async (url) => {
        const res = await run({ REGISTRY_URL: url }, dbFile);
        assert.equal(res.status, 0, `expected success; stderr:\n${res.stderr}`);
        assert.equal(commandLines(res).length, 0, 'a healthy run must emit no annotations');
        assert.match(res.stdout, /collection complete/);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a brand-new deployment reporting zero is not an outage', async () => {
  const dir = tmp();
  try {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalInstalls: 0, wau: 0, mau: 0, tools: [], byCountry: [] }));
      },
      async (url) => {
        // No prior live snapshot -> nothing has died -> not an outage.
        const res = await run({ REGISTRY_URL: url }, makeDb(dir));
        assert.equal(res.status, 0, `a first run with no users must not error; stdout:\n${res.stdout}`);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importing the script does not execute it', () => {
  // require.main === module guards every side effect; without it, importing for
  // a unit test would run a collection and possibly process.exit the test runner.
  const mod = require('../scripts/collect-telemetry-stats');
  assert.equal(typeof mod.annotate, 'function');
  assert.equal(typeof mod.readLastSuccess, 'function');
  assert.equal(typeof mod.readLastLiveTotals, 'function');
});

test('annotate collapses a bare CR so it cannot open a second command', () => {
  const { annotate } = require('../scripts/collect-telemetry-stats');
  const seen = [];
  const orig = console.log;
  console.log = (s) => seen.push(s);
  try {
    process.env.GITHUB_ACTIONS = '1';
    annotate('error', 'a\r::add-mask::x');
  } finally {
    console.log = orig;
  }
  assert.equal(seen.length, 1);
  assert.ok(!/\r/.test(seen[0]), 'no CR may survive into a log line');
  assert.doesNotMatch(seen[0], /::add-mask::/);
});
