/**
 * Momentum: growth rates derived from the time series the tracker already
 * collects. No new data source and nothing modeled: every figure is two
 * measured window totals and the arithmetic between them, and every window
 * boundary is emitted next to the figure so a reader can recompute it.
 *
 * Series and the quantity each one measures:
 *   daily-rows (additive daily counts, summed per day across entities):
 *     npm       npm_downloads.downloads
 *     pypi      pypi_downloads.downloads
 *     clones    traffic_clones.count, twins collapsed per (canonical repo, date)
 *               exactly as lib/repos.js does for the download series
 *   cumulative-snapshot (a running total per entity; the window count is the
 *   total as of the window end minus the total as of the day before it starts):
 *     docker       docker_pulls.pull_count            per image
 *     huggingface  huggingface_stats.downloads_all_time per model
 *     stars        stargazers.total_stars             per canonical repo
 *   An entity whose first snapshot falls inside a window (a repository, image
 *   or model the tracker started collecting then) adds only what it gained
 *   after that first snapshot. The count it already had on that day is not
 *   growth; it is emitted beside the window totals as `carriedIn`, the rule
 *   lib/community.js applies to its monthly star and fork trend.
 *
 * Windows, pinned (the same shape lib/windowing.js uses for last7/prev7):
 *   wow  current = the 7 days ending at the anchor, previous = the 7 before
 *   mom  30 vs the 30 before
 *   qoq  90 vs the 90 before
 *   growthPct = (current - previous) / previous * 100.
 *
 * Anchor: the latest collected day that actually has data (daily rows: the
 * last day whose summed value is > 0; snapshots: the last snapshot date). Never
 * "now". Windowing from today while collection lags a day or two leaves the
 * trailing window short and manufactures a negative week-over-week figure out
 * of healthy data; npm also reports 0 for a day it has not finalized yet.
 *
 * Acceleration: this week's growth rate against last week's (the 7 days before
 * the anchor week versus the 7 before those). deltaPoints is the difference in
 * percentage points; direction says whether the rate is rising or falling.
 *
 * CAGR: compound annual growth rate between the earliest complete window and
 * the current one. Daily-row series compare trailing-30-day volume (the
 * monthly run rate); snapshot series compare the cumulative total. The start
 * is the first day with a non-zero value (`firstActive`): rows collected for
 * the months before a package existed are zeros, not growth. Published only
 * when the two windows are at least one year apart. A shorter span would have
 * to be annualised, which is an extrapolation, so it is null instead.
 *
 * A figure that cannot be measured is null with a `reason`, never 0, never
 * Infinity and never a filled-in estimate. The honesty rules:
 *   - the series must cover the whole previous window (first row on or before
 *     its first day), otherwise the comparison is against a partial period;
 *   - the previous window total must be > 0.
 *
 * Consumed by lib/summary.js (data/summary.json `momentum`) and
 * lib/overview.js (overview API `momentum`); both call computeMomentum so the
 * two surfaces cannot disagree.
 */
const { groupByCanonical, pickCanonical } = require('./repos');

const WINDOWS = { wow: 7, mom: 30, qoq: 90 };
const CAGR_WINDOW_DAYS = 30;
const DAYS_PER_YEAR = 365.25;

const REASON = {
  noData: 'no data',
  coverage: 'series does not cover the previous window',
  zeroPrevious: 'previous window total is zero',
  zeroStart: 'starting value is zero',
  shortSpan: 'span shorter than one year',
  dependsOnWow: 'a week-over-week figure is not measurable',
};

const METHOD =
  'Growth is (current - previous) / previous over two adjacent windows of equal length ' +
  '(wow 7 days, mom 30, qoq 90) ending at each series\' anchor, the latest collected day ' +
  'with data. Daily-row series sum daily counts; snapshot series take the running total at ' +
  'the window end minus the total the day before the window starts; the count an entity ' +
  'already had on the day it was first collected is reported as carriedIn, not as growth. ' +
  'Acceleration compares ' +
  'this week\'s growth rate with last week\'s. CAGR compares the earliest complete window ' +
  'starting at the first day with a non-zero value with the current one and is published ' +
  'only when they are at least a year apart. A figure ' +
  'that cannot be measured is null with a reason; nothing is estimated.';

// --- date helpers (ISO yyyy-mm-dd, UTC) ---------------------------------------

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// --- pure arithmetic ----------------------------------------------------------

/** Percent change from previous to current; null when previous is 0. */
function growthPct(current, previous) {
  if (!(previous > 0)) return null;
  return round2(((current - previous) / previous) * 100);
}

