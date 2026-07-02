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
    const versions = [];
    for (const v of Array.isArray(t.versions) ? t.versions : []) {
      if (!v || typeof v.version !== 'string' || v.version === '') continue;
      const vi = toCount(v.installs);
      if (vi === null) continue;
      versions.push({ version: v.version, installs: vi });
    }
    tools.push({ tool: t.tool, totalInstalls: ti, wau: tw, mau: tm, versions });
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
    tools,
    byCountry,
  };
}

module.exports = { normalizeAdoptionFeed, toolDisplayName, toCount, TOOL_PRODUCT_NAMES };
