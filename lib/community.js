/**
 * Community and shipping cadence: contributor growth, the monthly star and
 * fork trend, release cadence and ecosystem breadth, derived from tables the
 * tracker already collects (github_contributors, stargazers, forks and
 * github_releases by scripts/collect-stats.js; the package, image, model and
 * extension tables by their own collectors). Nothing is modeled: every figure
 * is a count of stored rows, and every limit of the collection that could
 * undercount a period is reported next to the period it affects.
 *
 * Calendar months and quarters are UTC. A month or quarter that ends after
 * the block's asOf is `inProgress`. Twins of a transferred or renamed
 * repository are one repository (lib/repos.js).
 *
 * contributors
 *   GitHub's contributor statistics list, per repository, each author of
 *   commits on the default branch with an all-time commit count; the collector
 *   stores that list per collection day (a day GitHub was still computing the
 *   statistics has no rows). Logins ending in [bot] are left out and counted in
 *   botsExcluded. A login is an account that authored commits, maintainers
 *   included: the data does not separate them from outside contributors. Per
 *   month:
 *     cumulative       distinct logins seen in any snapshot up to the month end
 *     newContributors  cumulative minus the previous month's. Dated by the first
 *                      snapshot that lists the login, not by its first commit,
 *                      so the first month (`baseline`) also holds everyone who
 *                      contributed before tracking began.
 *     active           distinct logins whose commit count on a repository rose
 *                      above the highest count an earlier snapshot of that
 *                      repository showed, counted in the month of the snapshot
 *                      that shows the rise. A repository's first snapshot is its
 *                      baseline and shows no activity.
 *
 * stars, forks
 *   Each canonical repository's canonical-row snapshots (the rule lib/repos.js
 *   applies to every snapshot metric). Per month, `total` is the sum of each
 *   repository's latest snapshot on or before the month end, so the newest
 *   month's total equals summary.json total.stars / the canonical fork count.
 *   A repository first collected in a month brings the count it already had:
 *   that count is `carriedIn`, not growth. `netGained` is the change measured
 *   between snapshots (unstars make it smaller, and it can be negative).
 *   total = previous month's total + carriedIn + netGained.
 *
 * releases
 *   The collector reads the newest RELEASES_PER_READ releases per repository
 *   each day. The union over every snapshot holds each release published since
 *   tracking began, plus the older ones the first read listed. A release counts
 *   once per canonical repository and tag, in the quarter of its published_at
 *   as last read; unpublished drafts are left out. A read that returned the
 *   full limit may have cut older releases off: before a repository's first
 *   such read, releases older than the oldest one listed were never read, and a
 *   later full read whose oldest release is not older than the previous read's
 *   day leaves the days between unread. Those ranges are listed in
 *   coverage.truncated, and a quarter that overlaps one is `complete: false`,
 *   so a partial count is never presented as a quarter's total. `perQuarter`
 *   is the newest complete quarter that is not in progress.
 *
 * breadth
 *   Tracked artifacts per ecosystem: canonical GitHub repositories (the
 *   summary.json total.repos count) and the row counts of the npm, PyPI, Docker
 *   Hub, Hugging Face and Chrome Web Store tables. `ecosystems` counts the ones
 *   with at least one artifact.
 *
 * Consumed by lib/summary.js (data/summary.json `community`) and
 * lib/overview.js (overview API `community`); both call computeCommunity so
 * the two surfaces cannot disagree.
 */
const { groupByCanonical, pickCanonical, canonicalNameOf } = require('./repos');
const { addDays } = require('./momentum');

// per_page of the release read in scripts/collect-stats.js.
const RELEASES_PER_READ = 30;
const RECENT_RELEASE_DAYS = 90;
const BOT_LOGIN = /\[bot\]$/i;