/** Compound annual growth rate in percent; null when start is 0 or years <= 0. */
function cagrPct(start, end, years) {
  if (!(start > 0) || !(years > 0)) return null;
  return round2((Math.pow(end / start, 1 / years) - 1) * 100);
}

// --- series access ------------------------------------------------------------

/**
 * A daily-row series: Map date -> value (summed per day). `first` is the
 * earliest date with a row; `anchor` the latest date whose value is > 0.
 */
function dailySeries(rows) {
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) || 0) + (r.value || 0));
  const dates = [...byDate.keys()].sort();
  const anchor = [...dates].reverse().find(d => byDate.get(d) > 0) || null;
  const firstActive = dates.find(d => byDate.get(d) > 0) || null;
  return {
    kind: 'daily-rows',
    first: dates[0] || null,
    firstActive,
    anchor,
    // The earliest row a window starting on `start` needs: the day itself.
    baselineDate: (start) => start,
    // Sum of the days in [start, end] inclusive.
    windowTotal(start, end) {
      let t = 0;
      for (const [d, v] of byDate) if (d >= start && d <= end) t += v;
      return t;
    },
  };
}

/**
 * A cumulative-snapshot series: per-entity running totals. The value as of a
 * date is the sum, over entities, of each entity's latest snapshot on or before
 * that date; an entity first seen after the date contributes 0.
 *
 * A window count is growth only: an entity first seen inside the window
 * contributes its total at the window end minus its first snapshot value. The
 * first snapshot value was accumulated before collection began, so it is
 * reported by windowCarriedIn instead of being counted as gained in the window.
 */
function snapshotSeries(rows) {
  const byEntity = new Map();
  for (const r of rows) {
    if (!byEntity.has(r.entity)) byEntity.set(r.entity, []);
    byEntity.get(r.entity).push({ date: r.date, value: r.value || 0 });
  }
  let first = null, firstActive = null, anchor = null;
  for (const list of byEntity.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    if (!first || list[0].date < first) first = list[0].date;
    const active = list.find(s => s.value > 0);
    if (active && (!firstActive || active.date < firstActive)) firstActive = active.date;
    const last = list[list.length - 1].date;
    if (!anchor || last > anchor) anchor = last;
  }
  const valueAt = (date) => {
    let t = 0;
    for (const list of byEntity.values()) {
      let v = 0;
      for (const s of list) { if (s.date <= date) v = s.value; else break; }
      t += v;
    }
    return t;
  };
  // Sum of the first snapshot values of the entities first seen in [start, end].
  const carriedIn = (start, end) => {
    let t = 0;
    for (const list of byEntity.values()) {
      if (list[0].date >= start && list[0].date <= end) t += list[0].value;
    }
    return t;
  };
  return {
    kind: 'cumulative-snapshot',
    first,
    firstActive,
    anchor,
    valueAt,
    // A window starting on `start` needs a snapshot on or before the day
    // before it, otherwise the total "as of" that day is 0 and the whole
    // running total would be reported as growth inside the window.
    baselineDate: (start) => addDays(start, -1),
    // Count gained in [start, end]: total as of end minus total as of the day
    // before start, less the first snapshot value of every entity first seen
    // inside the window.
    windowTotal(start, end) {
      return valueAt(end) - valueAt(addDays(start, -1)) - carriedIn(start, end);
    },
    windowCarriedIn: carriedIn,
  };
}

// --- per-series momentum ------------------------------------------------------

function windowGrowth(series, days) {
  const { anchor, first } = series;
  if (!anchor) return { current: null, previous: null, growthPct: null, window: null, reason: REASON.noData };
  const cur = { start: addDays(anchor, -(days - 1)), end: anchor };
  const prev = { start: addDays(anchor, -(2 * days - 1)), end: addDays(anchor, -days) };
  const window = { current: cur, previous: prev };
  // Snapshot series only: what entities first collected inside each window
  // already held, kept out of current / previous.
  const carried = (w) => (series.windowCarriedIn ? series.windowCarriedIn(w.start, w.end) : undefined);
  if (first > series.baselineDate(prev.start)) {
    const out = { current: series.windowTotal(cur.start, cur.end), previous: null, growthPct: null, window, reason: REASON.coverage };
    if (series.windowCarriedIn) out.carriedIn = { current: carried(cur), previous: null };
    return out;
  }
  const current = series.windowTotal(cur.start, cur.end);
  const previous = series.windowTotal(prev.start, prev.end);
  const pct = growthPct(current, previous);
  const out = { current, previous, growthPct: pct, window };
  if (series.windowCarriedIn) out.carriedIn = { current: carried(cur), previous: carried(prev) };
  if (pct === null) out.reason = REASON.zeroPrevious;
  return out;
}

