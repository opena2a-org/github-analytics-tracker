const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Database = require('better-sqlite3');
const {
  computeMomentum, seriesMomentum, dailySeries, snapshotSeries,
  growthPct, cagrPct, addDays, REASON,
} = require('../lib/momentum');
const { buildSummary } = require('../lib/summary');
const { computeOverview } = require('../lib/overview');

const DB_PATH = path.join(__dirname, '..', 'data', 'analytics.db');

// A daily series of `days` days ending at `end`, value from fn(i) with i = 0 the
// oldest day. Returned as the raw [{date, value}] rows dailySeries() consumes.
function days(end, n, fn) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ date: addDays(end, -(n - 1 - i)), value: fn(i) });
  return rows;
}

test('growthPct and cagrPct are plain arithmetic with null for the unmeasurable cases', () => {
  assert.strictEqual(growthPct(150, 100), 50);
  assert.strictEqual(growthPct(80, 100), -20);
  assert.strictEqual(growthPct(100, 100), 0);
  assert.strictEqual(growthPct(5, 0), null, 'no previous volume: not Infinity, not 100%');
  assert.strictEqual(cagrPct(100, 400, 2), 100, 'doubling each year for two years');
  assert.strictEqual(cagrPct(100, 100, 3), 0);
  assert.strictEqual(cagrPct(0, 100, 1), null);
  assert.strictEqual(cagrPct(100, 200, 0), null);
});

test('week-over-week compares the 7 days at the anchor with the 7 before them', () => {
  // 14 days: the older week 100/day, the newer week 120/day.
  const s = dailySeries(days('2026-06-14', 14, i => (i < 7 ? 100 : 120)));
  const m = seriesMomentum(s, { table: 't', column: 'v' });
  assert.strictEqual(m.anchor, '2026-06-14');
  assert.deepStrictEqual(m.wow.window, {
    current: { start: '2026-06-08', end: '2026-06-14' },
    previous: { start: '2026-06-01', end: '2026-06-07' },
  });
  assert.strictEqual(m.wow.current, 840);
  assert.strictEqual(m.wow.previous, 700);
  assert.strictEqual(m.wow.growthPct, 20);
  assert.strictEqual(m.wow.reason, undefined);
});

test('a collection lag never manufactures a phantom negative week', () => {
  // Steady 100/day, but the last two days were not collected (npm reports 0
  // until it finalizes a day). Anchoring at "today" would make the trailing
  // week 5 days long and report a 29% drop; anchoring at the last real day
  // reports the truth: flat.
  const rows = days('2026-06-14', 21, i => (i >= 19 ? 0 : 100));
  const m = seriesMomentum(dailySeries(rows), { table: 't', column: 'v' });
  assert.strictEqual(m.anchor, '2026-06-12', 'anchor skips the trailing zero days');
  assert.strictEqual(m.wow.current, 700);
  assert.strictEqual(m.wow.previous, 700);
  assert.strictEqual(m.wow.growthPct, 0);
});

test('a window the series does not fully cover is null with a reason, never a partial comparison', () => {
  // 10 days of data: the current week is measurable, the previous week only
  // 3 days of it exist. Comparing 7 days with 3 would be a 133% "growth".
  const m = seriesMomentum(dailySeries(days('2026-06-14', 10, () => 100)), { table: 't', column: 'v' });
  assert.strictEqual(m.wow.current, 700);
  assert.strictEqual(m.wow.previous, null);
  assert.strictEqual(m.wow.growthPct, null);
  assert.strictEqual(m.wow.reason, REASON.coverage);
  assert.strictEqual(m.mom.growthPct, null);
  assert.strictEqual(m.qoq.growthPct, null);
  assert.strictEqual(m.acceleration.direction, null);
});

