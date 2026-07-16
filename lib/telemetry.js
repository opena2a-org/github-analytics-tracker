/**
 * First-party CLI telemetry helpers.
 *
 * The Registry exposes an anonymous, coarse adoption projection at
 * GET /api/v1/telemetry/v1/adoption/public. These are ACTIVE USERS (distinct
 * install_id over rolling windows) — not downloads. A download is not a user,
 * so telemetry is always shown distinctly and NEVER summed into the download
 * "adoption" total (same rule as Chrome Web Store weekly-active users).
 *
 * This module holds the pure, network-free, db-free logic (feed validation +
 * tool→product attribution) so it can be unit-tested without a live Registry or
 * a SQLite file. The collector and the API routes import it.
 */

// Registry tool-id → dashboard product display name. Mirrors the product names
// used in pages/api/overview.js productMap so the same tool reads consistently
// across the download and active-user surfaces. Unknown ids fall through to the
// raw id (never invented) so a new CLI shows up rather than vanishing.
const TOOL_PRODUCT_NAMES = {
  hackmyagent: 'HackMyAgent',
  hma: 'HackMyAgent',
  opena2a: 'OpenA2A CLI',
  'opena2a-cli': 'OpenA2A CLI',
  'ai-trust': 'ai-trust',
  aitrust: 'ai-trust',
  secretless: 'Secretless AI',
  'secretless-ai': 'Secretless AI',
  aim: 'AIM',
  nanomind: 'NanoMind',
};

function toolDisplayName(toolId) {
  if (typeof toolId !== 'string' || toolId === '') return 'Unknown';
  return TOOL_PRODUCT_NAMES[toolId.toLowerCase()] || toolId;
}

// Strict non-negative integer coercion. Returns null for anything that is not a
// finite number >= 0, so validation can reject a malformed feed rather than
// silently persisting NaN/garbage as a real measurement.
function toCount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.trunc(v);
}

/**
 * Validate + normalize the Registry public adoption feed into the shape the
 * collector persists. Throws on a structurally invalid payload — an empty field
 * is better than a fabricated one, and a bad feed must not overwrite good data
 * with zeros. Every numeric field is measured by the Registry; we only coerce
 * types and drop rows we cannot trust.
 *
 * @param {object} feed parsed JSON from the public adoption endpoint
 * @returns {{generatedAt:string, retentionDays:number, wauWindowDays:number,
 *   mauWindowDays:number, totalInstalls:number, wau:number, mau:number,
 *   tools:Array, byCountry:Array}}
 */
function normalizeAdoptionFeed(feed) {
  if (!feed || typeof feed !== 'object') {
    throw new Error('adoption feed is not an object');
  }
  const totalInstalls = toCount(feed.totalInstalls);
  const wau = toCount(feed.wau);
  const mau = toCount(feed.mau);
  if (totalInstalls === null || wau === null || mau === null) {
    throw new Error('adoption feed missing/invalid fleet totals (totalInstalls/wau/mau)');
  }

  const tools = [];
  for (const t of Array.isArray(feed.tools) ? feed.tools : []) {
    if (!t || typeof t.tool !== 'string' || t.tool === '') continue;
    const ti = toCount(t.totalInstalls);
    const tw = toCount(t.wau);
    const tm = toCount(t.mau);
    if (ti === null || tw === null || tm === null) continue; // skip untrusted row, don't zero it
    // engagedMau is the sybil-dampened floor; older feeds may omit it → default 0.
    const teng = toCount(t.engagedMau) ?? 0;
    const versions = [];
    for (const v of Array.isArray(t.versions) ? t.versions : []) {
      if (!v || typeof v.version !== 'string' || v.version === '') continue;
      const vi = toCount(v.installs);
      if (vi === null) continue;
      versions.push({ version: v.version, installs: vi });
    }
    tools.push({ tool: t.tool, totalInstalls: ti, wau: tw, mau: tm, engagedMau: teng, versions });
  }

  const byCountry = [];
  for (const c of Array.isArray(feed.byCountry) ? feed.byCountry : []) {
    if (!c || typeof c.countryCode !== 'string' || c.countryCode === '') continue;
    const ci = toCount(c.installs);
    if (ci === null) continue;
    byCountry.push({ countryCode: c.countryCode, installs: ci });
  }

  return {
    generatedAt: typeof feed.generatedAt === 'string' ? feed.generatedAt : '',
    // Honest basis + limits, carried verbatim from the feed so the dashboard can
    // show it rather than presenting these unauthenticated-ingest counts as a
    // verified metric. Never fabricated — empty when the feed omits it.
    provenance: typeof feed.provenance === 'string' ? feed.provenance : '',
    retentionDays: toCount(feed.retentionDays) ?? 0,
    wauWindowDays: toCount(feed.wauWindowDays) ?? 0,
    mauWindowDays: toCount(feed.mauWindowDays) ?? 0,
    totalInstalls,
    wau,
    mau,
    // Sybil-dampened floor (installs with a real multi-day footprint). The
    // honest, defensible headline; raw wau/mau are shown as context. Default 0
    // for older feeds that predate the field.
    engagedMau: toCount(feed.engagedMau) ?? 0,
    engagedMinDays: toCount(feed.engagedMinDays) ?? 0,
    tools,
    byCountry,
  };
}

