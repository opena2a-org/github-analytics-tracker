const https = require('https');
const http = require('http');
const { URL } = require('url');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

const { normalizeAdoptionFeed } = require('../lib/telemetry');

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
 *   REGISTRY_URL=https://registry.opena2a.org   # Registry base URL (required)
 *
 * If REGISTRY_URL is unset the collector skips gracefully (exit 0), so the
 * daily workflow doesn't fail before the Registry endpoint is provisioned.
 */
const REGISTRY_URL = (process.env.REGISTRY_URL || '').trim().replace(/\/+$/, '');

if (!REGISTRY_URL) {
  console.log('REGISTRY_URL not set — skipping first-party telemetry collection.');
  process.exit(0);
}

const FEED_PATH = '/api/v1/telemetry/v1/adoption/public';
const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const today = new Date().toISOString().split('T')[0];

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
    client.get(url, { headers }, (res) => {
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
    }).on('error', reject);
  });
}

function persist(db, feed) {
  const upsertSnapshot = db.prepare(`
    INSERT INTO telemetry_snapshots
      (date, generated_at, provenance, retention_days, wau_window_days, mau_window_days, total_installs, wau, mau)
    VALUES (@date, @generatedAt, @provenance, @retentionDays, @wauWindowDays, @mauWindowDays, @totalInstalls, @wau, @mau)
    ON CONFLICT(date) DO UPDATE SET
      generated_at = excluded.generated_at,
      provenance = excluded.provenance,
      retention_days = excluded.retention_days,
      wau_window_days = excluded.wau_window_days,
      mau_window_days = excluded.mau_window_days,
      total_installs = excluded.total_installs,
      wau = excluded.wau,
      mau = excluded.mau,
      collected_at = CURRENT_TIMESTAMP
  `);

  const upsertTool = db.prepare(`
    INSERT INTO telemetry_tool_snapshots (date, tool, total_installs, wau, mau)
    VALUES (@date, @tool, @totalInstalls, @wau, @mau)
    ON CONFLICT(date, tool) DO UPDATE SET
      total_installs = excluded.total_installs, wau = excluded.wau, mau = excluded.mau,
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
      upsertTool.run({ date: today, tool: t.tool, totalInstalls: t.totalInstalls, wau: t.wau, mau: t.mau });
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
    // A transient/unavailable feed must not fail the whole daily workflow, and
    // must not write zeros over yesterday's real snapshot. Skip this run.
    console.error('  Feed fetch failed: %s — skipping (no data written).', err.message);
    process.exit(0);
  }

  let feed;
  try {
    feed = normalizeAdoptionFeed(raw);
  } catch (err) {
    console.error('  Feed failed validation: %s — skipping (no data written).', err.message);
    process.exit(0);
  }

  const db = new Database(dbPath);
  try {
    persist(db, feed);
    writeBadge(feed);
  } finally {
    db.close();
  }

  console.log(
    '  Installs: %d | WAU: %d | MAU: %d | tools: %d | countries: %d',
    feed.totalInstalls, feed.wau, feed.mau, feed.tools.length, feed.byCountry.length
  );
  console.log('First-party telemetry collection complete.');
}

main().catch(error => {
  console.error('Fatal error: %s', error.message);
  process.exit(1);
});
