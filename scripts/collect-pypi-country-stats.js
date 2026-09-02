/**
 * PyPI country download stats collector (BigQuery public dataset).
 *
 * One query per closed UTC day covering ALL tracked packages at once, issued
 * through an injectable BigQuery-like client and gated by two byte caps:
 *   - 128 GiB per query   (a dry run estimates first; the billed query carries
 *     maximumBytesBilled so BigQuery enforces the same ceiling server-side)
 *   - 768 GiB per month   (a persisted ledger of billed bytes, data/pypi-country-budget.json)
 *
 * Per run it fetches at most three missing closed days (newest first, from the
 * 30 most recent closed days; no backfill beyond that window), lands the rows
 * in pypi_country_daily keyed by the closed day itself, then rewrites the
 * 30-day rollup in pypi_country_downloads as a local SUM — no query.
 *
 * Every run ends by persisting data/pypi-country-run.json with a status from
 * {ok, empty, skipped_no_credentials, refused_cap, capped_month, error}. A
 * scheduled run (GITHUB_ACTIONS set) that has no credentials exits 1 so the
 * workflow goes red instead of silently reading clean.
 *
 * The client port this module consumes: one async `query(options)` that
 * resolves to { rows, totalBytesProcessed } for both dry and billed runs.
 * Tests inject a fake; createBigQueryAdapter() wraps @google-cloud/bigquery
 * for real runs and is the only code paths tests never touch.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const PER_QUERY_CAP_BYTES = 137438953472; // 128 GiB
const MONTH_CAP_BYTES = 824633720832; // 768 GiB
const WINDOW_DAYS = 30;
const MAX_DAYS_PER_RUN = 3;

const BUDGET_FILE = 'pypi-country-budget.json';
const RUN_FILE = 'pypi-country-run.json';

/**
 * Check whether BigQuery credentials are available.
 * True if GOOGLE_APPLICATION_CREDENTIALS is set and the file exists,
 * or if GOOGLE_CLOUD_PROJECT is set (workload identity / metadata auth).
 */
function isBigQueryAvailable(env = process.env) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (fs.existsSync(env.GOOGLE_APPLICATION_CREDENTIALS)) {
      return true;
    }
    console.log('Warning: GOOGLE_APPLICATION_CREDENTIALS is set but the file does not exist: %s',
      env.GOOGLE_APPLICATION_CREDENTIALS);
    return false;
  }
  return Boolean(env.GOOGLE_CLOUD_PROJECT);
}