test('previous window of zero is null with a reason', () => {
  const m = seriesMomentum(dailySeries(days('2026-06-14', 14, i => (i < 7 ? 0 : 50))), { table: 't', column: 'v' });
  assert.strictEqual(m.wow.previous, 0);
  assert.strictEqual(m.wow.growthPct, null);
  assert.strictEqual(m.wow.reason, REASON.zeroPrevious);
});

test('acceleration compares this week\'s growth rate with last week\'s', () => {
  // Weeks of 100, 110, 132 per day: last week grew 10%, this week 20%.
  const rows = days('2026-06-21', 21, i => (i < 7 ? 100 : i < 14 ? 110 : 132));
  const m = seriesMomentum(dailySeries(rows), { table: 't', column: 'v' });
  assert.strictEqual(m.acceleration.currentWowPct, 20);
  assert.strictEqual(m.acceleration.priorWowPct, 10);
  assert.strictEqual(m.acceleration.deltaPoints, 10);
  assert.strictEqual(m.acceleration.direction, 'rising');

  const slowing = days('2026-06-21', 21, i => (i < 7 ? 100 : i < 14 ? 130 : 143));
  const m2 = seriesMomentum(dailySeries(slowing), { table: 't', column: 'v' });
  assert.strictEqual(m2.acceleration.direction, 'falling', '30% then 10%');
});

test('CAGR needs a year between the first complete window and the current one', () => {
  // 200 days: too short to annualise.
  const short = seriesMomentum(dailySeries(days('2026-06-14', 200, () => 10)), { table: 't', column: 'v' });
  assert.strictEqual(short.cagr.pct, null);
  assert.strictEqual(short.cagr.reason, REASON.shortSpan);
  assert.ok(short.cagr.years < 1);

  // 400 days: first 30 days 10/day, last 30 days 40/day, exactly 370 days apart.
  const long = seriesMomentum(dailySeries(days('2026-06-14', 400, i => (i < 30 ? 10 : i >= 370 ? 40 : 20))), { table: 't', column: 'v' });
  assert.strictEqual(long.cagr.basis, 'trailing-30-day volume');
  assert.strictEqual(long.cagr.from.value, 300);
  assert.strictEqual(long.cagr.to.value, 1200);
  assert.strictEqual(long.cagr.years, 1.01);
  assert.strictEqual(long.cagr.pct, cagrPct(300, 1200, 1.01));
  assert.ok(long.cagr.pct > 290 && long.cagr.pct < 300, `${long.cagr.pct}`);
});

test('CAGR starts at the first day with volume, not at the first collected zero row', () => {
  // 400 days: a year of zero rows (collected before the package existed),
  // then real volume. Nothing happened in the zero year, so there is no
  // year-long span of activity to annualise.
  const rows = days('2026-06-14', 400, i => (i < 365 ? 0 : 10));
  const m = seriesMomentum(dailySeries(rows), { table: 't', column: 'v' });
  assert.strictEqual(m.first, addDays('2026-06-14', -399));
  assert.strictEqual(m.firstActive, addDays('2026-06-14', -34));
  assert.strictEqual(m.cagr.from.start, m.firstActive);
  assert.strictEqual(m.cagr.pct, null);
  assert.strictEqual(m.cagr.reason, REASON.shortSpan);
});

test('cumulative snapshots measure the count gained in each window', () => {
  // Two images, daily snapshots over 15 days. Image 1 gains 10/day, image 2
  // gains 5/day then 15/day in the last week.
  const rows = [];
  for (let i = 0; i < 15; i++) {
    const date = addDays('2026-06-15', -(14 - i));
    rows.push({ entity: 1, date, value: 1000 + 10 * i });
    rows.push({ entity: 2, date, value: i < 8 ? 500 + 5 * i : 535 + 15 * (i - 7) });
  }
  const s = snapshotSeries(rows);
  const m = seriesMomentum(s, { table: 'docker_pulls', column: 'pull_count' });
  assert.strictEqual(m.kind, 'cumulative-snapshot');
  assert.strictEqual(m.anchor, '2026-06-15');
  assert.strictEqual(m.wow.current, 70 + 105, 'image 1: 7 days of 10; image 2: 7 days of 15');
  assert.strictEqual(m.wow.previous, 70 + 35);
  assert.strictEqual(m.wow.growthPct, growthPct(175, 105));
  assert.strictEqual(m.mom.growthPct, null, 'only 15 days of snapshots');
  assert.strictEqual(m.mom.reason, REASON.coverage);
});

