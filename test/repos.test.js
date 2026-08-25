const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const {
  canonicalNameOf, ownNameOf, groupByCanonical, pickCanonical,
  mergeByCanonical, canonicalRepoTotals, canonicalTrafficSum, canonicalTrafficTotals,
} = require('../lib/repos');

// Overview-shaped repoStat factory — only the fields the merge reads.
function row(owner, repo, canonical, { views = 0, clones = 0, uniqueCloners = 0, stars = 0, forks = 0, archived = false } = {}) {
  return {
    name: `${owner}/${repo}`, owner, repo,
    canonicalFullName: canonical || `${owner}/${repo}`,
    totalViews: views, views24h: 0, views7d: 0, views30d: 0, customViews: 0,
    totalClones: clones, clones24h: 0, clones7d: 0, clones30d: 0, customClones: 0,
    // 14-day deduplicated distinct cloners — a snapshot, taken from the canonical row.
    recentUniqueVisitors: 0, recentUniqueCloners: uniqueCloners,
    stars, starsGrowth24h: 0, starsGrowth7d: 0, starsGrowth30d: 0, starsGrowthAll: 0, starsGrowthCustom: 0,
    forks, archived,
  };
}

test('canonicalNameOf / ownNameOf read both row shapes', () => {
  assert.strictEqual(canonicalNameOf({ canonical_full_name: 'o/c', full_name: 'o/a' }), 'o/c');
  assert.strictEqual(canonicalNameOf({ canonicalFullName: 'o/c', name: 'o/a' }), 'o/c');
  assert.strictEqual(canonicalNameOf({ full_name: 'o/a' }), 'o/a', 'falls back to own name');
  assert.strictEqual(ownNameOf({ full_name: 'o/a' }), 'o/a');
  assert.strictEqual(ownNameOf({ name: 'o/a' }), 'o/a');
});

test('mergeByCanonical: transfer twin — snapshot metrics from canonical (live) row', () => {
  // Stale opena2a-org row + live opena2a-standards row for the same spec. The
  // caller (overview.js) has already collapsed traffic per (canonical, date),
  // so the twin row carries no traffic of its own here.
  const merged = mergeByCanonical([
    row('opena2a-org', 'agent-trust-protocol', 'opena2a-standards/agent-trust-protocol', { uniqueCloners: 8, stars: 2 }),
    row('opena2a-standards', 'agent-trust-protocol', 'opena2a-standards/agent-trust-protocol', { views: 68, clones: 183, uniqueCloners: 5, stars: 2 }),
  ]);
  assert.strictEqual(merged.length, 1, 'twins collapse to one logical repo');
  const m = merged[0];
  assert.strictEqual(m.name, 'opena2a-standards/agent-trust-protocol', 'reported under canonical path');
  assert.strictEqual(m.owner, 'opena2a-standards');
  assert.strictEqual(m.totalViews, 68);
  assert.strictEqual(m.totalClones, 183);
  assert.strictEqual(m.recentUniqueCloners, 5, 'distinct cloners taken from canonical row (NOT summed to 13 — a rolling 14-day count cannot be added across twins)');
  assert.strictEqual(m.stars, 2, 'stars NOT summed — taken from canonical row (would be 4 if summed)');
  assert.strictEqual(m.aliasCount, 1);
});

