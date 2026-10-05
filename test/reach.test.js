const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Database = require('better-sqlite3');

const { computeReach, channelOf, sharePct } = require('../lib/reach');
const { buildSummary } = require('../lib/summary');
const { computeOverview } = require('../lib/overview');

const DB_PATH = path.join(__dirname, '..', 'data', 'analytics.db');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, owner TEXT, repo TEXT, full_name TEXT, canonical_full_name TEXT);
    CREATE TABLE referrers (id INTEGER PRIMARY KEY, repo_id INTEGER, referrer TEXT, count INTEGER, uniques INTEGER, date TEXT);
    CREATE TABLE pypi_python_versions (id INTEGER PRIMARY KEY, package_id INTEGER, date TEXT, python_version TEXT, downloads INTEGER);
    CREATE TABLE pypi_system_stats (id INTEGER PRIMARY KEY, package_id INTEGER, date TEXT, os_name TEXT, downloads INTEGER);
  `);
  const repo = db.prepare('INSERT INTO repositories VALUES (?,?,?,?,?)');
  repo.run(1, 'old', 'r', 'old/r', 'new/r'); // stale slug of a transferred repo
  repo.run(2, 'new', 'r', 'new/r', 'new/r'); // its canonical row
  repo.run(3, 'org', 'b', 'org/b', null);
  const ref = db.prepare('INSERT INTO referrers (repo_id, referrer, count, uniques, date) VALUES (?,?,?,?,?)');
  // Newest window: both twins hold the same list; it must count once.
  ref.run(1, 'github.com', 40, 10, '2026-06-14');
  ref.run(2, 'github.com', 40, 10, '2026-06-14');
  ref.run(2, 'Google', 30, 20, '2026-06-14');
  ref.run(3, 'Google', 10, 5, '2026-06-14');
  ref.run(3, 'gemini.google.com', 5, 4, '2026-06-14');
  ref.run(3, 'l.facebook.com', 10, 6, '2026-06-14');
  ref.run(3, 'arcanum-sec.github.io', 5, 3, '2026-06-14');
  // An older window: not part of the newest 14-day mix.
  ref.run(3, 'news.ycombinator.com', 999, 999, '2026-06-13');

  const py = db.prepare('INSERT INTO pypi_python_versions (package_id, date, python_version, downloads) VALUES (?,?,?,?)');
  py.run(1, '2026-06-14', '3.12', 60);
  py.run(2, '2026-06-14', '3.12', 15);
  py.run(2, '2026-06-14', '3.11', 25);
  py.run(1, '2026-06-13', '2.7', 5000); // older snapshot, ignored
  const os = db.prepare('INSERT INTO pypi_system_stats (package_id, date, os_name, downloads) VALUES (?,?,?,?)');
  os.run(1, '2026-06-14', 'Linux', 60);
  os.run(1, '2026-06-14', 'null', 100);
  os.run(2, '2026-06-14', 'Linux', 15);
  os.run(2, '2026-06-14', 'Darwin', 25);
  os.run(2, '2026-06-14', 'unknown', 0);
  return db;
}

test('channelOf matches hosts and subdomains, longest entry first, and defaults to other', () => {
  assert.strictEqual(channelOf('Google'), 'search', 'GitHub names search engines');
  assert.strictEqual(channelOf('www.google.com'), 'search');
  assert.strictEqual(channelOf('gemini.google.com'), 'ai-assistant', 'more specific than google.com');
  assert.strictEqual(channelOf('chatgpt.com'), 'ai-assistant');
  assert.strictEqual(channelOf('github.com'), 'github');
  assert.strictEqual(channelOf('gist.github.com'), 'github');
  assert.strictEqual(channelOf('arcanum-sec.github.io'), 'other', 'GitHub Pages sites are third parties');
  assert.strictEqual(channelOf('l.facebook.com'), 'social');
  assert.strictEqual(channelOf('t.co'), 'social');
  assert.strictEqual(channelOf('pypi.org'), 'package-registry');
  assert.strictEqual(channelOf('specs.opena2a.org'), 'own-site');
  assert.strictEqual(channelOf('notopena2a.org'), 'other', 'suffix match is on a label boundary');
  assert.strictEqual(channelOf('teams.public.onecdn.static.microsoft'), 'other');
});

test('the referrer mix reads one 14-day window and counts a transferred repo once', () => {
  const db = fixtureDb();
  try {
    const g = computeReach(db).githubReferrers;
    assert.strictEqual(g.asOf, '2026-06-14');
    assert.strictEqual(g.windowDays, 14);
    assert.strictEqual(g.repos, 2, 'new/r (twins collapsed) and org/b');
    assert.strictEqual(g.views, 40 + 30 + 10 + 5 + 10 + 5, 'twin list counted once, older window excluded');
    assert.strictEqual(g.uniques, 10 + 20 + 5 + 4 + 6 + 3);
    assert.ok(!g.referrers.some(r => r.referrer === 'news.ycombinator.com'), 'older window excluded');

    const gh = g.referrers.find(r => r.referrer === 'github.com');
    assert.deepStrictEqual(gh, { referrer: 'github.com', channel: 'github', views: 40, uniques: 10, repos: 1, sharePct: sharePct(40, 100) });
    const google = g.referrers.find(r => r.referrer === 'Google');
    assert.strictEqual(google.views, 40);
    assert.strictEqual(google.repos, 2);

    assert.deepStrictEqual(g.channels.map(c => [c.channel, c.views, c.referrers]), [
      ['github', 40, 1],
      ['search', 40, 1],
      ['social', 10, 1],
      ['ai-assistant', 5, 1],
      ['other', 5, 1],
    ]);
    assert.strictEqual(g.channels.find(c => c.channel === 'search').sharePct, 40);
    assert.strictEqual(g.referrers[0].referrer, 'Google', 'ties sort by name');
  } finally {
    db.close();
  }
});

test('the PyPI split uses the newest snapshot and shares cover attributed downloads only', () => {
  const db = fixtureDb();
  try {
    const { pythonVersions: pv, operatingSystems: os } = computeReach(db).pypiPlatforms;
    assert.strictEqual(pv.asOf, '2026-06-14');
    assert.strictEqual(pv.packages, 2);
    assert.strictEqual(pv.downloads, 100);
    assert.strictEqual(pv.unattributed, null, 'the collector does not store it, so it is not reported as 0');
    assert.strictEqual(pv.attributedPct, null);
    assert.deepStrictEqual(pv.items, [
      { version: '3.12', downloads: 75, packages: 2, sharePct: 75 },
      { version: '3.11', downloads: 25, packages: 1, sharePct: 25 },
    ]);

    assert.strictEqual(os.downloads, 100);
    assert.strictEqual(os.unattributed, 100, '"null" and "unknown" buckets');
    assert.strictEqual(os.attributedPct, 50);
    assert.deepStrictEqual(os.items, [
      { os: 'Linux', downloads: 75, packages: 2, sharePct: 75 },
      { os: 'Darwin', downloads: 25, packages: 1, sharePct: 25 },
    ]);
  } finally {
    db.close();
  }
});

test('absent tables give a null asOf and empty lists, never invented values', () => {
  const db = new Database(':memory:');
  try {
    const r = computeReach(db);
    assert.strictEqual(r.githubReferrers.asOf, null);
    assert.strictEqual(r.githubReferrers.views, 0);
    assert.deepStrictEqual(r.githubReferrers.channels, []);
    assert.deepStrictEqual(r.githubReferrers.referrers, []);
    assert.strictEqual(r.pypiPlatforms.pythonVersions.asOf, null);
    assert.deepStrictEqual(r.pypiPlatforms.pythonVersions.items, []);
    assert.strictEqual(r.pypiPlatforms.operatingSystems.attributedPct, null);
    assert.deepStrictEqual(r.pypiPlatforms.operatingSystems.items, []);
  } finally {
    db.close();
  }
});

test('summary.json and the overview API publish the same reach block (committed database)', () => {
  const db = new Database(DB_PATH, { readonly: true });
  let summary, overview;
  try {
    summary = buildSummary(db, { env: {} });
    overview = computeOverview(db, {});
  } finally {
    db.close();
  }
  assert.ok(summary.reach && overview.reach, 'both surfaces carry reach');
  assert.deepStrictEqual(summary.reach, overview.reach);

  const g = summary.reach.githubReferrers;
  assert.ok(g.asOf && g.repos > 0 && g.referrers.length > 0, 'referrer window present');
  assert.strictEqual(g.channels.reduce((s, c) => s + c.views, 0), g.views, 'channels partition the referrer views');
  assert.strictEqual(g.referrers.reduce((s, r) => s + r.views, 0), g.views);
  for (const r of g.referrers) assert.strictEqual(r.sharePct, sharePct(r.views, g.views));

  for (const key of ['pythonVersions', 'operatingSystems']) {
    const b = summary.reach.pypiPlatforms[key];
    assert.ok(b.asOf && b.packages > 0 && b.items.length > 0, `${key} snapshot present`);
    assert.strictEqual(b.items.reduce((s, i) => s + i.downloads, 0), b.downloads);
    assert.ok(!b.items.some(i => ['null', 'unknown', ''].includes(String(i.version ?? i.os).toLowerCase())), `${key} lists attributed categories only`);
  }
});
