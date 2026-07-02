const Database = require('better-sqlite3');
const path = require('path');
const { toolDisplayName } = require('../../lib/telemetry');

/**
 * Public first-party CLI telemetry API.
 *
 * Returns the COARSE adoption projection collected from the Registry's
 * anonymous public feed: fleet-wide active users (WAU/MAU), installs, per-tool
 * breakdown, version-adoption share, and installs by country — all measured
 * distinct-install counts. These are ACTIVE USERS, not downloads.
 *
 * Fine-grained telemetry (command usage, retention, error rates) is NOT served
 * here; it lives behind ANALYTICS_TRACKER_PASSWORD at /api/telemetry-detail.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300');
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  let db = null;

  try {
    db = new Database(dbPath, { readonly: true });
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_snapshots'"
    ).get();
    if (!tableExists) {
      return res.status(200).json({ available: false, snapshot: null, tools: [], byCountry: [] });
    }

    const latest = db.prepare(
      'SELECT * FROM telemetry_snapshots ORDER BY date DESC LIMIT 1'
    ).get();
    if (!latest) {
      return res.status(200).json({ available: false, snapshot: null, tools: [], byCountry: [] });
    }

    // Growth vs the snapshot on-or-before (latest - N days). Point-in-time
    // deltas of active-user counts, never a sum across days.
    const priorOnOrBefore = (days) => db.prepare(
      "SELECT wau, mau FROM telemetry_snapshots WHERE date <= date(?, ?) ORDER BY date DESC LIMIT 1"
    ).get(latest.date, `-${days} days`);
    const prior7 = priorOnOrBefore(7);
    const prior30 = priorOnOrBefore(30);

    const toolRows = db.prepare(
      'SELECT tool, total_installs, wau, mau FROM telemetry_tool_snapshots WHERE date = ? ORDER BY mau DESC, tool'
    ).all(latest.date);

    const versionRows = db.prepare(
      'SELECT tool, version, installs FROM telemetry_version_snapshots WHERE date = ? ORDER BY tool, installs DESC, version'
    ).all(latest.date);
    const versionsByTool = {};
    for (const v of versionRows) {
      (versionsByTool[v.tool] ||= []).push({ version: v.version, installs: v.installs });
    }

    const tools = toolRows.map(t => ({
      tool: t.tool,
      product: toolDisplayName(t.tool),
      totalInstalls: t.total_installs,
      wau: t.wau,
      mau: t.mau,
      versions: versionsByTool[t.tool] || [],
    }));

    const byCountry = db.prepare(
      'SELECT country_code, installs FROM telemetry_country_snapshots WHERE date = ? ORDER BY installs DESC, country_code'
    ).all(latest.date).map(c => ({ countryCode: c.country_code, installs: c.installs }));

    return res.status(200).json({
      available: true,
      snapshot: {
        asOf: latest.date,
        generatedAt: latest.generated_at,
        provenance: latest.provenance || '',
        retentionDays: latest.retention_days,
        wauWindowDays: latest.wau_window_days,
        mauWindowDays: latest.mau_window_days,
        totalInstalls: latest.total_installs,
        wau: latest.wau,
        mau: latest.mau,
        wauGrowth7d: prior7 ? latest.wau - prior7.wau : 0,
        mauGrowth30d: prior30 ? latest.mau - prior30.mau : 0,
      },
      tools,
      byCountry,
    });
  } catch (err) {
    return res.status(500).json({ error: 'telemetry read failed' });
  } finally {
    if (db) db.close();
  }
}