function acceleration(series) {
  const now = windowGrowth(series, WINDOWS.wow);
  if (now.growthPct === null) {
    return { currentWowPct: null, priorWowPct: null, deltaPoints: null, direction: null, reason: now.reason || REASON.dependsOnWow };
  }
  // Last week's rate: the previous window against the 7 days before it.
  const priorAnchor = addDays(series.anchor, -WINDOWS.wow);
  const prior = windowGrowth({ ...series, anchor: priorAnchor }, WINDOWS.wow);
  if (prior.growthPct === null) {
    return { currentWowPct: now.growthPct, priorWowPct: null, deltaPoints: null, direction: null, reason: prior.reason || REASON.dependsOnWow };
  }
  const deltaPoints = round2(now.growthPct - prior.growthPct);
  return {
    currentWowPct: now.growthPct,
    priorWowPct: prior.growthPct,
    deltaPoints,
    direction: deltaPoints > 0 ? 'rising' : deltaPoints < 0 ? 'falling' : 'flat',
  };
}

function cagr(series) {
  const { anchor, firstActive: first } = series;
  const basis = series.kind === 'daily-rows' ? `trailing-${CAGR_WINDOW_DAYS}-day volume` : 'cumulative total';
  if (!anchor || !first) return { pct: null, basis, from: null, to: null, years: null, reason: REASON.noData };
  let from, to;
  if (series.kind === 'daily-rows') {
    const fromEnd = addDays(first, CAGR_WINDOW_DAYS - 1);
    from = { start: first, end: fromEnd, value: series.windowTotal(first, fromEnd) };
    const toStart = addDays(anchor, -(CAGR_WINDOW_DAYS - 1));
    to = { start: toStart, end: anchor, value: series.windowTotal(toStart, anchor) };
  } else {
    from = { date: first, value: series.valueAt(first) };
    to = { date: anchor, value: series.valueAt(anchor) };
  }
  const years = round2(daysBetween(from.end || from.date, to.end || to.date) / DAYS_PER_YEAR);
  if (years < 1) return { pct: null, basis, from, to, years, reason: REASON.shortSpan };
  const pct = cagrPct(from.value, to.value, years);
  const out = { pct, basis, from, to, years };
  if (pct === null) out.reason = REASON.zeroStart;
  return out;
}

/** Momentum for one series object (from dailySeries or snapshotSeries). */
function seriesMomentum(series, source) {
  const out = { kind: series.kind, source, first: series.first, firstActive: series.firstActive, anchor: series.anchor };
  for (const [key, days] of Object.entries(WINDOWS)) out[key] = windowGrowth(series, days);
  out.acceleration = acceleration(series);
  out.cagr = cagr(series);
  return out;
}

// --- database readers ---------------------------------------------------------

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function readDaily(db, table, column) {
  if (!tableExists(db, table)) return dailySeries([]);
  return dailySeries(db.prepare(`SELECT date, SUM(${column}) AS value FROM ${table} GROUP BY date`).all());
}

// Clones collapsed per (canonical repo, date): the canonical row's count on a
// day both twins report, else the larger twin. Mirrors lib/repos.js.
function readClones(db) {
  if (!tableExists(db, 'traffic_clones') || !tableExists(db, 'repositories')) return dailySeries([]);
  return dailySeries(db.prepare(`
    SELECT date, SUM(count) AS value FROM (
      SELECT t.date AS date,
             COALESCE(MAX(CASE WHEN COALESCE(r.canonical_full_name, r.full_name) = r.full_name
                               THEN t.count END),
                      MAX(t.count)) AS count
      FROM traffic_clones t JOIN repositories r ON r.id = t.repo_id
      GROUP BY COALESCE(r.canonical_full_name, r.full_name), t.date
    ) GROUP BY date
  `).all());
}

function readSnapshot(db, table, idColumn, column) {
  if (!tableExists(db, table)) return snapshotSeries([]);
  return snapshotSeries(db.prepare(`SELECT ${idColumn} AS entity, date, ${column} AS value FROM ${table}`).all());
}

