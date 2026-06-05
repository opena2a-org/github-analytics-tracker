const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { computeWindowedStats, computeStarGrowth } = require('../lib/windowing');

function seedDownloads(rows) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE npm_downloads (id INTEGER PRIMARY KEY, package_id INTEGER, date TEXT, downloads INTEGER)');
  const ins = db.prepare('INSERT INTO npm_downloads (package_id, date, downloads) VALUES (?, ?, ?)');
  for (const [pkgId, date, dl] of rows) ins.run(pkgId, date, dl);
  return db;
}

function seedStars(rows) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE stargazers (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, total_stars INTEGER)');
  const ins = db.prepare('INSERT INTO stargazers (repo_id, date, total_stars) VALUES (?, ?, ?)');
  for (const [repoId, date, stars] of rows) ins.run(repoId, date, stars);
  return db;
}

test('npm 24h window ignores the trailing not-yet-finalized zero day', () => {
  // npm's downloads API reports 0 for the most recent day until it finalizes.
  // The anchor must skip that day so "Today" reflects the last real measurement.
  const db = seedDownloads([
    [1, '2026-06-01', 707],
    [1, '2026-06-02', 3306],
    [1, '2026-06-03', 883],
    [1, '2026-06-04', 0], // collected but npm hasn't finalized it yet
  ]);
  const s = computeWindowedStats(db, 'npm_downloads', 'package_id', 1, {});
  assert.strictEqual(s.last24hDownloads, 883, 'anchors to 2026-06-03 (last day with data), not the zero day');
  assert.strictEqual(s.allTimeDownloads, 4896);
});

test('a genuine zero anchor day is preserved when there is real same-day data elsewhere', () => {
  // If ANY package had downloads on the latest day, that day is real: keep it.
  const db = seedDownloads([
    [1, '2026-06-04', 0],   // this package: 0 today
    [2, '2026-06-04', 50],  // another package: real data today
    [1, '2026-06-03', 100],
  ]);
  const s = computeWindowedStats(db, 'npm_downloads', 'package_id', 1, {});
  assert.strictEqual(s.last24hDownloads, 0, 'package 1 legitimately had 0 on a day that is otherwise real');
});

test('star growth reports the count gained within each window', () => {
  const db = seedStars([
    [1, '2026-05-01', 100],
    [1, '2026-05-28', 110], // anchor - 7d boundary region
    [1, '2026-06-03', 118],
    [1, '2026-06-04', 120], // anchor (latest)
  ]);
  const g = computeStarGrowth(db, 1, {});
  assert.strictEqual(g.stars, 120);
  assert.strictEqual(g.starsGrowth24h, 2, '120 - 118 (yesterday)');
  assert.strictEqual(g.starsGrowth30d, 20, '120 - 100 (>=30d ago)');
  assert.strictEqual(g.starsGrowthAll, 20, '120 - earliest 100');
  assert.ok(g.starsGrowth7d >= 2 && g.starsGrowth7d <= 20, '7d growth between daily and all-time');
});

test('star growth falls back to full count when no older snapshot exists', () => {
  const db = seedStars([[1, '2026-06-04', 7]]); // repo first seen inside the window
  const g = computeStarGrowth(db, 1, {});
  assert.strictEqual(g.stars, 7);
  assert.strictEqual(g.starsGrowth30d, 7, 'no snapshot 30d ago -> growth is the full current count');
});