function utcMidnight(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDays(day, n) {
  return new Date(day.getTime() + n * 86400000);
}

function isoDay(day) {
  return day.toISOString().slice(0, 10);
}

/** The 30 most recent closed UTC days, newest (yesterday) first. */
function candidateDays(now) {
  const today = utcMidnight(now);
  const days = [];
  for (let i = 1; i <= WINDOW_DAYS; i++) days.push(addDays(today, -i));
  return days;
}

/**
 * Closed days with no fetch record yet, newest first, at most three.
 * A day queried once — even one that returned zero rows — has a record in
 * pypi_country_fetch_days and is never selected again.
 */
function selectMissingDays(db, now) {
  const hasRecord = db.prepare('SELECT 1 FROM pypi_country_fetch_days WHERE date = ?');
  return candidateDays(now)
    .filter(day => !hasRecord.get(isoDay(day)))
    .slice(0, MAX_DAYS_PER_RUN);
}

/**
 * The single all-package statement for one closed day: a half-open partition
 * predicate [@day_start, @day_end), both UTC midnights exactly 24h apart.
 */
function buildDayQueryOptions(packages, day) {
  const query = `
    SELECT
      file.project AS project,
      country_code,
      COUNT(*) AS downloads
    FROM \`bigquery-public-data.pypi.file_downloads\`
    WHERE file.project IN UNNEST(@packages)
      AND timestamp >= @day_start
      AND timestamp < @day_end
    GROUP BY file.project, country_code
  `;
  return {
    query,
    params: {
      packages,
      day_start: day,
      day_end: addDays(day, 1),
    },
    location: 'US',
  };
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pypi_country_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      country_code TEXT NOT NULL,
      downloads INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
      UNIQUE(package_id, date, country_code)
    );
    CREATE INDEX IF NOT EXISTS idx_pypi_country_daily_pkg_date
      ON pypi_country_daily(package_id, date);
    CREATE TABLE IF NOT EXISTS pypi_country_fetch_days (
      date TEXT PRIMARY KEY,
      row_count INTEGER NOT NULL DEFAULT 0,
      bytes_billed INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pypi_country_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      country_code TEXT NOT NULL,
      downloads INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
      UNIQUE(package_id, date, country_code)
    );
    CREATE INDEX IF NOT EXISTS idx_pypi_country_pkg_date
      ON pypi_country_downloads(package_id, date);
  `);
}

/** Month-to-date billed bytes; a missing/unparseable file or another month starts at 0. */
function readBudget(dataDir, month) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dataDir, BUDGET_FILE), 'utf8'));
    if (b && b.month === month && Number.isInteger(b.bytesBilled) && b.bytesBilled >= 0) {
      return b.bytesBilled;
    }
  } catch {
    // absent or unparseable: start the month at 0
  }
  return 0;
}

function writeBudget(dataDir, month, bytesBilled, now) {
  const record = { month, bytesBilled, updatedAt: now.toISOString() };
  fs.writeFileSync(path.join(dataDir, BUDGET_FILE), JSON.stringify(record, null, 2) + '\n');
}

function writeRunStatus(dataDir, record) {
  fs.writeFileSync(path.join(dataDir, RUN_FILE), JSON.stringify(record, null, 2) + '\n');
}

/** Newest stored closed day, or null when none. */
function newestStoredDay(db) {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_country_daily'"
  ).get();
  if (!table) return null;
  return db.prepare('SELECT MAX(date) AS d FROM pypi_country_daily').get().d || null;
}

/**
 * Rewrite pypi_country_downloads for the as-of date (the newest stored closed
 * day) as the per-(package_id, country_code) SUM of pypi_country_daily over
 * the stored days inside the 30 most recent closed days. Purely local: no
 * client call; fewer than 30 stored days simply sum over what is stored.
 */
function rollupCountryDownloads(db, now) {
  const asOf = newestStoredDay(db);
  if (!asOf) return null;
  const today = utcMidnight(now);
  const windowStart = isoDay(addDays(today, -WINDOW_DAYS));
  const windowEnd = isoDay(addDays(today, -1));
  db.prepare('DELETE FROM pypi_country_downloads WHERE date = ?').run(asOf);
  db.prepare(`
    INSERT INTO pypi_country_downloads (package_id, date, country_code, downloads)
    SELECT package_id, ?, country_code, SUM(downloads)
    FROM pypi_country_daily
    WHERE date >= ? AND date <= ?
    GROUP BY package_id, country_code
  `).run(asOf, windowStart, windowEnd);
  return asOf;
}

/** Thin adapter producing the client port over @google-cloud/bigquery. */
function createBigQueryAdapter() {
  const { BigQuery } = require('@google-cloud/bigquery');
  const bigquery = new BigQuery();
  return {
    async query(options) {
      const [job] = await bigquery.createQueryJob(options);
      if (options.dryRun) {
        const stats = job.metadata?.statistics || {};
        return { rows: [], totalBytesProcessed: Number(stats.totalBytesProcessed || 0) };
      }
      const [rows] = await job.getQueryResults();
      const [metadata] = await job.getMetadata();
      const stats = metadata?.statistics || {};
      const billed = stats.query?.totalBytesBilled ?? stats.totalBytesProcessed ?? 0;
      return { rows, totalBytesProcessed: Number(billed) };
    },
  };
}

/**
 * Collection entry point. Importing this module runs nothing; only the CLI
 * path below maps the returned exitCode to process.exit.
 *
 * Options:
 *   client   injected BigQuery-like client ({ query(options) }); when absent a
 *            real adapter is built after the credential check
 *   dbPath   analytics database (default: ANALYTICS_DB_PATH or data/analytics.db)
 *   dataDir  where the budget and run-status JSON files live (default: the db's directory)
 *   now      injected clock
 *   env      injected environment
 */
async function collect({
  client = null,
  dbPath = null,
  dataDir = null,
  now = new Date(),
  env = process.env,
  log = console.log,
} = {}) {
  dbPath = dbPath || env.ANALYTICS_DB_PATH || path.join(__dirname, '..', 'data', 'analytics.db');
  dataDir = dataDir || path.dirname(dbPath);

  const finish = (status, extra = {}) => {
    const record = {
      status,
      asOf: extra.asOf ?? null,
      runAt: now.toISOString(),
      daysFetched: extra.daysFetched ?? 0,
      bytesBilled: extra.bytesBilled ?? 0,
    };
    writeRunStatus(dataDir, record);
    return { ...record, exitCode: extra.exitCode ?? 0 };
  };

  if (!client) {
    if (!isBigQueryAvailable(env)) {
      log('BigQuery credentials not configured.');
      let asOf = null;
      try {
        const db = new Database(dbPath, { readonly: true });
        asOf = newestStoredDay(db);
        db.close();
      } catch {
        // no readable store yet; asOf stays null
      }
      // A scheduled run that could not collect must go red, not read clean.
      return finish('skipped_no_credentials', { asOf, exitCode: env.GITHUB_ACTIONS ? 1 : 0 });
    }
    client = createBigQueryAdapter();
  }

  let db = null;
  let daysFetched = 0;
  let runBytes = 0;
  try {
    db = new Database(dbPath);
    ensureTables(db);

    // Population: every tracked package. PYPI_PACKAGES, when set, filters by
    // name; it is never required and never the source of the population.
    let packages = db.prepare('SELECT name FROM pypi_packages ORDER BY id').all().map(r => r.name);
    const filter = (env.PYPI_PACKAGES || '').split(',').map(p => p.trim()).filter(Boolean);
    if (filter.length > 0) packages = packages.filter(name => filter.includes(name));
    if (packages.length === 0) {
      throw new Error('no packages in pypi_packages (run collect-pypi first)');
    }

    const month = now.toISOString().slice(0, 7);
    let monthBytes = readBudget(dataDir, month);

    const missingDays = selectMissingDays(db, now);
    log('Fetching %d missing day(s) for %d packages', missingDays.length, packages.length);

    const packageIds = new Map(
      db.prepare('SELECT id, name FROM pypi_packages').all().map(r => [r.name, r.id])
    );
    const insertDaily = db.prepare(`
      INSERT INTO pypi_country_daily (package_id, date, country_code, downloads)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(package_id, date, country_code) DO UPDATE SET
        downloads = excluded.downloads
    `);
    const recordFetch = db.prepare(`
      INSERT INTO pypi_country_fetch_days (date, row_count, bytes_billed, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        row_count = excluded.row_count,
        bytes_billed = excluded.bytes_billed,
        fetched_at = excluded.fetched_at
    `);

    let rowsLanded = 0;
    for (const day of missingDays) {
      const dayIso = isoDay(day);
      const options = buildDayQueryOptions(packages, day);

      // Cap gate, dry run first: nothing is billed until both caps clear.
      const dry = await client.query({ ...options, dryRun: true });
      const estimate = Number(dry.totalBytesProcessed) || 0;
      if (estimate > PER_QUERY_CAP_BYTES) {
        log('Refusing %s: dry run estimates %d bytes, over the per-query cap', dayIso, estimate);
        return finish('refused_cap', {
          asOf: newestStoredDay(db), daysFetched, bytesBilled: runBytes, exitCode: 1,
        });
      }
      if (monthBytes + estimate > MONTH_CAP_BYTES) {
        log('Refusing %s: month-to-date %d + estimate %d bytes would pass the monthly cap',
          dayIso, monthBytes, estimate);
        return finish('capped_month', {
          asOf: newestStoredDay(db), daysFetched, bytesBilled: runBytes, exitCode: 1,
        });
      }

      const billed = await client.query({ ...options, maximumBytesBilled: PER_QUERY_CAP_BYTES });
      const billedBytes = Number(billed.totalBytesProcessed) || 0;
      monthBytes += billedBytes;
      runBytes += billedBytes;
      writeBudget(dataDir, month, monthBytes, now);

      const rows = billed.rows || [];
      for (const row of rows) {
        const packageId = packageIds.get(row.project);
        if (!packageId) continue;
        insertDaily.run(packageId, dayIso, row.country_code || 'unknown', Number(row.downloads) || 0);
      }
      recordFetch.run(dayIso, rows.length, billedBytes, now.toISOString());
      daysFetched += 1;
      rowsLanded += rows.length;
      log('  %s: %d rows, %d bytes billed', dayIso, rows.length, billedBytes);
    }

    const asOf = rollupCountryDownloads(db, now);
    const status = daysFetched > 0 && rowsLanded === 0 ? 'empty' : 'ok';
    log('Country stats collection complete (%s, as of %s).', status, asOf || 'never');
    return finish(status, { asOf, daysFetched, bytesBilled: runBytes, exitCode: 0 });
  } catch (error) {
    console.error('PyPI country collection failed: %s', error.message);
    let asOf = null;
    try { if (db) asOf = newestStoredDay(db); } catch { /* keep null */ }
    return finish('error', { asOf, daysFetched, bytesBilled: runBytes, exitCode: 1 });
  } finally {
    if (db) db.close();
  }
}

async function main() {
  require('dotenv').config();
  console.log('PyPI Country Download Stats Collector (BigQuery)');
  const result = await collect({});
  process.exit(result.exitCode);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error: %s', error.message);
    process.exit(1);
  });
}

module.exports = {
  collect,
  rollupCountryDownloads,
  selectMissingDays,
  buildDayQueryOptions,
  candidateDays,
  isBigQueryAvailable,
  createBigQueryAdapter,
  PER_QUERY_CAP_BYTES,
  MONTH_CAP_BYTES,
  WINDOW_DAYS,
  MAX_DAYS_PER_RUN,
  BUDGET_FILE,
  RUN_FILE,
};
