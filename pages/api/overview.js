const Database = require('better-sqlite3');
const path = require('path');
const { computeOverview } = require('../../lib/overview');
const { readDataCollectedAt } = require('../../lib/freshness');

/**
 * Overview API: Returns combined GitHub + npm metrics suitable for
 * investor presentations, dashboards, and growth tracking. All computation
 * lives in lib/overview.js; dataCollectedAt, the time the data was collected,
 * is read from data/summary.json by lib/freshness.js.
 */
export default async function handler(req, res) {
  // Cache response on Vercel edge for 5 minutes
  res.setHeader('Cache-Control', 's-maxage=300');
  const dataDir = path.join(process.cwd(), 'data');
  const dbPath = path.join(dataDir, 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  // Custom date range support
  const { start, end } = req.query;

  try {
    res.status(200).json({
      ...computeOverview(db, { start, end }),
      // When the data was collected (null when summary.json has no readable
      // stamp). lastUpdated stays the moment this answer was computed.
      dataCollectedAt: readDataCollectedAt(dataDir),
    });
  } catch (error) {
    console.error('Error fetching overview:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  } finally {
    db.close();
  }
}
