/**
 * PyPI country download stats collector (BigQuery public dataset).
 *
 * One query per closed UTC day covering ALL tracked packages at once, issued
 * through an injectable BigQuery-like client and gated by two byte caps:
 *   - 128 GiB per query   (a dry run estimates first; the billed query carries
 *     maximumBytesBilled so BigQuery enforces the same ceiling server-side,
 *     and a job it refuses there ends the run as refused_cap)
 *   - 768 GiB per month   (a persisted ledger of billed bytes, data/pypi-country-budget.json,
 *     floored by the bytes the store's fetch records show billed this month,
 *     so a checkout that lacks the ledger file still counts the month's spend)
 *
 * Per run it fetches at most three missing closed days (newest first, from the
 * 30 most recent closed days; no backfill beyond that window), lands the rows
 * in pypi_country_daily keyed by the closed day itself, then rewrites the
 * 30-day rollup in pypi_country_downloads as a local SUM — no query. A run
 * that stops early (a cap, a refusal, an error) still rewrites the rollup
 * when it landed at least one day.
 *
 * Every run ends by persisting data/pypi-country-run.json with a status from
 * {ok, empty, skipped_no_credentials, refused_cap, capped_month, error}. A
 * scheduled run (GITHUB_ACTIONS set) that has no credentials exits 1 so the
 * workflow goes red instead of silently reading clean.
 *
 * `--dry-run` (estimate()) measures before anything is paid for: it issues
 * only the dry runs for the days the next run would fetch, reports each scan
 * size against both caps, and bills nothing and writes nothing (no rows, no
 * ledger, no run status). It exits 0 only when the next run would clear both
 * caps; when every candidate day is already fetched, it measures D-1 as a
 * sample and exits 0 only when a new day of that size would clear them.
 * npm_config_dry_run=true, which npm sets for
 * `npm run collect:pypi-countries --dry-run`, selects it as well; any other
 * argument exits 2 with a usage message before anything runs.
 *
 * The client port this module consumes: one async `query(options)` that
 * resolves to { rows, totalBytesProcessed } for both dry and billed runs. A
 * billed query BigQuery refuses at maximumBytesBilled rejects with the
 * library's API error, whose errors list carries the reason
 * bytesBilledLimitExceeded. Tests inject a fake; createBigQueryAdapter()
 * wraps @google-cloud/bigquery for real runs, and tests drive it over a
 * BigQuery instance with a stubbed transport so the ceiling is checked in the
 * job request BigQuery receives.
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
function isBigQueryAvailable(env = process.env, log = console.log) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (fs.existsSync(env.GOOGLE_APPLICATION_CREDENTIALS)) {
      return true;
    }
    log('Warning: GOOGLE_APPLICATION_CREDENTIALS is set but the file does not exist: %s',
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
 * Population: every tracked package. PYPI_PACKAGES, when set, filters by
 * name; it is never required and never the source of the population.
 */
