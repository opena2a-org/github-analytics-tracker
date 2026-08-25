const Database = require('better-sqlite3');
const path = require('path');
const { computeOverview } = require('../../lib/overview');

/**
 * Overview API: Returns combined GitHub + npm metrics suitable for
 * investor presentations, dashboards, and growth tracking. All computation
 * lives in lib/overview.js.
 */
export default async function handler(req, res) {
  // Cache response on Vercel edge for 5 minutes
  res.setHeader('Cache-Control', 's-maxage=300');
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  // Custom date range support
  const { start, end } = req.query;

  try {
    res.status(200).json(computeOverview(db, { start, end }));
  } catch (error) {
    console.error('Error fetching overview:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  } finally {
    db.close();
  }
}
