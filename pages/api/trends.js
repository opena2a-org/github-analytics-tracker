const Database = require('better-sqlite3');
const path = require('path');

/**
 * Trends API: Returns aggregate time-series data across ALL repos/packages.
 *
 * Query params:
 *   granularity - daily|weekly|monthly (default: weekly)
 *   days        - number|all (default: 90)
 */
export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const granularity = (req.query.granularity || 'weekly').toLowerCase();
    const daysParam = req.query.days || '90';

    if (!['daily', 'weekly', 'monthly'].includes(granularity)) {
      return res.status(400).json({ error: 'granularity must be daily, weekly, or monthly' });
    }

    // Build date filter
    const dateFilter = daysParam === 'all'
      ? ''
      : `AND date >= date('now', '-${parseInt(daysParam, 10)} days')`;

    // strftime format for bucketing
    const bucketExpr = granularity === 'daily'
      ? "date"
      : granularity === 'monthly'
        ? "strftime('%Y-%m-01', date)"
        : "date(date, 'weekday 0', '-6 days')"; // Monday of the week

    // --- Traffic (views + clones) ---
    const viewsQuery = `
      SELECT ${bucketExpr} AS period, SUM(count) AS views
      FROM traffic_views
      WHERE 1=1 ${dateFilter}
      GROUP BY period ORDER BY period
    `;

    const clonesQuery = `
      SELECT ${bucketExpr} AS period, SUM(count) AS clones
      FROM traffic_clones
      WHERE 1=1 ${dateFilter}
      GROUP BY period ORDER BY period
    `;

    const viewsData = db.prepare(viewsQuery).all();
    const clonesData = db.prepare(clonesQuery).all();

    // --- npm downloads ---
    const npmTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='npm_downloads'"
    ).get();

    let npmData = [];
    if (npmTableExists) {
      npmData = db.prepare(`
        SELECT ${bucketExpr} AS period, SUM(downloads) AS npmDownloads
        FROM npm_downloads
        WHERE 1=1 ${dateFilter}
        GROUP BY period ORDER BY period
      `).all();
    }

    // --- PyPI downloads ---
    const pypiTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_downloads'"
    ).get();

    let pypiData = [];
    if (pypiTableExists) {
      pypiData = db.prepare(`
        SELECT ${bucketExpr} AS period, SUM(downloads) AS pypiDownloads
        FROM pypi_downloads
        WHERE 1=1 ${dateFilter}
        GROUP BY period ORDER BY period
      `).all();
    }

    // --- Docker pulls ---
    const dockerTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='docker_pulls'"
    ).get();

    let dockerData = [];
    if (dockerTableExists) {
      dockerData = db.prepare(`
        SELECT ${bucketExpr} AS period,
               MAX(pull_count) - MIN(pull_count) AS dockerPulls
        FROM docker_pulls
        WHERE 1=1 ${dateFilter}
        GROUP BY period ORDER BY period
      `).all();
    }

    // --- HuggingFace downloads (deltas of cumulative all-time per bucket) ---
    const hfTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='huggingface_stats'"
    ).get();

    let hfData = [];
    if (hfTableExists) {
      hfData = db.prepare(`
        SELECT period, SUM(delta) AS hfDownloads FROM (
          SELECT ${bucketExpr} AS period,
                 MAX(downloads_all_time) - MIN(downloads_all_time) AS delta
          FROM huggingface_stats
          WHERE 1=1 ${dateFilter}
          GROUP BY model_id, period
        ) GROUP BY period ORDER BY period
      `).all();
    }

    // --- Merge all series into unified timeline ---
    const merged = {};
    for (const row of viewsData) {
      if (!merged[row.period]) merged[row.period] = { periodStart: row.period };
      merged[row.period].views = row.views;
    }
    for (const row of clonesData) {
      if (!merged[row.period]) merged[row.period] = { periodStart: row.period };
      merged[row.period].clones = row.clones;
    }
    for (const row of npmData) {
      if (!merged[row.period]) merged[row.period] = { periodStart: row.period };
      merged[row.period].npmDownloads = row.npmDownloads;
    }
    for (const row of pypiData) {
      if (!merged[row.period]) merged[row.period] = { periodStart: row.period };
      merged[row.period].pypiDownloads = row.pypiDownloads;
    }
    for (const row of dockerData) {
      if (!merged[row.period]) merged[row.period] = { periodStart: row.period };
      merged[row.period].dockerPulls = row.dockerPulls;
    }
    for (const row of hfData) {
      if (!merged[row.period]) merged[row.period] = { periodStart: row.period };
      merged[row.period].hfDownloads = row.hfDownloads;
    }

    const series = Object.values(merged)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
      .map(s => ({
        periodStart: s.periodStart,
        views: s.views || 0,
        clones: s.clones || 0,
        npmDownloads: s.npmDownloads || 0,
        pypiDownloads: s.pypiDownloads || 0,
        dockerPulls: s.dockerPulls || 0,
        hfDownloads: s.hfDownloads || 0,
        totalDownloads: (s.npmDownloads || 0) + (s.pypiDownloads || 0) + (s.dockerPulls || 0) + (s.hfDownloads || 0),
      }));

    // --- Star timeline ---
    const starBucket = granularity === 'daily'
      ? "date"
      : granularity === 'monthly'
        ? "strftime('%Y-%m-01', date)"
        : "date(date, 'weekday 0', '-6 days')";

    const starTimeline = db.prepare(`
      SELECT ${starBucket} AS date,
             SUM(total_stars) AS totalStars
      FROM stargazers
      WHERE 1=1 ${dateFilter}
      GROUP BY ${starBucket}
      ORDER BY date
    `).all();

    // --- Growth calculations ---
    const growth = computeGrowth(series, granularity);

    res.status(200).json({
      granularity,
      series,
      starTimeline,
      growth,
    });
  } catch (error) {
    console.error('Error fetching trends:', error);
    res.status(500).json({ error: 'Failed to fetch trends' });
  } finally {
    db.close();
  }
}

function computeGrowth(series, granularity) {
  if (series.length < 2) {
    return { wow: null, mom: null };
  }

  // For WoW: compare last period to the one before
  const last = series[series.length - 1];
  const prev = series[series.length - 2];

  const pctChange = (curr, prev) => {
    if (!prev || prev === 0) return curr > 0 ? 100 : 0;
    return parseFloat(((curr - prev) / prev * 100).toFixed(1));
  };

  const wow = {
    views: pctChange(last.views, prev.views),
    clones: pctChange(last.clones, prev.clones),
    downloads: pctChange(last.totalDownloads, prev.totalDownloads),
  };

  // For MoM: compare sum of last ~4 periods to the 4 before that
  let mom = null;
  if (series.length >= 8) {
    const recentSlice = series.slice(-4);
    const priorSlice = series.slice(-8, -4);
    const sumField = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);
    mom = {
      views: pctChange(sumField(recentSlice, 'views'), sumField(priorSlice, 'views')),
      clones: pctChange(sumField(recentSlice, 'clones'), sumField(priorSlice, 'clones')),
      downloads: pctChange(sumField(recentSlice, 'totalDownloads'), sumField(priorSlice, 'totalDownloads')),
    };
  }

  // Star growth: difference between last and first star counts
  return { wow, mom };
}