// --- calendar helpers (ISO yyyy-mm-dd, UTC) ---------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthOf(iso) {
  return iso.slice(0, 7);
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`;
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function monthsBetween(first, last) {
  const out = [];
  for (let m = first; m <= last; m = nextMonth(m)) out.push(m);
  return out;
}

function quarterOf(iso) {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

function nextQuarter(q) {
  const [y, n] = q.split('-Q').map(Number);
  return n === 4 ? `${y + 1}-Q1` : `${y}-Q${n + 1}`;
}

function quarterBounds(q) {
  const [y, n] = q.split('-Q').map(Number);
  const first = (n - 1) * 3 + 1;
  return { from: `${y}-${pad2(first)}-01`, to: monthEnd(`${y}-${pad2(first + 2)}`) };
}

// --- shared -----------------------------------------------------------------------

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** repo id -> canonical full_name, for every row in repositories. */
function canonicalById(db) {
  const map = new Map();
  if (!tableExists(db, 'repositories')) return map;
  for (const r of db.prepare('SELECT id, full_name, canonical_full_name FROM repositories').all()) {
    map.set(r.id, canonicalNameOf(r));
  }
  return map;
}

// A row whose repository is not in `repositories` stays its own repository.
function canonOf(map, repoId) {
  return map.get(repoId) ?? `repo-id:${repoId}`;
}

// --- contributors -----------------------------------------------------------------

function computeContributors(db) {
  const block = {
    source: 'github_contributors (GitHub contributor statistics, default-branch commits)',
    firstSnapshot: null,
    asOf: null,
    total: 0,
    botsExcluded: 0,
    months: [],
  };
  if (!tableExists(db, 'github_contributors')) return block;
  const canon = canonicalById(db);
  const rows = db.prepare(
    'SELECT repo_id, date, login, contributions FROM github_contributors ORDER BY date, repo_id'
  ).all();
  if (rows.length === 0) return block;

  const bots = new Set();
  const firstSeen = new Map(); // login -> first snapshot date (rows are date-ordered)
  // canonical repo -> date -> login -> commits (twins on one day: the larger)
  const byRepo = new Map();
  for (const r of rows) {
    const login = String(r.login);
    if (BOT_LOGIN.test(login)) {
      bots.add(login);
      continue;
    }
    if (!firstSeen.has(login)) firstSeen.set(login, r.date);
    const key = canonOf(canon, r.repo_id);
    if (!byRepo.has(key)) byRepo.set(key, new Map());
    const days = byRepo.get(key);
    if (!days.has(r.date)) days.set(r.date, new Map());
    const day = days.get(r.date);
    day.set(login, Math.max(day.get(login) ?? 0, r.contributions || 0));
  }

  // month -> logins whose count rose above that repository's earlier high-water mark
  const active = new Map();
  for (const days of byRepo.values()) {
    const dates = [...days.keys()].sort();
    const highest = new Map();
    dates.forEach((date, i) => {
      for (const [login, commits] of days.get(date)) {
        const before = highest.get(login) ?? 0;
        if (i > 0 && commits > before) {
          const m = monthOf(date);
          if (!active.has(m)) active.set(m, new Set());
          active.get(m).add(login);
        }
        highest.set(login, Math.max(before, commits));
      }
    });
  }

  const asOf = rows[rows.length - 1].date;
  block.firstSnapshot = rows[0].date;
  block.asOf = asOf;
  block.total = firstSeen.size;
  block.botsExcluded = bots.size;

  const firstDates = [...firstSeen.values()];
  const months = monthsBetween(monthOf(rows[0].date), monthOf(asOf));
  let previous = 0;
  block.months = months.map((month, i) => {
    const end = monthEnd(month);
    const cumulative = firstDates.filter(d => d <= end).length;
    const entry = {
      month,
      cumulative,
      newContributors: cumulative - previous,
      active: active.get(month)?.size || 0,
      baseline: i === 0,
      inProgress: end > asOf,
    };
    previous = cumulative;
    return entry;
  });
  return block;
}

// --- stars and forks --------------------------------------------------------------

function snapshotTrend(db, table, column) {
  const block = { source: `${table}.${column}, canonical repository rows`, firstSnapshot: null, asOf: null, months: [] };
  if (!tableExists(db, table) || !tableExists(db, 'repositories')) return block;

  const repos = db.prepare('SELECT id, full_name, canonical_full_name FROM repositories ORDER BY id').all();
  const q = db.prepare(`SELECT date, ${column} AS value FROM ${table} WHERE repo_id = ? ORDER BY date`);
  const lists = [];
  for (const [name, group] of groupByCanonical(repos)) {
    const list = q.all(pickCanonical(group, name).id);
    if (list.length) lists.push(list);
  }
  if (lists.length === 0) return block;

  const first = lists.map(l => l[0].date).sort()[0];
  const asOf = lists.map(l => l[l.length - 1].date).sort().pop();
  block.firstSnapshot = first;
  block.asOf = asOf;

  // The value of a repository's latest snapshot on or before `date`, or undefined.
  const valueAt = (list, date) => {
    let v;
    for (const s of list) {
      if (s.date > date) break;
      v = s.value || 0;
    }
    return v;
  };

  block.months = monthsBetween(monthOf(first), monthOf(asOf)).map(month => {
    const end = monthEnd(month);
    const beforeStart = addDays(`${month}-01`, -1);
    let total = 0, carriedIn = 0, netGained = 0, reposNewlyTracked = 0;
    for (const list of lists) {
      const atEnd = valueAt(list, end);
      if (atEnd === undefined) continue;
      const atStart = valueAt(list, beforeStart);
      if (atStart === undefined) {
        const firstValue = list[0].value || 0;
        carriedIn += firstValue;
        netGained += atEnd - firstValue;
        reposNewlyTracked += 1;
      } else {
        netGained += atEnd - atStart;
      }
      total += atEnd;
    }
    return { month, total, carriedIn, netGained, reposNewlyTracked, inProgress: end > asOf };
  });
  return block;
}

// --- releases ---------------------------------------------------------------------

function overlaps(range, from, to) {
  return (range.from === null || range.from <= to) && range.to >= from;
}

function computeReleases(db) {
  const block = {
    source: `github_releases (the newest ${RELEASES_PER_READ} releases per repository, read daily)`,
    firstSnapshot: null,
    asOf: null,
    total: 0,
    repos: 0,
    perQuarter: null,
    recent: null,
    quarters: [],
    coverage: { releasesPerRead: RELEASES_PER_READ, truncated: [] },
  };
  if (!tableExists(db, 'github_releases')) return block;
  const canon = canonicalById(db);
  const rows = db.prepare(
    'SELECT repo_id, date, tag_name, published_at FROM github_releases ORDER BY repo_id, date'
  ).all();
  if (rows.length === 0) return block;

  // Each repository row is its own API listing: check every read of it against the limit.
  const reads = new Map(); // repo_id -> date -> published dates (yyyy-mm-dd or '')
  for (const r of rows) {
    if (!reads.has(r.repo_id)) reads.set(r.repo_id, new Map());
    const byDate = reads.get(r.repo_id);
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r.published_at ? String(r.published_at).slice(0, 10) : '');
  }
  const truncated = [];
  for (const [repoId, byDate] of reads) {
    let previousRead = null;
    for (const date of [...byDate.keys()].sort()) {
      const listed = byDate.get(date);
      if (listed.length >= RELEASES_PER_READ) {
        const oldest = listed.filter(Boolean).sort()[0] || date;
        const repo = canonOf(canon, repoId);
        if (previousRead === null) {
          truncated.push({ repo, from: null, to: oldest, read: date, reason: 'first read returned the limit; older releases were not read' });
        } else if (oldest >= previousRead) {
          truncated.push({ repo, from: previousRead, to: oldest, read: date, reason: 'read returned the limit; releases since the previous read may be missing' });
        }
      }
      previousRead = date;
    }
  }
  truncated.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.read < b.read ? -1 : a.read > b.read ? 1 : 0));

  // One release per (canonical repo, tag), dated by its newest read.
  const releases = new Map();
  for (const r of rows) {
    if (!r.published_at) continue;
    const repo = canonOf(canon, r.repo_id);
    const key = `${repo}\u0000${r.tag_name}`;
    const seen = releases.get(key);
    if (!seen || r.date >= seen.read) {
      releases.set(key, { repo, read: r.date, published: String(r.published_at).slice(0, 10) });
    }
  }

  const asOf = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
  const firstRead = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);
  const list = [...releases.values()];
  block.firstSnapshot = firstRead;
  block.asOf = asOf;
  block.total = list.length;
  block.repos = new Set(list.map(r => r.repo)).size;
  block.coverage.truncated = truncated;

  const count = (from, to) => {
    const inRange = list.filter(r => r.published >= from && r.published <= to);
    return { releases: inRange.length, repos: new Set(inRange.map(r => r.repo)).size };
  };
  const isComplete = (from, to) => !truncated.some(t => overlaps(t, from, to));

  const recentFrom = addDays(asOf, -(RECENT_RELEASE_DAYS - 1));
  block.recent = {
    days: RECENT_RELEASE_DAYS,
    from: recentFrom,
    to: asOf,
    ...count(recentFrom, asOf),
    complete: isComplete(recentFrom, asOf),
  };

  if (list.length > 0) {
    const earliest = list.reduce((m, r) => (r.published < m ? r.published : m), list[0].published);
    const quarters = [];
    for (let q = quarterOf(earliest); q <= quarterOf(asOf); q = nextQuarter(q)) {
      const { from, to } = quarterBounds(q);
      const inProgress = to > asOf;
      quarters.push({ quarter: q, from, to, ...count(from, to), complete: !inProgress && isComplete(from, to), inProgress });
    }
    block.quarters = quarters;
    const newest = [...quarters].reverse().find(q => q.complete);
    block.perQuarter = newest ? { quarter: newest.quarter, releases: newest.releases, repos: newest.repos } : null;
  }
  return block;
}

// --- breadth ----------------------------------------------------------------------

const BREADTH = [
  { ecosystem: 'github', unit: 'repositories', table: 'repositories' },
  { ecosystem: 'npm', unit: 'packages', table: 'npm_packages' },
  { ecosystem: 'pypi', unit: 'packages', table: 'pypi_packages' },
  { ecosystem: 'docker', unit: 'images', table: 'docker_images' },
  { ecosystem: 'huggingface', unit: 'models', table: 'huggingface_models' },
  { ecosystem: 'chrome', unit: 'extensions', table: 'chrome_extensions' },
];

function computeBreadth(db) {
  const items = BREADTH.map(({ ecosystem, unit, table }) => {
    let count = 0;
    if (tableExists(db, table)) {
      count = table === 'repositories'
        ? groupByCanonical(db.prepare('SELECT full_name, canonical_full_name FROM repositories').all()).size
        : db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    return { ecosystem, unit, count };
  });
  return { ecosystems: items.filter(i => i.count > 0).length, items };
}

/**
 * Compute the community block. `db` is an open better-sqlite3 handle (read-only
 * is fine). Pure function of the database; no clock is read.
 */
function computeCommunity(db) {
  return {
    contributors: computeContributors(db),
    stars: snapshotTrend(db, 'stargazers', 'total_stars'),
    forks: snapshotTrend(db, 'forks', 'total_forks'),
    releases: computeReleases(db),
    breadth: computeBreadth(db),
  };
}

module.exports = { computeCommunity, quarterOf, quarterBounds, monthEnd, RELEASES_PER_READ };