// Stars per canonical repo: the canonical (live) row's snapshots only, so a
// transferred repo's stale twin is never added on top. Mirrors canonicalRepoTotals.
// The twin's snapshots from before the transfer are not read, so a transferred
// repo's series starts at the canonical row's first snapshot and the stars it
// held that day are carried in.
function readStars(db) {
  if (!tableExists(db, 'stargazers') || !tableExists(db, 'repositories')) return snapshotSeries([]);
  const repos = db.prepare('SELECT id, full_name, canonical_full_name FROM repositories').all();
  const ids = [];
  for (const [canon, group] of groupByCanonical(repos)) ids.push(pickCanonical(group, canon).id);
  const rows = [];
  const q = db.prepare('SELECT repo_id AS entity, date, total_stars AS value FROM stargazers WHERE repo_id = ?');
  for (const id of ids) rows.push(...q.all(id));
  return snapshotSeries(rows);
}

// --- combined and snapshot ----------------------------------------------------

const DOWNLOAD_SOURCES = ['npm', 'pypi', 'clones', 'docker', 'huggingface'];

// Gross download events across sources (the same terms as the `downloads`
// series): per window, the sum of each source's own window count, each at its
// own anchor. A source whose figure is not measurable for a window is left out
// of that window and named in `excluded`, so the sum never mixes a measured
// value with a missing one.
function combineGrowth(sources, key) {
  let current = 0, previous = 0;
  const components = {};
  const excluded = {};
  const anchors = {};
  for (const name of DOWNLOAD_SOURCES) {
    const g = sources[name][key];
    if (g.growthPct === null && g.previous === null) {
      excluded[name] = g.reason;
      continue;
    }
    components[name] = { current: g.current, previous: g.previous };
    anchors[name] = sources[name].anchor;
    current += g.current;
    previous += g.previous;
  }
  const measured = Object.keys(components).length > 0;
  const pct = measured ? growthPct(current, previous) : null;
  const out = {
    current: measured ? current : null,
    previous: measured ? previous : null,
    growthPct: pct,
    days: WINDOWS[key],
    anchors,
    components,
    excluded,
  };
  if (!measured) out.reason = REASON.noData;
  else if (pct === null) out.reason = REASON.zeroPrevious;
  return out;
}

function directionOf(pct) {
  if (pct === null || pct === undefined) return null;
  return pct > 0 ? 'rising' : pct < 0 ? 'falling' : 'flat';
}

/**
 * Compute the momentum block. `db` is an open better-sqlite3 handle (read-only
 * is fine). Pure function of the database; no clock is read.
 */
function computeMomentum(db) {
  const sources = {
    npm: seriesMomentum(readDaily(db, 'npm_downloads', 'downloads'), { table: 'npm_downloads', column: 'downloads' }),
    pypi: seriesMomentum(readDaily(db, 'pypi_downloads', 'downloads'), { table: 'pypi_downloads', column: 'downloads' }),
    clones: seriesMomentum(readClones(db), { table: 'traffic_clones', column: 'count', note: 'collapsed per canonical repo and date' }),
    docker: seriesMomentum(readSnapshot(db, 'docker_pulls', 'image_id', 'pull_count'), { table: 'docker_pulls', column: 'pull_count' }),
    huggingface: seriesMomentum(readSnapshot(db, 'huggingface_stats', 'model_id', 'downloads_all_time'), { table: 'huggingface_stats', column: 'downloads_all_time' }),
    stars: seriesMomentum(readStars(db), { table: 'stargazers', column: 'total_stars', note: 'canonical repo rows only' }),
  };

  const downloads = {};
  for (const key of Object.keys(WINDOWS)) downloads[key] = combineGrowth(sources, key);

  const anchors = Object.values(sources).map(s => s.anchor).filter(Boolean).sort();
  const perSource = {};
  for (const [name, s] of Object.entries(sources)) {
    perSource[name] = { wowGrowthPct: s.wow.growthPct, direction: directionOf(s.wow.growthPct), accelerating: s.acceleration.direction };
  }

  return {
    asOf: anchors.length ? anchors[anchors.length - 1] : null,
    method: METHOD,
    windows: { ...WINDOWS },
    snapshot: {
      direction: directionOf(downloads.wow.growthPct),
      downloadsWowGrowthPct: downloads.wow.growthPct,
      downloadsMomGrowthPct: downloads.mom.growthPct,
      downloadsQoqGrowthPct: downloads.qoq.growthPct,
      sources: perSource,
    },
    downloads,
    sources,
  };
}

module.exports = {
  computeMomentum,
  seriesMomentum,
  dailySeries,
  snapshotSeries,
  growthPct,
  cagrPct,
  addDays,
  WINDOWS,
  REASON,
};
