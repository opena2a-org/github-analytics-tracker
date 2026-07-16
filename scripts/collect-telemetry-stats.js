const https = require('https');
const http = require('http');
const { URL } = require('url');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

const {
  normalizeAdoptionFeed,
  classifyCollectionSkip,
  classifyFeedHealth,
  sanitizeForLog,
} = require('../lib/telemetry');

/*
 * First-party CLI telemetry collector.
 *
 * Consumes the Registry's COARSE public adoption feed
 *   GET {REGISTRY_URL}/api/v1/telemetry/v1/adoption/public
 * and snapshots the distinct-install aggregates (installs, WAU/MAU per tool,
 * version-adoption share, installs by country) into analytics.db once per day.
 *
 * These are ACTIVE USERS, not downloads — a download is not a user — so they
 * are stored and displayed distinctly and are never summed into the download
 * "adoption" total (same rule as Chrome weekly-active users).
 *
 * The feed is anonymous and coarse by construction, so ONLY coarse data lands
 * in this committed database. Fine-grained telemetry (command usage, retention,
 * error rates) is fetched live behind ANALYTICS_TRACKER_PASSWORD by the
 * dashboard and is never persisted here.
 *
 * Config (env):
 *   REGISTRY_URL=https://api.oa2a.org       # Registry base URL (required)
 *   TELEMETRY_STALE_AFTER_DAYS=2            # optional; consecutive failure days
 *                                           # tolerated before this exits 1
 *
 * Failure policy: a single failed run warns and exits 0 (a transient feed blip
 * must not fail the daily workflow, and must never write zeros over a good
 * snapshot). A SUSTAINED failure exits 1 — see classifyCollectionSkip in
 * lib/telemetry.js for the full rule and the incident that motivated it.
 *
 * The workflow marks this step continue-on-error, so a non-zero exit surfaces
 * the failure without dropping the other collectors' data for the day (this
 * step runs before generate-md and the commit step).
 */
const REGISTRY_URL = (process.env.REGISTRY_URL || '').trim().replace(/\/+$/, '');
// Left unvalidated here on purpose: normalizeStaleAfterDays inside
// classifyCollectionSkip rejects anything that is not a non-negative integer and
// falls back to the default. Number('') === 0 would otherwise set the tolerance
// to zero for the standard `${{ vars.UNSET }}` Actions pattern.
const STALE_AFTER_DAYS = process.env.TELEMETRY_STALE_AFTER_DAYS;

const FEED_PATH = '/api/v1/telemetry/v1/adoption/public';
const FEED_TIMEOUT_MS = Number(process.env.TELEMETRY_FEED_TIMEOUT_MS) || 30000;
// TELEMETRY_DB_PATH exists so the tests can drive the real script against
// fixture databases (corrupt, empty, no-table, drained). Every bug the reviews
// found in this collector lived in the db/annotation glue rather than in the
// pure classifiers, and that glue was untestable while this was hardcoded.
// Unset in production, where it resolves to the committed database.
const dbPath = process.env.TELEMETRY_DB_PATH || path.join(__dirname, '..', 'data', 'analytics.db');
const today = new Date().toISOString().split('T')[0];

/**
 * Emit a GitHub Actions annotation so a failure is visible in the run summary
 * and the PR/commit UI, not just buried in step output nobody opens. No-op
 * locally.
 */
/**
 * Emit a GitHub Actions annotation so a failure surfaces in the run summary and
 * the commit UI, not only in step output nobody opens.
 *
 * The runner scans stdout AND stderr for `::command::` lines, so `message` must
 * already be sanitized by the caller — sanitizing only here would leave the
 * console.* sinks below as an open injection path. Sanitizing again is cheap
 * and keeps this safe if a future caller forgets.
 */
