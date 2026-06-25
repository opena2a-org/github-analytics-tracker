const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const {
  canonicalNameOf, ownNameOf, groupByCanonical, pickCanonical,
  mergeByCanonical, canonicalRepoTotals,
} = require('../lib/repos');

// Overview-shaped repoStat factory — only the fields the merge reads.
function row(owner, repo, canonical, { views = 0, clones = 0, stars = 0, forks = 0, archived = false } = {}) {
  return {
    name: `${owner}/${repo}`, owner, repo,
    canonicalFullName: canonical || `${owner}/${repo}`,
    totalViews: views, views24h: 0, views7d: 0, views30d: 0, customViews: 0,
    totalClones: clones, clones24h: 0, clones7d: 0, clones30d: 0, customClones: 0,
    recentUniqueVisitors: 0, recentUniqueCloners: 0,
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

test('mergeByCanonical: transfer twin — traffic sums, stars from canonical (live) row', () => {
  // Stale opena2a-org row + live opena2a-standards row for the same spec.
  const merged = mergeByCanonical([
    row('opena2a-org', 'agent-trust-protocol', 'opena2a-standards/agent-trust-protocol', { views: 33, clones: 114, stars: 2 }),
    row('opena2a-standards', 'agent-trust-protocol', 'opena2a-standards/agent-trust-protocol', { views: 35, clones: 69, stars: 2 }),
  ]);
  assert.strictEqual(merged.length, 1, 'twins collapse to one logical repo');
  const m = merged[0];
  assert.strictEqual(m.name, 'opena2a-standards/agent-trust-protocol', 'reported under canonical path');
  assert.strictEqual(m.owner, 'opena2a-standards');
  assert.strictEqual(m.totalViews, 68, 'views summed across twins');
  assert.strictEqual(m.totalClones, 183, 'clones summed across twins');
  assert.strictEqual(m.stars, 2, 'stars NOT summed — taken from canonical row (would be 4 if summed)');
  assert.strictEqual(m.aliasCount, 1);
});

test('mergeByCanonical: rename twin — different names, canonical stars win', () => {
  // arp (frozen, 1 star) renamed to agent-runtime-protection (live, 2 stars).
  const merged = mergeByCanonical([
    row('opena2a-org', 'arp', 'opena2a-org/agent-runtime-protection', { clones: 142, stars: 1 }),
    row('opena2a-org', 'agent-runtime-protection', 'opena2a-org/agent-runtime-protection', { clones: 592, stars: 2 }),
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].repo, 'agent-runtime-protection');
  assert.strictEqual(merged[0].clones === undefined ? merged[0].totalClones : merged[0].totalClones, 734, 'clones summed');
  assert.strictEqual(merged[0].stars, 2, 'stars from canonical, not 3');
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
  `);
  const addRepo = db.prepare('INSERT INTO repositories (id, owner, repo, full_name, canonical_full_name, archived) VALUES (?,?,?,?,?,?)');
  const addStar = db.prepare('INSERT INTO stargazers (repo_id, date, total_stars) VALUES (?,?,?)');
  const addFork = db.prepare('INSERT INTO forks (repo_id, date, total_forks) VALUES (?,?,?)');

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

  const t = canonicalRepoTotals(db);
  db.close();
  assert.strictEqual(t.repoCount, 3, 'twin collapses: hackmyagent, spec, killchain');
  assert.strictEqual(t.stars, 34, '30 + 2 (canonical spec, not the 9 twin) + 2 (archived)');
  assert.strictEqual(t.forks, 7, '2 + 0 + 5');
});
