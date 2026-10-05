const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Database = require('better-sqlite3');

const { computeCommunity, quarterOf, quarterBounds, monthEnd, RELEASES_PER_READ } = require('../lib/community');
const { addDays } = require('../lib/momentum');
const { canonicalRepoTotals } = require('../lib/repos');
const { buildSummary } = require('../lib/summary');
const { computeOverview } = require('../lib/overview');

const DB_PATH = path.join(__dirname, '..', 'data', 'analytics.db');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, owner TEXT, repo TEXT, full_name TEXT, canonical_full_name TEXT);
    CREATE TABLE github_contributors (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, login TEXT, contributions INTEGER);
    CREATE TABLE stargazers (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, total_stars INTEGER);
    CREATE TABLE forks (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, total_forks INTEGER);
    CREATE TABLE traffic_summary (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, clones_uniques INTEGER);
    CREATE TABLE github_releases (id INTEGER PRIMARY KEY, repo_id INTEGER, tag_name TEXT, release_name TEXT, published_at TEXT, total_downloads INTEGER, date TEXT);
    CREATE TABLE npm_packages (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE docker_images (id INTEGER PRIMARY KEY, full_name TEXT);
    CREATE TABLE chrome_extensions (id INTEGER PRIMARY KEY, extension_id TEXT);
  `);
  const repo = db.prepare('INSERT INTO repositories VALUES (?,?,?,?,?)');
  repo.run(1, 'old', 'r', 'old/r', 'new/r'); // stale slug of a transferred repo
  repo.run(2, 'new', 'r', 'new/r', 'new/r'); // its canonical row
  repo.run(3, 'org', 'b', 'org/b', null);
  repo.run(4, 'org', 'c', 'org/c', 'org/c');

  const contrib = db.prepare('INSERT INTO github_contributors (repo_id, date, login, contributions) VALUES (?,?,?,?)');
  contrib.run(1, '2026-01-10', 'alice', 5); // first snapshot of new/r (taken under the old slug): baseline
  contrib.run(1, '2026-01-10', 'dependabot[bot]', 3);
  contrib.run(2, '2026-02-05', 'alice', 7); // rise across the twin boundary: active in February
  contrib.run(2, '2026-02-05', 'bob', 1); // a new author on a tracked repo: active
  contrib.run(3, '2026-02-20', 'carol', 10); // org/b's first snapshot: baseline, not active
  contrib.run(3, '2026-03-02', 'carol', 9); // a drop is not activity
  contrib.run(3, '2026-03-03', 'carol', 10); // back to the earlier high is not activity
  contrib.run(3, '2026-04-01', 'carol', 11); // above the earlier high: active in April
  contrib.run(2, '2026-04-01', 'alice', 7);
  contrib.run(2, '2026-04-01', 'bob', 1);

  const star = db.prepare('INSERT INTO stargazers (repo_id, date, total_stars) VALUES (?,?,?)');
  star.run(1, '2026-01-05', 50); // stale twin: never counted
  star.run(2, '2026-01-20', 10);
  star.run(2, '2026-01-31', 12);
  star.run(2, '2026-02-15', 15);
  star.run(3, '2026-02-10', 100); // first collected in February with 100 already
  star.run(3, '2026-02-28', 98);
  const fork = db.prepare('INSERT INTO forks (repo_id, date, total_forks) VALUES (?,?,?)');
  fork.run(1, '2026-01-05', 9);
  fork.run(2, '2026-01-20', 1);
  fork.run(2, '2026-02-15', 4);
  fork.run(3, '2026-02-10', 0);
  fork.run(3, '2026-02-28', 0);

  const rel = db.prepare('INSERT INTO github_releases (repo_id, tag_name, release_name, published_at, total_downloads, date) VALUES (?,?,?,?,0,?)');
  // new/r: the same release listed under both slugs counts once; a draft is left out;
  // v2's published_at changed and the newest read wins.
  rel.run(1, 'v1', 'v1', '2025-12-20T10:00:00Z', '2026-01-10');
  rel.run(2, 'v1', 'v1', '2025-12-20T10:00:00Z', '2026-02-01');
  rel.run(2, 'v2', 'v2', '2026-01-15T10:00:00Z', '2026-02-01');
  rel.run(2, 'draft', 'draft', '', '2026-02-01');
  rel.run(2, 'v1', 'v1', '2025-12-20T10:00:00Z', '2026-04-05');
  rel.run(2, 'v2', 'v2', '2026-04-02T10:00:00Z', '2026-04-05');
  // org/b: its first read returned the limit, oldest listed 2026-02-01, so
  // anything older was never read.
  for (let i = 0; i < RELEASES_PER_READ; i++) {
    const published = i < 28 ? addDays('2026-02-01', i) : '2026-03-01';
    rel.run(3, `b${i}`, `b${i}`, `${published}T00:00:00Z`, '2026-03-01');
  }
  rel.run(3, 'x1', 'x1', '2026-07-10T00:00:00Z', '2026-08-01');
  rel.run(3, 'x2', 'x2', '2026-07-20T00:00:00Z', '2026-08-01');
  rel.run(3, 'x3', 'x3', '2026-08-01T00:00:00Z', '2026-08-01');
  // org/c: a full read whose oldest release is newer than the previous read
  // leaves the days between unread.
  rel.run(4, 'c-old-1', 'c', '2026-08-20T00:00:00Z', '2026-09-01');
  rel.run(4, 'c-old-2', 'c', '2026-08-25T00:00:00Z', '2026-09-01');
  for (let i = 0; i < RELEASES_PER_READ; i++) {
    rel.run(4, `c${i}`, `c${i}`, `${addDays('2026-09-02', i % 9)}T00:00:00Z`, '2026-09-10');
  }

  db.prepare("INSERT INTO npm_packages (name) VALUES ('a'), ('b')").run();
  db.prepare("INSERT INTO docker_images (full_name) VALUES ('org/img')").run();
  return db;
}

test('calendar helpers: UTC month ends and quarter bounds', () => {
  assert.strictEqual(monthEnd('2026-02'), '2026-02-28');
  assert.strictEqual(monthEnd('2028-02'), '2028-02-29');
  assert.strictEqual(monthEnd('2026-12'), '2026-12-31');
  assert.strictEqual(quarterOf('2026-03-31'), '2026-Q1');
  assert.strictEqual(quarterOf('2026-04-01'), '2026-Q2');
  assert.strictEqual(quarterOf('2025-12-20T10:00:00Z'), '2025-Q4');
  assert.deepStrictEqual(quarterBounds('2026-Q3'), { from: '2026-07-01', to: '2026-09-30' });
});

test('contributors: bots excluded, first-seen growth, activity only above a repository high-water mark', () => {
  const db = fixtureDb();
  try {
    const c = computeCommunity(db).contributors;
    assert.strictEqual(c.firstSnapshot, '2026-01-10');
    assert.strictEqual(c.asOf, '2026-04-01');
    assert.strictEqual(c.total, 3, 'alice, bob, carol');
    assert.strictEqual(c.botsExcluded, 1);
    assert.deepStrictEqual(c.months, [
      { month: '2026-01', cumulative: 1, newContributors: 1, active: 0, baseline: true, inProgress: false },
      { month: '2026-02', cumulative: 3, newContributors: 2, active: 2, baseline: false, inProgress: false },
      { month: '2026-03', cumulative: 3, newContributors: 0, active: 0, baseline: false, inProgress: false },
      { month: '2026-04', cumulative: 3, newContributors: 0, active: 1, baseline: false, inProgress: true },
    ]);
  } finally {
    db.close();
  }
});

test('stars and forks: a newly tracked repository is carried in, not counted as growth', () => {
  const db = fixtureDb();
  try {
    const { stars, forks } = computeCommunity(db);
    assert.strictEqual(stars.firstSnapshot, '2026-01-20', 'the stale twin row is not read');
    assert.strictEqual(stars.asOf, '2026-02-28');
    assert.deepStrictEqual(stars.months, [
      { month: '2026-01', total: 12, carriedIn: 10, netGained: 2, reposNewlyTracked: 1, inProgress: false },
      { month: '2026-02', total: 113, carriedIn: 100, netGained: 1, reposNewlyTracked: 1, inProgress: false },
    ]);
    assert.deepStrictEqual(forks.months, [
      { month: '2026-01', total: 1, carriedIn: 1, netGained: 0, reposNewlyTracked: 1, inProgress: false },
      { month: '2026-02', total: 4, carriedIn: 0, netGained: 3, reposNewlyTracked: 1, inProgress: false },
    ]);
    const totals = canonicalRepoTotals(db);
    assert.strictEqual(stars.months.at(-1).total, totals.stars, 'newest month equals the canonical star total');
    assert.strictEqual(forks.months.at(-1).total, totals.forks);
  } finally {
    db.close();
  }
});

test('releases: one per canonical repo and tag, quarters a capped read may have cut are not complete', () => {
  const db = fixtureDb();
  try {
    const r = computeCommunity(db).releases;
    assert.strictEqual(r.firstSnapshot, '2026-01-10');
    assert.strictEqual(r.asOf, '2026-09-10');
    assert.strictEqual(r.total, 67, 'v1 once across twins, v2, 30 + 3 on org/b, 2 + 30 on org/c; the draft is left out');
    assert.strictEqual(r.repos, 3);
    assert.deepStrictEqual(r.coverage.truncated, [
      { repo: 'org/b', from: null, to: '2026-02-01', read: '2026-03-01', reason: 'first read returned the limit; older releases were not read' },
      { repo: 'org/c', from: '2026-09-01', to: '2026-09-02', read: '2026-09-10', reason: 'read returned the limit; releases since the previous read may be missing' },
    ]);
    assert.deepStrictEqual(r.quarters.map(q => [q.quarter, q.releases, q.repos, q.complete, q.inProgress]), [
      ['2025-Q4', 1, 1, false, false],
      ['2026-Q1', 30, 1, false, false],
      ['2026-Q2', 1, 1, true, false],
      ['2026-Q3', 35, 2, false, true],
    ]);
    assert.deepStrictEqual(r.perQuarter, { quarter: '2026-Q2', releases: 1, repos: 1 });
    assert.deepStrictEqual(r.recent, { days: 90, from: '2026-06-13', to: '2026-09-10', releases: 35, repos: 2, complete: false });
  } finally {
    db.close();
  }
});

test('breadth counts canonical repositories and each registry table', () => {
  const db = fixtureDb();
  try {
    const b = computeCommunity(db).breadth;
    assert.deepStrictEqual(b.items.map(i => [i.ecosystem, i.unit, i.count]), [
      ['github', 'repositories', 3],
      ['npm', 'packages', 2],
      ['pypi', 'packages', 0],
      ['docker', 'images', 1],
      ['huggingface', 'models', 0],
      ['chrome', 'extensions', 0],
    ]);
    assert.strictEqual(b.ecosystems, 3);
  } finally {
    db.close();
  }
});

test('an empty database yields null dates, zero counts and empty lists, never an estimate', () => {
  const db = new Database(':memory:');
  try {
    const c = computeCommunity(db);
    assert.strictEqual(c.contributors.asOf, null);
    assert.strictEqual(c.contributors.total, 0);
    assert.deepStrictEqual(c.contributors.months, []);
    for (const k of ['stars', 'forks']) {
      assert.strictEqual(c[k].asOf, null);
      assert.deepStrictEqual(c[k].months, []);
    }
    assert.strictEqual(c.releases.asOf, null);
    assert.strictEqual(c.releases.total, 0);
    assert.strictEqual(c.releases.perQuarter, null);
    assert.strictEqual(c.releases.recent, null);
    assert.deepStrictEqual(c.releases.quarters, []);
    assert.deepStrictEqual(c.releases.coverage.truncated, []);
    assert.strictEqual(c.breadth.ecosystems, 0);
    assert.ok(c.breadth.items.every(i => i.count === 0));
  } finally {
    db.close();
  }
});

test('summary.json and the overview API publish the same community block (committed database)', () => {
  const db = new Database(DB_PATH, { readonly: true });
  let summary, overview, totals;
  try {
    summary = buildSummary(db, { env: {} });
    overview = computeOverview(db, {});
    totals = canonicalRepoTotals(db);
  } finally {
    db.close();
  }
  assert.ok(summary.community && overview.community, 'both surfaces carry community');
  assert.deepStrictEqual(summary.community, overview.community);
  const c = summary.community;

  const contrib = c.contributors;
  assert.ok(contrib.asOf && contrib.months.length > 0, 'contributor snapshots present');
  assert.strictEqual(contrib.months.at(-1).cumulative, contrib.total);
  assert.strictEqual(contrib.months.reduce((s, m) => s + m.newContributors, 0), contrib.total);

  for (const [key, expected] of [['stars', summary.total.stars], ['forks', totals.forks]]) {
    const months = c[key].months;
    assert.ok(months.length > 0, `${key} months present`);
    assert.strictEqual(months.at(-1).total, expected, `${key}: newest month equals the published total`);
    months.forEach((m, i) => {
      const before = i === 0 ? 0 : months[i - 1].total;
      assert.strictEqual(m.total, before + m.carriedIn + m.netGained, `${key} ${m.month} reconciles`);
    });
  }

  const r = c.releases;
  assert.ok(r.asOf && r.quarters.length > 0, 'release reads present');
  assert.strictEqual(r.quarters.reduce((s, q) => s + q.releases, 0), r.total, 'every release falls in one listed quarter');
  for (const q of r.quarters) {
    const cut = r.coverage.truncated.some(t => (t.from === null || t.from <= q.to) && t.to >= q.from);
    if (cut || q.inProgress) assert.strictEqual(q.complete, false, `${q.quarter} must not be presented as complete`);
  }
  const newest = [...r.quarters].reverse().find(q => q.complete);
  assert.deepStrictEqual(r.perQuarter, newest ? { quarter: newest.quarter, releases: newest.releases, repos: newest.repos } : null);

  const count = e => c.breadth.items.find(i => i.ecosystem === e).count;
  assert.strictEqual(count('github'), summary.total.repos);
  assert.strictEqual(count('npm'), summary.total.npmPackages);
  assert.strictEqual(count('chrome'), summary.total.chromeExtensions);
});