function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${sanitizeForLog(message, 500)}`);
  }
}

/**
 * Newest stored snapshot, three-valued.
 *
 *   { state: 'known', date }  — a snapshot exists
 *   { state: 'never' }        — the store is readable and holds nothing
 *   { state: 'unknown', ... } — the store could not be read
 *
 * The distinction matters: collapsing 'unknown' into 'never' makes the
 * collector assert "has never succeeded" when the truth is "the database is
 * corrupt and 60 days of data may be sitting in it" — a confident, wrong
 * diagnosis pointing the operator at the wrong system.
 */
function readLastSuccess() {
  let db;
  try {
    if (!fs.existsSync(dbPath)) return { state: 'never' };
    db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT MAX(date) AS d FROM telemetry_snapshots').get();
    return row && row.d ? { state: 'known', date: row.d } : { state: 'never' };
  } catch (err) {
    // A missing table means the schema predates telemetry: readable, empty.
    if (/no such table/i.test(err.message || '')) return { state: 'never' };
    return { state: 'unknown', detail: err.message };
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
}

/**
 * Newest stored snapshot that had ANY active users, for the drain check.
 *
 * Deliberately not "yesterday": comparing against yesterday makes the alert
 * self-silencing, because the first zero day persists and becomes the baseline
 * every later day is measured against. Keying on the last LIVE snapshot keeps
 * the alarm ringing until someone fixes it.
 */
function readLastLiveTotals() {
  let db;
  try {
    if (!fs.existsSync(dbPath)) return null;
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        'SELECT date, mau, total_installs AS totalInstalls FROM telemetry_snapshots ' +
          'WHERE date < ? AND mau > 0 ORDER BY date DESC LIMIT 1'
      )
      .get(today);
    return row || null;
  } catch {
    return null;
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
}

/**
 * Report a skipped/failed collection at the right volume and exit.
 * Never writes data — a bad run must not overwrite a good snapshot with zeros.
 */
function reportSkipAndExit(reason) {
  const { level, exitCode, message } = classifyCollectionSkip({
    reason,
    registryUrlSet: Boolean(REGISTRY_URL),
    lastSuccess: readLastSuccess(),
    today,
    staleAfterDays: STALE_AFTER_DAYS,
  });
  // `message` is sanitized by the classifier, so both sinks are safe.
  annotate(level, message);
  if (level === 'error') console.error('  %s', message);
  else console.warn('  %s', message);
  process.exit(exitCode);
}

if (require.main === module && !REGISTRY_URL) {
  reportSkipAndExit('REGISTRY_URL is not set');
}

function httpGetJson(rawUrl) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (e) {
      reject(new Error(`invalid REGISTRY_URL: ${e.message}`));
      return;
    }
    const client = url.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': 'github-analytics-tracker', Accept: 'application/json' };
    const req = client.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    // Without this a registry that accepts the connection and never answers
    // hangs the daily workflow until the job's own limit kills it — a silent
    // failure of a different shape, and one that also takes the other
    // collectors' commit down with it.
    req.setTimeout(FEED_TIMEOUT_MS, () => {
      req.destroy(new Error(`feed request timed out after ${FEED_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

function persist(db, feed) {
  const upsertSnapshot = db.prepare(`
    INSERT INTO telemetry_snapshots
      (date, generated_at, provenance, retention_days, wau_window_days, mau_window_days, total_installs, wau, mau, engaged_mau, engaged_min_days)
    VALUES (@date, @generatedAt, @provenance, @retentionDays, @wauWindowDays, @mauWindowDays, @totalInstalls, @wau, @mau, @engagedMau, @engagedMinDays)
    ON CONFLICT(date) DO UPDATE SET
      generated_at = excluded.generated_at,
      provenance = excluded.provenance,
      retention_days = excluded.retention_days,
      wau_window_days = excluded.wau_window_days,
      mau_window_days = excluded.mau_window_days,
      total_installs = excluded.total_installs,
      wau = excluded.wau,
      mau = excluded.mau,
      engaged_mau = excluded.engaged_mau,
      engaged_min_days = excluded.engaged_min_days,
      collected_at = CURRENT_TIMESTAMP
  `);

  const upsertTool = db.prepare(`
    INSERT INTO telemetry_tool_snapshots (date, tool, total_installs, wau, mau, engaged_mau)
    VALUES (@date, @tool, @totalInstalls, @wau, @mau, @engagedMau)
    ON CONFLICT(date, tool) DO UPDATE SET
      total_installs = excluded.total_installs, wau = excluded.wau, mau = excluded.mau,
      engaged_mau = excluded.engaged_mau,
      collected_at = CURRENT_TIMESTAMP
  `);

  const upsertVersion = db.prepare(`
    INSERT INTO telemetry_version_snapshots (date, tool, version, installs)
    VALUES (@date, @tool, @version, @installs)
    ON CONFLICT(date, tool, version) DO UPDATE SET
      installs = excluded.installs, collected_at = CURRENT_TIMESTAMP
  `);

  const upsertCountry = db.prepare(`
    INSERT INTO telemetry_country_snapshots (date, country_code, installs)
    VALUES (@date, @countryCode, @installs)
    ON CONFLICT(date, country_code) DO UPDATE SET
      installs = excluded.installs, collected_at = CURRENT_TIMESTAMP
  `);

  // Replace the day's child rows wholesale so a re-run with a shrunk tool /
  // version / country set can't leave stale rows behind (upsert alone never
  // deletes). The single fleet-wide snapshot row stays an upsert.
  const clearTools = db.prepare('DELETE FROM telemetry_tool_snapshots WHERE date = ?');
  const clearVersions = db.prepare('DELETE FROM telemetry_version_snapshots WHERE date = ?');
  const clearCountries = db.prepare('DELETE FROM telemetry_country_snapshots WHERE date = ?');

  // One transaction so a partial write can't leave a snapshot half-updated.
  const write = db.transaction(() => {
    upsertSnapshot.run({ date: today, ...feed });
    clearTools.run(today);
    clearVersions.run(today);
    clearCountries.run(today);
    for (const t of feed.tools) {
      upsertTool.run({ date: today, tool: t.tool, totalInstalls: t.totalInstalls, wau: t.wau, mau: t.mau, engagedMau: t.engagedMau });
      for (const v of t.versions) {
        upsertVersion.run({ date: today, tool: t.tool, version: v.version, installs: v.installs });
      }
    }
    for (const c of feed.byCountry) {
      upsertCountry.run({ date: today, countryCode: c.countryCode, installs: c.installs });
    }
  });
  write();
}

function writeBadge(feed) {
  // Headline is monthly active users (the honest "how many people use this"
  // number), mirroring the docker/hf badge convention.
  const badge = {
    schemaVersion: 1,
    label: 'active CLI users (MAU)',
    message: feed.mau.toLocaleString(),
    color: 'brightgreen',
    style: 'flat',
  };
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'telemetry-badge.json'),
    JSON.stringify(badge, null, 2)
  );
}