test('an entity first seen inside the window carries its existing total in; only later gains are growth', () => {
  const rows = [
    { entity: 1, date: '2026-06-01', value: 100 },
    { entity: 1, date: '2026-06-15', value: 100 },
    { entity: 2, date: '2026-06-12', value: 40 }, // new image, appeared this week
    { entity: 2, date: '2026-06-15', value: 43 }, // and gained 3 since
  ];
  const s = snapshotSeries(rows);
  assert.strictEqual(s.valueAt('2026-06-08'), 100);
  assert.strictEqual(s.valueAt('2026-06-15'), 143, 'the running total still includes the new image');
  assert.strictEqual(s.windowTotal('2026-06-09', '2026-06-15'), 3, 'not 43: the 40 predate collection');
  assert.strictEqual(s.windowCarriedIn('2026-06-09', '2026-06-15'), 40);
  assert.strictEqual(s.windowCarriedIn('2026-06-02', '2026-06-08'), 0);
});

test('onboarding a repository does not inflate the published growth figure', () => {
  // Repo 1 gains one star a day throughout. Repo 2 already has 50 stars when
  // it is first collected in the previous week, then gains nothing. Counting
  // the 50 as growth would publish previous 57 and a fake 87.72% drop.
  const rows = [{ entity: 1, date: '2026-05-31', value: 19 }];
  for (let i = 0; i < 14; i++) rows.push({ entity: 1, date: addDays('2026-06-14', -(13 - i)), value: 20 + i });
  for (let i = 3; i < 14; i++) rows.push({ entity: 2, date: addDays('2026-06-14', -(13 - i)), value: 50 });
  const m = seriesMomentum(snapshotSeries(rows), { table: 'stargazers', column: 'total_stars' });
  assert.strictEqual(m.wow.current, 7);
  assert.strictEqual(m.wow.previous, 7);
  assert.strictEqual(m.wow.growthPct, 0);
  assert.deepStrictEqual(m.wow.carriedIn, { current: 0, previous: 50 });
  // Daily-row series have no carried-in notion.
  const d = seriesMomentum(dailySeries(days('2026-06-14', 14, () => 100)), { table: 't', column: 'v' });
  assert.strictEqual('carriedIn' in d.wow, false);
});

test('star momentum agrees with the community star trend on what was carried in (committed database)', () => {
  const db = new Database(DB_PATH, { readonly: true });
  let summary;
  try {
    summary = buildSummary(db, { env: {} });
  } finally {
    db.close();
  }
  const stars = summary.momentum.sources.stars;
  // Recompute each window from the stargazers table directly: the canonical
  // rows' gain after their first snapshot, and the first-snapshot values apart.
  const db2 = new Database(DB_PATH, { readonly: true });
  try {
    const { groupByCanonical, pickCanonical } = require('../lib/repos');
    const repos = db2.prepare('SELECT id, full_name, canonical_full_name FROM repositories').all();
    const lists = [];
    for (const [canon, group] of groupByCanonical(repos)) {
      const list = db2.prepare('SELECT date, total_stars AS value FROM stargazers WHERE repo_id = ? ORDER BY date')
        .all(pickCanonical(group, canon).id);
      if (list.length) lists.push(list);
    }
    const at = (list, date) => { let v; for (const s of list) { if (s.date > date) break; v = s.value || 0; } return v; };
    const measure = (w) => {
      let gained = 0, carriedIn = 0;
      for (const list of lists) {
        const atEnd = at(list, w.end);
        if (atEnd === undefined) continue;
        const atStart = at(list, addDays(w.start, -1));
        if (atStart === undefined) { carriedIn += list[0].value || 0; gained += atEnd - (list[0].value || 0); }
        else gained += atEnd - atStart;
      }
      return { gained, carriedIn };
    };
    for (const key of ['wow', 'mom', 'qoq']) {
      const g = stars[key];
      assert.ok(g.carriedIn, `stars.${key} reports carriedIn`);
      const cur = measure(g.window.current);
      assert.strictEqual(g.current, cur.gained, `stars.${key}.current`);
      assert.strictEqual(g.carriedIn.current, cur.carriedIn, `stars.${key}.carriedIn.current`);
      if (g.previous !== null) {
        const prev = measure(g.window.previous);
        assert.strictEqual(g.previous, prev.gained, `stars.${key}.previous`);
        assert.strictEqual(g.carriedIn.previous, prev.carriedIn, `stars.${key}.carriedIn.previous`);
      }
    }
  } finally {
    db2.close();
  }
});

