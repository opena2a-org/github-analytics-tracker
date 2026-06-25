/**
 * Rolling-window metrics computed straight from SQLite. Deterministic and fast
 * — no external API calls. The daily collector keeps the store at most ~1 day
 * stale, which we treat as the honest source of truth rather than racing 100+
 * live API calls on every page load.
 *
 * Shared by pages/api/overview.js and the windowing regression test.
 */

/**
 * Compute windowed download metrics for one package.
 *
 * Returns { name, version, allTimeDownloads, last24hDownloads, last7Downloads,
 *           last30Downloads, prev7Downloads, prev30Downloads, customDownloads }.
 */
function computeWindowedStats(db, table, fkColumn, fkId, { start, end, isCustomRange, name, version, sourceRepo }) {
  // Anchor rolling windows to the latest collected day that ACTUALLY has data,
  // not "now" and not the raw MAX(date). Two reasons:
  //   1. Collection lags real time by a day or two, so windowing from "now"
  //      leaves the trailing 7-day window short and makes healthy adoption look
  //      like a drop (a phantom negative WoW).
  //   2. npm's downloads API reports 0 for the most recent day(s) until it
  //      finalizes them ~a day later. A plain MAX(date) would anchor onto that
  //      trailing all-zero day and collapse the 24h window (the "Today" column)
  //      to 0 across every package — even while downloads are healthy. Excluding
  //      zero-total days keeps the anchor on a real measurement. PyPI finalizes
  //      the prior day faster, so `WHERE downloads > 0` is a no-op there.
  const anchor = `(SELECT MAX(date) FROM ${table} WHERE downloads > 0)`;
  const sum = (clause, ...params) => db.prepare(
    `SELECT COALESCE(SUM(downloads), 0) AS total FROM ${table} WHERE ${fkColumn} = ?${clause ? ' AND ' + clause : ''}`
  ).get(fkId, ...params).total;

  return {
    name,
    version,
    sourceRepo: sourceRepo || null,
    allTimeDownloads: sum(''),
    last24hDownloads: sum(`date = ${anchor}`),
    last7Downloads: sum(`date > date(${anchor}, '-7 days')`),
    last30Downloads: sum(`date > date(${anchor}, '-30 days')`),
    prev7Downloads: sum(`date > date(${anchor}, '-14 days') AND date <= date(${anchor}, '-7 days')`),
    prev30Downloads: sum(`date > date(${anchor}, '-60 days') AND date <= date(${anchor}, '-30 days')`),
    customDownloads: isCustomRange ? sum('date >= ? AND date <= ?', start, end) : 0,
  };
}

/**
 * Cumulative star growth over rolling windows for one repo.
 *
 * Stars are a running total (stargazers.total_stars), not a per-day count, so
 * "growth" is the current total minus the total as of the start of the window.
 * Anchored to the latest collected star snapshot to stay consistent with the
 * download windows.
 *
 * Returns { stars, starsGrowth24h, starsGrowth7d, starsGrowth30d,
 *           starsGrowthAll, starsGrowthCustom }.
 */
function computeStarGrowth(db, repoId, { start, end, isCustomRange }) {
  const anchor = `(SELECT MAX(date) FROM stargazers)`;
  const at = (cond, ...params) => db.prepare(
    `SELECT total_stars FROM stargazers WHERE repo_id = ?${cond ? ' AND ' + cond : ''} ORDER BY date DESC LIMIT 1`
  ).get(repoId, ...params)?.total_stars;

  const current = at(`date <= ${anchor}`) ?? 0;
  // Growth since N days before the anchor: current minus the total as it stood
  // on (or before) that earlier day. If we have no snapshot that old, fall back
  // to 0 so growth equals the full current count (repo first seen inside window).
  const since = (daysExpr) => current - (at(`date <= date(${anchor}, ${daysExpr})`) ?? 0);
  const earliest = db.prepare(
    `SELECT total_stars FROM stargazers WHERE repo_id = ? ORDER BY date ASC LIMIT 1`
  ).get(repoId)?.total_stars ?? 0;

  let starsGrowthCustom = 0;
  if (isCustomRange) {
    const before = at(`date < ?`, start) ?? 0;
    const within = at(`date <= ?`, end) ?? current;
    starsGrowthCustom = within - before;
  }

  return {
    stars: current,
    starsGrowth24h: since(`'-1 days'`),
    starsGrowth7d: since(`'-7 days'`),
    starsGrowth30d: since(`'-30 days'`),
    starsGrowthAll: current - earliest,
    starsGrowthCustom,
  };
}

module.exports = { computeWindowedStats, computeStarGrowth };