// Consecutive days a collection may fail before it stops being "transient" and
// becomes an outage worth failing on. Two days tolerates a single bad run plus a
// retry; anything longer is a real gap in the data.
const DEFAULT_STALE_AFTER_DAYS = 2;

function daysBetween(fromISODate, toISODate) {
  const from = Date.parse(`${fromISODate}T00:00:00Z`);
  const to = Date.parse(`${toISODate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}

/**
 * Decide how loudly a skipped/failed telemetry collection should complain.
 *
 * Why this exists: the collector had three separate silent `exit 0` paths — an
 * unset REGISTRY_URL, a failed fetch, and a failed validation. Each was
 * individually defensible (don't fail the daily workflow; don't write zeros over
 * a good snapshot), but together they made an outage look exactly like a healthy
 * no-op. Registry #283 dropped live CLI telemetry for ~7 days (2026-06-26 →
 * 2026-07-03) and nothing in the logs said so. Silence is not success.
 *
 * The rule: a single failed run is transient and warns. A sustained one is an
 * outage and fails. Losing the variable after it once worked is a regression and
 * fails immediately — that is a config being removed, not a flaky endpoint.
 *
 * Pure: no db, no network, no clock. The caller supplies `today` and the last
 * known-good snapshot date so this is testable and deterministic.
 *
 * @param {object} o
 * @param {string} o.reason human-readable cause, echoed into the message
 * @param {boolean} o.registryUrlSet whether REGISTRY_URL is configured
 * @param {string|null} o.lastSuccessDate YYYY-MM-DD of the newest stored
 *   snapshot, or null if the collector has never persisted one
 * @param {string} o.today YYYY-MM-DD
 * @param {number} [o.staleAfterDays]
 * @returns {{level:'warning'|'error', exitCode:0|1, message:string}}
 */
function classifyCollectionSkip({
  reason,
  registryUrlSet,
  lastSuccessDate,
  today,
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
}) {
  if (!registryUrlSet) {
    // Never configured: legitimately optional, and erroring every day before the
    // endpoint is provisioned would train everyone to ignore the annotation.
    if (!lastSuccessDate) {
      return {
        level: 'warning',
        exitCode: 0,
        message:
          'Telemetry collection is not configured: REGISTRY_URL is unset and no snapshot has ever been stored. ' +
          'Set the REGISTRY_URL repo variable to enable it.',
      };
    }
    // It worked before and the variable is now gone. That is someone removing
    // config, not a transient blip — say so on the first run.
    return {
      level: 'error',
      exitCode: 1,
      message:
        `REGISTRY_URL is unset but telemetry was collected as recently as ${lastSuccessDate}. ` +
        'The variable was removed or lost; collection has stopped.',
    };
  }

  if (!lastSuccessDate) {
    // Configured deliberately, yet nothing has ever landed. Broken setup.
    return {
      level: 'error',
      exitCode: 1,
      message:
        `Telemetry collection failed and has NEVER succeeded: ${reason}. ` +
        'REGISTRY_URL is set, so this is a broken feed or a wrong URL, not an unprovisioned one.',
    };
  }

  const age = daysBetween(lastSuccessDate, today);
  if (age === null) {
    return {
      level: 'error',
      exitCode: 1,
      message: `Telemetry collection failed: ${reason}. Could not parse last-success date ${lastSuccessDate}.`,
    };
  }

  if (age > staleAfterDays) {
    return {
      level: 'error',
      exitCode: 1,
      message:
        `Telemetry collection has failed for ${age} days (last good snapshot ${lastSuccessDate}): ${reason}. ` +
        'This is an outage, not a blip — the dashboard is serving stale active-user numbers.',
    };
  }

  return {
    level: 'warning',
    exitCode: 0,
    message:
      `Telemetry collection skipped: ${reason}. Last good snapshot ${lastSuccessDate} (${age}d ago); ` +
      `tolerating up to ${staleAfterDays}d before this becomes an error.`,
  };
}

module.exports = {
  normalizeAdoptionFeed,
  toolDisplayName,
  toCount,
  classifyCollectionSkip,
  daysBetween,
  DEFAULT_STALE_AFTER_DAYS,
  TOOL_PRODUCT_NAMES,
};