test('a snapshot series whose first reading is the previous window\'s first day is not measurable', () => {
  // 14 daily readings: the total as of the day before the previous window is
  // unknown, so the previous window would wrongly absorb the whole running
  // total (26 here) and report a fake 73% drop.
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ entity: 1, date: addDays('2026-06-14', -(13 - i)), value: 20 + i });
  const m = seriesMomentum(snapshotSeries(rows), { table: 'stargazers', column: 'total_stars' });
  assert.strictEqual(m.wow.previous, null);
  assert.strictEqual(m.wow.growthPct, null);
  assert.strictEqual(m.wow.reason, REASON.coverage);
  // One reading earlier and it is measurable.
  rows.push({ entity: 1, date: '2026-05-31', value: 19 });
  const m2 = seriesMomentum(snapshotSeries(rows), { table: 'stargazers', column: 'total_stars' });
  assert.strictEqual(m2.wow.previous, 7);
  assert.strictEqual(m2.wow.current, 7);
  assert.strictEqual(m2.wow.growthPct, 0);
});

test('an empty series reports no data everywhere', () => {
  const m = seriesMomentum(dailySeries([]), { table: 't', column: 'v' });
  assert.strictEqual(m.anchor, null);
  assert.strictEqual(m.wow.growthPct, null);
  assert.strictEqual(m.wow.reason, REASON.noData);
  assert.strictEqual(m.cagr.pct, null);
});

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, owner TEXT, repo TEXT, full_name TEXT, canonical_full_name TEXT, archived INTEGER DEFAULT 0);
    CREATE TABLE traffic_clones (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, count INTEGER, uniques INTEGER);
    CREATE TABLE npm_downloads (id INTEGER PRIMARY KEY, package_id INTEGER, date TEXT, downloads INTEGER);
    CREATE TABLE pypi_downloads (id INTEGER PRIMARY KEY, package_id INTEGER, date TEXT, downloads INTEGER);
    CREATE TABLE docker_pulls (id INTEGER PRIMARY KEY, image_id INTEGER, date TEXT, pull_count INTEGER);
    CREATE TABLE stargazers (id INTEGER PRIMARY KEY, repo_id INTEGER, date TEXT, total_stars INTEGER);
  `);
  // A transferred repo: old slug (id 1) and canonical (id 2) both report the
  // same days during the overlap; they must count once.
  db.prepare("INSERT INTO repositories VALUES (1,'old','r','old/r','new/r',0)").run();
  db.prepare("INSERT INTO repositories VALUES (2,'new','r','new/r','new/r',0)").run();
  const clone = db.prepare('INSERT INTO traffic_clones (repo_id, date, count, uniques) VALUES (?,?,?,?)');
  const npm = db.prepare('INSERT INTO npm_downloads (package_id, date, downloads) VALUES (?,?,?)');
  const star = db.prepare('INSERT INTO stargazers (repo_id, date, total_stars) VALUES (?,?,?)');
  // Snapshots need a reading from the day before the previous window starts.
  star.run(1, '2026-05-31', 5);
  star.run(2, '2026-05-31', 19);
  for (let i = 0; i < 14; i++) {
    const date = addDays('2026-06-14', -(13 - i));
    clone.run(1, date, 10, 2);
    clone.run(2, date, 10, 2); // twin reports the identical day
    npm.run(1, date, i < 7 ? 100 : 150);
    star.run(1, date, 5);      // stale twin's frozen count
    star.run(2, date, 20 + i); // live repo
  }
  return db;
}

test('clones and stars are collapsed per canonical repo, never summed across twins', () => {
  const db = fixtureDb();
  try {
    const m = computeMomentum(db);
    assert.strictEqual(m.sources.clones.wow.current, 70, '7 days x 10, counted once');
    assert.strictEqual(m.sources.clones.wow.previous, 70);
    assert.strictEqual(m.sources.clones.wow.growthPct, 0);
    assert.strictEqual(m.sources.stars.wow.current, 7, '33 - 26 on the live row; the stale 5 is dropped');
    assert.strictEqual(m.sources.stars.wow.previous, 7);
  } finally {
    db.close();
  }
});

test('combined downloads sums only the sources measurable in that window and names the rest', () => {
  const db = fixtureDb();
  try {
    const m = computeMomentum(db);
    const wow = m.downloads.wow;
    assert.deepStrictEqual(Object.keys(wow.components).sort(), ['clones', 'npm']);
    assert.strictEqual(wow.current, 1050 + 70);
    assert.strictEqual(wow.previous, 700 + 70);
    assert.strictEqual(wow.growthPct, growthPct(1120, 770));
    assert.strictEqual(wow.excluded.pypi, REASON.noData, 'empty table');
    assert.strictEqual(wow.excluded.docker, REASON.noData);
    assert.strictEqual(wow.excluded.huggingface, REASON.noData, 'table absent');
    assert.strictEqual(m.downloads.mom.growthPct, null, 'fixture is 14 days long');
    assert.strictEqual(m.snapshot.direction, 'rising');
    assert.strictEqual(m.snapshot.sources.npm.direction, 'rising');
    assert.strictEqual(m.snapshot.sources.clones.direction, 'flat');
    assert.strictEqual(m.asOf, '2026-06-14');
    assert.ok(typeof m.method === 'string' && m.method.length > 0);
  } finally {
    db.close();
  }
});

test('summary.json and the overview API publish the same momentum block (committed database)', () => {
  const db = new Database(DB_PATH, { readonly: true });
  let summary, overview;
  try {
    summary = buildSummary(db, { env: {} });
    overview = computeOverview(db, {});
  } finally {
    db.close();
  }
  assert.ok(summary.momentum && overview.momentum, 'both surfaces carry momentum');
  assert.deepStrictEqual(summary.momentum, overview.momentum);
  for (const name of ['npm', 'pypi', 'clones', 'docker', 'huggingface', 'stars']) {
    const s = summary.momentum.sources[name];
    assert.ok(s.anchor, `${name} has an anchor`);
    for (const key of ['wow', 'mom', 'qoq']) {
      const g = s[key];
      assert.ok(g.window.current.end === s.anchor, `${name}.${key} window ends at the anchor`);
      if (g.growthPct !== null) {
        assert.strictEqual(g.growthPct, growthPct(g.current, g.previous), `${name}.${key} recomputes from its own totals`);
      } else {
        assert.ok(g.reason, `${name}.${key} null carries a reason`);
      }
    }
    if (s.cagr.pct === null) assert.ok(s.cagr.reason, `${name}.cagr null carries a reason`);
  }
});