test('canonicalTrafficSum: overlapping twin days count once, taking the canonical row', () => {
  // arp (old slug) renamed to agent-runtime-protection. GitHub's traffic API
  // returns a 14-day window, so the old slug's last collection and the new
  // slug's first collections cover the SAME days — the histories are not
  // disjoint. Measured on the committed DB 2026-08-25: 61 overlapping
  // (canonical, date) pairs, identical counts, 629 clones double-counted.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, owner TEXT, repo TEXT, full_name TEXT UNIQUE, canonical_full_name TEXT, archived INTEGER DEFAULT 0);
    CREATE TABLE traffic_clones (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, count INTEGER, uniques INTEGER, UNIQUE(repo_id, date));
    CREATE TABLE traffic_views  (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, count INTEGER, uniques INTEGER, UNIQUE(repo_id, date));
  `);
  const addRepo = db.prepare('INSERT INTO repositories (id, owner, repo, full_name, canonical_full_name) VALUES (?,?,?,?,?)');
  const addClone = db.prepare('INSERT INTO traffic_clones (repo_id, date, count, uniques) VALUES (?,?,?,?)');
  const addView = db.prepare('INSERT INTO traffic_views (repo_id, date, count, uniques) VALUES (?,?,?,?)');
  addRepo.run(1, 'o', 'arp', 'o/arp', 'o/agent-runtime-protection');                          // stale slug
  addRepo.run(2, 'o', 'agent-runtime-protection', 'o/agent-runtime-protection', 'o/agent-runtime-protection'); // canonical
  addRepo.run(3, 'o', 'hackmyagent', 'o/hackmyagent', null);                                   // not yet backfilled

  // Old slug: 03-01 .. 03-03. New slug: 03-02 .. 03-04. 03-02 and 03-03 overlap.
  addClone.run(1, '2026-03-01', 10, 2);
  addClone.run(1, '2026-03-02', 7, 1);   // overlap, identical count
  addClone.run(1, '2026-03-03', 5, 1);   // overlap, twin disagrees (canonical must win)
  addClone.run(2, '2026-03-02', 7, 1);
  addClone.run(2, '2026-03-03', 6, 1);
  addClone.run(2, '2026-03-04', 4, 1);
  addView.run(1, '2026-03-02', 3, 1);
  addView.run(2, '2026-03-02', 3, 1);
  addClone.run(3, '2026-03-04', 100, 9);

  const canon = 'o/agent-runtime-protection';
  // Naive sum across both rows = 10+7+5+7+6+4 = 39. Collapsed = 10 + 7 + 6 + 4 = 27.
  assert.strictEqual(canonicalTrafficSum(db, 'traffic_clones', canon), 27, 'overlapping days count once, canonical value on disagreement');
  assert.strictEqual(canonicalTrafficSum(db, 'traffic_views', canon), 3, 'views: one overlapping day counts once');
  assert.strictEqual(canonicalTrafficSum(db, 'traffic_clones', canon, 't.date >= ? AND t.date <= ?', ['2026-03-03', '2026-03-04']), 10, 'windowed: 6 + 4');
  assert.strictEqual(canonicalTrafficSum(db, 'traffic_clones', 'o/hackmyagent'), 100, 'NULL canonical_full_name falls back to own name');

  const t = canonicalTrafficTotals(db);
  assert.deepStrictEqual(t, { views: 3, clones: 127 }, '27 + 100');
  assert.deepStrictEqual(canonicalTrafficTotals(db, { excludeCanonical: 'o/hackmyagent' }), { views: 3, clones: 27 });
  assert.throws(() => canonicalTrafficSum(db, 'repositories', canon), /unsupported table/);
  db.close();
});

test('mergeByCanonical: archived-but-real repo is kept (single canonical row)', () => {
  const merged = mergeByCanonical([
    row('opena2a-org', 'ai-agent-kill-chain', 'opena2a-org/ai-agent-kill-chain', { stars: 2, archived: true }),
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].stars, 2, 'archived repo still counts its last-known stars');
  assert.strictEqual(merged[0].archived, true);
  assert.strictEqual(merged[0].aliasCount, 0);
});

test('mergeByCanonical: independent repos are untouched and total stars are not inflated', () => {
  const merged = mergeByCanonical([
    row('opena2a-org', 'hackmyagent', null, { stars: 30 }),
    row('opena2a-org', 'AI-BrowserGuard', 'opena2a-org/ai-browserguard', { stars: 2 }),
    row('opena2a-org', 'ai-browserguard', 'opena2a-org/ai-browserguard', { stars: 4 }),
  ]);
  assert.strictEqual(merged.length, 2, 'AI-BrowserGuard collapses into ai-browserguard');
  const total = merged.reduce((s, r) => s + r.stars, 0);
  assert.strictEqual(total, 34, '30 + 4 (canonical), not 30 + 2 + 4 = 36');
});

test('canonicalRepoTotals: dedups twins against a real DB schema', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, owner TEXT, repo TEXT, full_name TEXT UNIQUE, canonical_full_name TEXT, archived INTEGER DEFAULT 0);
    CREATE TABLE stargazers (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, total_stars INTEGER);
    CREATE TABLE forks (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, total_forks INTEGER);
    CREATE TABLE traffic_summary (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, views_count INTEGER, views_uniques INTEGER, clones_count INTEGER, clones_uniques INTEGER);
  `);
  const addRepo = db.prepare('INSERT INTO repositories (id, owner, repo, full_name, canonical_full_name, archived) VALUES (?,?,?,?,?,?)');
  const addStar = db.prepare('INSERT INTO stargazers (repo_id, date, total_stars) VALUES (?,?,?)');
  const addFork = db.prepare('INSERT INTO forks (repo_id, date, total_forks) VALUES (?,?,?)');
  const addSummary = db.prepare('INSERT INTO traffic_summary (repo_id, date, views_count, views_uniques, clones_count, clones_uniques) VALUES (?,?,0,0,0,?)');

  // 1: live repo (3 stars). 2: stale transfer twin of 3. 3: canonical of the twin (2 stars).
  // 4: archived real repo, last snapshot is older (2 stars) — must still count.
  addRepo.run(1, 'o', 'hackmyagent', 'o/hackmyagent', 'o/hackmyagent', 0);
  addRepo.run(2, 'o', 'spec', 'o/spec', 'std/spec', 0);
  addRepo.run(3, 'std', 'spec', 'std/spec', 'std/spec', 0);
  addRepo.run(4, 'o', 'killchain', 'o/killchain', 'o/killchain', 1);

  addStar.run(1, '2026-06-18', 30); addFork.run(1, '2026-06-18', 2);
  addStar.run(2, '2026-05-24', 9);  addFork.run(2, '2026-05-24', 1);   // stale twin (would inflate)
  addStar.run(3, '2026-06-18', 2);  addFork.run(3, '2026-06-18', 0);   // canonical
  addStar.run(4, '2026-05-24', 2);  addFork.run(4, '2026-05-24', 5);   // archived, older date

  // Deduped unique cloners: canonical row of the twin wins (5), stale twin's 9 dropped.
  addSummary.run(1, '2026-06-18', 30); // live
  addSummary.run(2, '2026-05-24', 9);  // stale twin — MUST be dropped, not summed
  addSummary.run(3, '2026-06-18', 5);  // canonical
  addSummary.run(4, '2026-05-24', 2);  // archived

  const t = canonicalRepoTotals(db);
  db.close();
  assert.strictEqual(t.repoCount, 3, 'twin collapses: hackmyagent, spec, killchain');
  assert.strictEqual(t.stars, 34, '30 + 2 (canonical spec, not the 9 twin) + 2 (archived)');
  assert.strictEqual(t.forks, 7, '2 + 0 + 5');
  assert.strictEqual(t.uniqueCloners, 37, '30 + 5 (canonical spec, NOT the 9 stale twin) + 2 (archived)');
});