async function main() {
  console.log('First-party CLI telemetry collector');
  console.log('Date: %s', today);
  console.log('Registry: %s', REGISTRY_URL);

  let raw;
  try {
    raw = await httpGetJson(REGISTRY_URL + FEED_PATH);
  } catch (err) {
    // A transient feed must not fail the workflow or write zeros over a good
    // snapshot — but a sustained one is an outage, so let the classifier decide
    // rather than swallowing every failure the same way.
    reportSkipAndExit(`feed fetch failed: ${err.message}`);
  }

  let feed;
  try {
    feed = normalizeAdoptionFeed(raw);
  } catch (err) {
    reportSkipAndExit(`feed failed validation: ${err.message}`);
  }

  // Read BEFORE writing, so today's row can't become the thing we compare to.
  const lastLive = readLastLiveTotals();

  const db = new Database(dbPath);
  try {
    persist(db, feed);
    writeBadge(feed);
  } finally {
    db.close();
  }

  console.log(
    '  Installs: %d | WAU: %d | MAU: %d | engaged(MAU): %d | tools: %d | countries: %d',
    feed.totalInstalls, feed.wau, feed.mau, feed.engagedMau, feed.tools.length, feed.byCountry.length
  );

  // A retrieval check cannot see a feed that answers 200 with drained numbers,
  // which is exactly what a broken ingest looks like from here. The zeros are
  // recorded as reported — we don't suppress what the feed said — but a live
  // fleet does not drop to zero overnight, so say so loudly, every day, until
  // it is fixed.
  const health = classifyFeedHealth(feed, lastLive, today);
  if (health) {
    annotate(health.level, health.message);
    console.error('  %s', health.message);
    process.exit(1);
  }

  console.log('First-party telemetry collection complete.');
}

if (require.main === module) {
  main().catch(error => {
    const msg = sanitizeForLog(error && error.message);
    annotate('error', `Telemetry collector crashed: ${msg}`);
    console.error('Fatal error: %s', msg);
    process.exit(1);
  });
}

// Exported for test/telemetry-collector.test.js, which drives the real script as
// a subprocess against fixture databases. Mirrors collect-chrome-stats.js
// exporting parseListing for test/chrome.test.js. The db readers are bound to
// the module-level dbPath, so the tests exercise them through the CLI rather
// than by calling them directly.
module.exports = { annotate, readLastSuccess, readLastLiveTotals };
