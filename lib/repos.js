/**
 * Canonical-repo collapsing for transferred / renamed repositories.
 *
 * GitHub keeps redirecting an old slug to its new home after a transfer
 * (opena2a-org -> opena2a-standards) or a rename (arp -> agent-runtime-protection,
 * AI-BrowserGuard -> ai-browserguard, open-agent-security-benchmark -> oasb), so
 * `octokit.repos.get(old/slug).full_name` already returns the *current* canonical
 * path. The daily collector discovers repos by the live org listing (new names
 * only), so it never re-collects the old slug — the pre-move history is frozen in
 * a stale `repositories` row that is never pruned (we keep it: its traffic history
 * is disjoint in time from the canonical row and should be summed, not lost).
 *
 * Every aggregation that simply summed over `repositories` therefore double-counted
 * these twins. Stars/forks are *snapshots* (a running total, not a per-day delta),
 * so summing a stale 2-star row plus the live 3-star row reports 5 where the repo
 * has 3. Views/clones are *additive* daily counts, so summing the disjoint twin
 * histories is correct and intended.
 *
 * Canonical rule, applied identically on every surface:
 *   - group rows by their canonical full_name (stored in repositories.canonical_full_name,
 *     falling back to the row's own full_name when not yet backfilled);
 *   - SUM additive traffic across the whole group (disjoint histories combine);
 *   - take snapshot metrics (stars, forks, star growth, 14-day uniques) from the
 *     canonical row — the one whose own full_name equals the group key (i.e. the
 *     live repo), falling back to the first row when the canonical isn't tracked.
 *
 * Shared by pages/api/overview.js, pages/api/repos.js, the markdown/summary
 * generators, and the regression test so the numbers can never drift between
 * surfaces.
 */

// The canonical full_name for a repo row, regardless of which shape it came in
// (overview camelCase `canonicalFullName`/`name`, or raw DB snake_case
// `canonical_full_name`/`full_name`).
function canonicalNameOf(row) {
  return row.canonicalFullName || row.canonical_full_name || row.full_name || row.name;
}

// The row's own full_name (its actual owner/repo path), shape-agnostic.
function ownNameOf(row) {
  return row.full_name || row.name;
}

// Group rows that resolve to the same canonical repo. Returns a Map keyed by the
// canonical full_name, preserving input order within each group.
function groupByCanonical(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = canonicalNameOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// Pick the canonical row from a twin group: the one whose own path equals the
// group key (the live repo), else the first row (canonical isn't separately
// tracked — keep this row's data but report it under the canonical name).
function pickCanonical(rows, canon) {
  return rows.find(r => ownNameOf(r) === canon) || rows[0];
}

/**
 * Collapse overview-shaped repoStats (see pages/api/overview.js) into one logical
 * row per canonical repo. Additive traffic is summed across twins; snapshot
 * metrics come from the canonical row.
 */
function mergeByCanonical(repoStats) {
  const out = [];
  for (const [canon, group] of groupByCanonical(repoStats)) {
    const c = pickCanonical(group, canon);
    const sum = k => group.reduce((s, r) => s + (r[k] || 0), 0);
    const slash = canon.indexOf('/');
    out.push({
      name: canon,
      owner: slash >= 0 ? canon.slice(0, slash) : c.owner,
      repo: slash >= 0 ? canon.slice(slash + 1) : c.repo,
      // Additive daily traffic — sum the disjoint twin histories.
      totalViews: sum('totalViews'),
      views24h: sum('views24h'), views7d: sum('views7d'), views30d: sum('views30d'),
      customViews: sum('customViews'),
      totalClones: sum('totalClones'),
      clones24h: sum('clones24h'), clones7d: sum('clones7d'), clones30d: sum('clones30d'),
      customClones: sum('customClones'),
      // 14-day deduplicated uniques are a snapshot (the adoption clone term) — take
      // the canonical (live) row's value, never summed across twins.
      recentUniqueVisitors: c.recentUniqueVisitors || 0,
      recentUniqueCloners: c.recentUniqueCloners || 0,
      // Snapshot metrics — from the canonical row, never summed.
      stars: c.stars || 0,
      starsGrowth24h: c.starsGrowth24h || 0,
      starsGrowth7d: c.starsGrowth7d || 0,
      starsGrowth30d: c.starsGrowth30d || 0,
      starsGrowthAll: c.starsGrowthAll || 0,
      starsGrowthCustom: c.starsGrowthCustom || 0,
      forks: c.forks || 0,
      archived: !!c.archived,
      aliasCount: group.length - 1,
    });
  }
  return out;
}

/**
 * Deduplicated star / fork / repo-count totals straight from the DB, grouped by
 * canonical repo. Used by generate-summary.js so summary.json matches the API.
 * Stars/forks are taken from each canonical repo's latest snapshot, then summed
 * across canonical repos (no twin double-counting, and archived-but-real repos
 * such as ai-agent-kill-chain are still counted via their last snapshot).
 */
function canonicalRepoTotals(db) {
  const repos = db.prepare(
    'SELECT id, owner, repo, full_name, canonical_full_name FROM repositories'
  ).all();
  const latestStar = db.prepare(
    'SELECT total_stars FROM stargazers WHERE repo_id = ? ORDER BY date DESC LIMIT 1'
  );
  const latestFork = db.prepare(
    'SELECT total_forks FROM forks WHERE repo_id = ? ORDER BY date DESC LIMIT 1'
  );
  // Latest 14-day deduplicated distinct-cloner count per repo (a snapshot).
  const latestUniqCloners = db.prepare(
    'SELECT clones_uniques FROM traffic_summary WHERE repo_id = ? ORDER BY date DESC LIMIT 1'
  );
  const rows = repos.map(r => ({
    full_name: r.full_name,
    canonical_full_name: r.canonical_full_name,
    stars: latestStar.get(r.id)?.total_stars || 0,
    forks: latestFork.get(r.id)?.total_forks || 0,
    uniqueCloners: latestUniqCloners.get(r.id)?.clones_uniques || 0,
  }));

  let stars = 0, forks = 0, repoCount = 0, uniqueCloners = 0;
  for (const [canon, group] of groupByCanonical(rows)) {
    const c = pickCanonical(group, canon);
    stars += c.stars || 0;
    forks += c.forks || 0;
    // 14-day dedup snapshot from the canonical (live) row — NEVER summed across
    // twins (you cannot add two rolling 14-day dedup counts). Stale slug's own
    // clones_uniques is dropped, matching mergeByCanonical / the overview API.
    uniqueCloners += c.uniqueCloners || 0;
    repoCount += 1;
  }
  return { stars, forks, repoCount, uniqueCloners };
}

module.exports = {
  canonicalNameOf,
  ownNameOf,
  groupByCanonical,
  pickCanonical,
  mergeByCanonical,
  canonicalRepoTotals,
};