function trackedPackages(db, env) {
  let packages = db.prepare('SELECT name FROM pypi_packages ORDER BY id').all().map(r => r.name);
  const filter = (env.PYPI_PACKAGES || '').split(',').map(p => p.trim()).filter(Boolean);
  if (filter.length > 0) packages = packages.filter(name => filter.includes(name));
  if (packages.length === 0) {
    throw new Error('no packages in pypi_packages (run collect-pypi first)');
  }
  return packages;
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

/**
 * A byte figure as BigQuery reports it: a non-negative integer, as a number or
 * an int64 digit-string. Anything else (null, '', false, a float, a
 * scientific-notation string, an object) is null, never coerced to 0 -- the
 * ledger's reader accepts only integers, and a coerced 0 is how a cap is
 * bypassed.
 */
function readByteFigure(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * True when BigQuery refused a job at its maximumBytesBilled. The library
 * raises that refusal as an API error whose errors list carries the reason
 * bytesBilledLimitExceeded, whether the job insert or the results read
 * reports it. BigQuery bills nothing for a job it refuses there.
 */
function isBytesBilledLimitRefusal(error) {
  return Boolean(error) && Array.isArray(error.errors)
    && error.errors.some(e => e && e.reason === 'bytesBilledLimitExceeded');
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

/**
 * Bytes the store records as billed in `month`: the per-day charges in
 * pypi_country_fetch_days whose fetch ran that month. The store is committed
 * with the collected days and the ledger file is not, so on a fresh checkout
 * this is the month-to-date figure that survived. 0 before the table exists.
 * Fail closed: a day of the month whose figure is not a non-negative integer
 * throws, since a negative or text figure would lower the sum, and so does a
 * total that is not one, rather than reading as 0.
 */
function storeMonthBytes(db, month) {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_country_fetch_days'"
  ).get();
  if (!table) return 0;
  const { unreadable } = db.prepare(`
    SELECT COUNT(*) AS unreadable
    FROM pypi_country_fetch_days
    WHERE substr(fetched_at, 1, 7) = ?
      AND (typeof(bytes_billed) != 'integer' OR bytes_billed < 0)
  `).get(month);
  if (unreadable > 0) {
    throw new Error(`unreadable billed-bytes figure on ${unreadable} day(s) of ${month} in pypi_country_fetch_days`);
  }
  const { total } = db.prepare(`
    SELECT COALESCE(SUM(bytes_billed), 0) AS total
    FROM pypi_country_fetch_days
    WHERE substr(fetched_at, 1, 7) = ?
  `).get(month);
  const bytes = readByteFigure(total);
  if (bytes === null) {
    throw new Error(`unreadable billed-bytes total in pypi_country_fetch_days (${String(total)})`);
  }
  return bytes;
}

/**
 * Month-to-date billed bytes: the larger of the ledger file and the store,
 * because either one can be stale. The ledger file is not committed, so a
 * checkout may lack it or carry one older than the store's fetch records;
 * the store never sees the reservation the ledger keeps for a billed call
 * that failed. Taking the larger can over-count, never under-count.
 */
function monthToDate(db, dataDir, month) {
  return Math.max(readBudget(dataDir, month), storeMonthBytes(db, month));
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
 * The whole table is replaced, not just the as-of rows: a stale snapshot at
 * any other date would otherwise shadow the rollup through the consumers'
 * MAX(date) reads.
 */
function rollupCountryDownloads(db, now) {
  const asOf = newestStoredDay(db);
  if (!asOf) return null;
  const today = utcMidnight(now);
  const windowStart = isoDay(addDays(today, -WINDOW_DAYS));
  const windowEnd = isoDay(addDays(today, -1));
  // One transaction: an insert that aborts must not leave the table empty.
  db.transaction(() => {
    db.prepare('DELETE FROM pypi_country_downloads').run();
    db.prepare(`
      INSERT INTO pypi_country_downloads (package_id, date, country_code, downloads)
      SELECT package_id, ?, country_code, SUM(downloads)
      FROM pypi_country_daily
      WHERE date >= ? AND date <= ?
      GROUP BY package_id, country_code
    `).run(asOf, windowStart, windowEnd);
  })();
  return asOf;
}

/**
 * Thin adapter producing the client port over @google-cloud/bigquery. Options
 * pass through to createQueryJob unchanged, so the billed call's
 * maximumBytesBilled lands in the job's query configuration and BigQuery
 * refuses a job that would bill past it. `bigquery` defaults to a client
 * built from the environment's credentials.
 */
function createBigQueryAdapter(bigquery = null) {
  if (!bigquery) {
    const { BigQuery } = require('@google-cloud/bigquery');
    bigquery = new BigQuery();
  }
  return {
    async query(options) {
      const [job] = await bigquery.createQueryJob(options);
      if (options.dryRun) {
        const stats = job.metadata?.statistics || {};
        if (readByteFigure(stats.totalBytesProcessed) === null) {
          // Fail closed: an estimate we cannot read must never bill as 0.
          throw new Error('dry-run job statistics carry no readable totalBytesProcessed');
        }
        return { rows: [], totalBytesProcessed: readByteFigure(stats.totalBytesProcessed) };
      }
      const [rows] = await job.getQueryResults();
      const [metadata] = await job.getMetadata();
      const stats = metadata?.statistics || {};
      // No fallback to 0: an unreadable billed figure surfaces as null so the
      // caller charges the dry-run estimate instead of under-counting.
      return { rows, totalBytesProcessed: readByteFigure(stats.query?.totalBytesBilled ?? stats.totalBytesProcessed) };
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
  // Every exit path writes the status file; make sure its directory exists.
  fs.mkdirSync(dataDir, { recursive: true });

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
    if (!isBigQueryAvailable(env, log)) {
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

    const packages = trackedPackages(db, env);

    const month = now.toISOString().slice(0, 7);
    let monthBytes = monthToDate(db, dataDir, month);

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

    // One transaction per landed day: the daily rows and the fetch record
    // appear together or not at all, so a crash cannot leave a day half
    // written (present rows, no record) to be re-billed.
    const landDay = db.transaction((dayIso, rows, charge) => {
      for (const row of rows) {
        const packageId = packageIds.get(row.project);
        if (!packageId) continue;
        insertDaily.run(packageId, dayIso, row.country_code || 'unknown', Number(row.downloads) || 0);
      }
      recordFetch.run(dayIso, rows.length, charge, now.toISOString());
    });

    let rowsLanded = 0;
    // A run that stops early still rolls up the days it already landed, so
    // the 30-day total never lags the daily rows.
    const stop = (status) => finish(status, {
      asOf: daysFetched > 0 ? rollupCountryDownloads(db, now) : newestStoredDay(db),
      daysFetched, bytesBilled: runBytes, exitCode: 1,
    });
    for (const day of missingDays) {
      const dayIso = isoDay(day);
      const options = buildDayQueryOptions(packages, day);

      // Cap gate, dry run first: nothing is billed until both caps clear.
      // Fail closed: an estimate that is not a finite non-negative number
      // must never compare as 0 and let the day bill.
      const dry = await client.query({ ...options, dryRun: true });
      const estimate = readByteFigure(dry.totalBytesProcessed);
      if (estimate === null) {
        log('Refusing %s: unreadable dry-run estimate (%s)', dayIso, String(dry.totalBytesProcessed));
        return stop('error');
      }
      if (estimate > PER_QUERY_CAP_BYTES) {
        log('Refusing %s: dry run estimates %d bytes, over the per-query cap', dayIso, estimate);
        return stop('refused_cap');
      }
      if (monthBytes + estimate > MONTH_CAP_BYTES) {
        log('Refusing %s: month-to-date %d + estimate %d bytes would pass the monthly cap',
          dayIso, monthBytes, estimate);
        return stop('capped_month');
      }

      // Reservation: charge the estimate to the ledger BEFORE the billed call.
      // If the call throws after the job may have run, the reservation stands,
      // so the month ledger can only over-count a billed query, never
      // under-count one; on success it is rewritten with the actual figure,
      // and on BigQuery's own ceiling refusal, which bills nothing, it is
      // released.
      writeBudget(dataDir, month, monthBytes + estimate, now);

      let billed;
      try {
        billed = await client.query({ ...options, maximumBytesBilled: PER_QUERY_CAP_BYTES });
      } catch (error) {
        if (!isBytesBilledLimitRefusal(error)) throw error;
        // The ceiling held: BigQuery refused the job and billed nothing, so
        // the reservation is released. Any other failure keeps it, since
        // that job may have run.
        writeBudget(dataDir, month, monthBytes, now);
        log('Refusing %s: BigQuery refused the job at the %d byte ceiling; nothing was billed',
          dayIso, PER_QUERY_CAP_BYTES);
        return stop('refused_cap');
      }
      const billedBytes = readByteFigure(billed.totalBytesProcessed);
      // An unreadable, negative or non-integer billed figure charges the
      // estimate: never enter less than we reserved into the ledger for a
      // query that ran, and never a value the ledger's reader would reject.
      const charge = billedBytes === null ? estimate : billedBytes;
      monthBytes += charge;
      runBytes += charge;
      writeBudget(dataDir, month, monthBytes, now);

      const rows = billed.rows || [];
      landDay(dayIso, rows, charge);
      daysFetched += 1;
      rowsLanded += rows.length;
      log('  %s: %d rows, %d bytes billed', dayIso, rows.length, charge);
    }

    const asOf = rollupCountryDownloads(db, now);
    const status = daysFetched > 0 && rowsLanded === 0 ? 'empty' : 'ok';
    log('Country stats collection complete (%s, as of %s).', status, asOf || 'never');
    return finish(status, { asOf, daysFetched, bytesBilled: runBytes, exitCode: 0 });
  } catch (error) {
    console.error('PyPI country collection failed: %s', error.message);
    let asOf = null;
    if (db) {
      // Days that landed before the failure still reach the rollup.
      try {
        asOf = daysFetched > 0 ? rollupCountryDownloads(db, now) : newestStoredDay(db);
      } catch {
        try { asOf = newestStoredDay(db); } catch { /* keep null */ }
      }
    }
    return finish('error', { asOf, daysFetched, bytesBilled: runBytes, exitCode: 1 });
  } finally {
    if (db) db.close();
  }
}

function gib(bytes) {
  return (bytes / 1073741824).toFixed(2);
}

/**
 * Dry-run entry point: what would the next run scan, and would it clear both
 * caps? BigQuery dry runs are free, so every day is measured even after one
 * fails a cap; the status is the refusal the run itself would hit first.
 * Opens the store read-only and writes no file.
 *
 * Returns { status, days: [{ date, bytes, fetched }], estimatedBytes,
 * monthToDateBytes, perQueryCapBytes, monthCapBytes, exitCode } with status
 * from {estimated, refused_cap, capped_month, skipped_no_credentials, error};
 * exitCode is 0 only for estimated. When every candidate day is already
 * fetched, the next run bills nothing; D-1 is then measured as a sample with
 * fetched: true, and the status and exitCode are the verdict for a new day
 * of that size, not for the next run.
 */
async function estimate({
  client = null,
  dbPath = null,
  dataDir = null,
  now = new Date(),
  env = process.env,
  log = console.log,
} = {}) {
  dbPath = dbPath || env.ANALYTICS_DB_PATH || path.join(__dirname, '..', 'data', 'analytics.db');
  dataDir = dataDir || path.dirname(dbPath);
  const month = now.toISOString().slice(0, 7);
  // The ledger file alone until the store is open; then the figure collect() uses.
  let monthToDateBytes = readBudget(dataDir, month);
  const days = [];
  const finish = (status) => {
    const measured = days.length > 0 && days.every(d => d.bytes !== null);
    return {
      status,
      days,
      estimatedBytes: measured ? days.reduce((sum, d) => sum + d.bytes, 0) : null,
      monthToDateBytes,
      perQueryCapBytes: PER_QUERY_CAP_BYTES,
      monthCapBytes: MONTH_CAP_BYTES,
      exitCode: status === 'estimated' ? 0 : 1,
    };
  };

  if (!client) {
    if (!isBigQueryAvailable(env, log)) {
      log('BigQuery credentials not configured; nothing was measured.');
      return finish('skipped_no_credentials');
    }
    client = createBigQueryAdapter();
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    monthToDateBytes = monthToDate(db, dataDir, month);
    const packages = trackedPackages(db, env);
    const fetchTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_country_fetch_days'"
    ).get();
    let targets = fetchTable
      ? selectMissingDays(db, now)
      : candidateDays(now).slice(0, MAX_DAYS_PER_RUN);
    const sample = targets.length === 0;
    if (sample) targets = candidateDays(now).slice(0, 1);

    log('Dry run only: nothing is billed and nothing is written.');
    if (sample) log('Every candidate day is already fetched; measuring %s as a sample.', isoDay(targets[0]));

    for (const day of targets) {
      const dayIso = isoDay(day);
      const dry = await client.query({ ...buildDayQueryOptions(packages, day), dryRun: true });
      const bytes = readByteFigure(dry.totalBytesProcessed);
      days.push({ date: dayIso, bytes, fetched: sample });
      if (bytes === null) {
        log('  %s: unreadable dry-run estimate (%s)', dayIso, String(dry.totalBytesProcessed));
        return finish('error');
      }
      log('  %s: %d bytes (%s GiB) for %d packages', dayIso, bytes, gib(bytes), packages.length);
    }

    // The refusal the run would hit first, in the order it checks: each day's
    // per-query cap, then month-to-date plus that day's estimate.
    let status = 'estimated';
    let monthBytes = monthToDateBytes;
    for (const { bytes } of days) {
      if (bytes > PER_QUERY_CAP_BYTES) { status = 'refused_cap'; break; }
      if (monthBytes + bytes > MONTH_CAP_BYTES) { status = 'capped_month'; break; }
      monthBytes += bytes;
    }
    const result = finish(status);
    log('Per-query cap %s GiB; month to date %s GiB billed, %s %s GiB of the %s GiB monthly cap.',
      gib(PER_QUERY_CAP_BYTES), gib(monthToDateBytes),
      sample ? 'a new day of this size would add' : 'these queries add',
      gib(result.estimatedBytes), gib(MONTH_CAP_BYTES));
    if (sample) {
      // The next run selects no day, so no cap can refuse it; the verdict is
      // a prediction for the next day that closes.
      log('The next run would bill nothing: every candidate day is already fetched.');
      log(status === 'estimated'
        ? 'A new day of this size would clear both caps.'
        : `A new day of this size would be refused (${status}).`);
    } else {
      log(status === 'estimated'
        ? 'The next run would clear both caps.'
        : `The next run would be refused (${status}).`);
    }
    return result;
  } catch (error) {
    console.error('PyPI country dry run failed: %s', error.message);
    return finish('error');
  } finally {
    if (db) db.close();
  }
}

const USAGE = 'Usage: npm run collect:pypi-countries -- [--dry-run]';

/**
 * Read the command line. `--dry-run` is the only argument; anything else is
 * refused, never read as a request for a billed collection. Without the `--`
 * separator, `npm run collect:pypi-countries --dry-run` keeps the flag for
 * npm, which passes it on as npm_config_dry_run=true, so that is a dry run
 * too. Returns { dryRun } or { error }.
 */
function parseArgs(argv, env = process.env) {
  const unknown = argv.filter(arg => arg !== '--dry-run');
  if (unknown.length > 0) {
    return { error: `Unrecognised argument(s): ${unknown.join(' ')}` };
  }
  return { dryRun: argv.includes('--dry-run') || env.npm_config_dry_run === 'true' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    console.error(USAGE);
    process.exit(2);
  }
  require('dotenv').config();
  console.log('PyPI Country Download Stats Collector (BigQuery)');
  const result = args.dryRun ? await estimate({}) : await collect({});
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
  estimate,
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
  readByteFigure,
};
