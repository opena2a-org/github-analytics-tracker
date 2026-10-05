const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');
const { buildSummary } = require('../lib/summary');
const { computeOverview } = require('../lib/overview');
const {
  huggingfaceStatsDdl, HF_STATS_INDEXES, migrateHuggingfaceStats, huggingfaceDownloads,
  huggingfaceModelList, huggingfaceModelDetail, sumMeasured, formatMeasured, NOT_MEASURED,
} = require('../lib/huggingface');
// Requiring the collector must not run it (no exit, no database, no network).
const { countsFor, recordModel, openDatabase } = require('../scripts/collect-huggingface-stats');

/*
 * A Hugging Face count the API does not return is absent, not a measured 0.
 * The collector used to store `downloads || 0`, so a response without a count
 * reached the published downloads total as 0. These tests stub such responses
 * and follow them through storage, the summary, momentum and the overview.
 */

const DB_PATH = join(__dirname, '..', 'data', 'analytics.db');

// Every collector step succeeded, so a series is `partial` only through a
// Hugging Face gap, never through a missing step outcome.
const ALL_COLLECTED = {
  COLLECTOR_OUTCOMES: JSON.stringify(Object.fromEntries(
    ['github', 'npm', 'pypi', 'docker', 'huggingface', 'chrome', 'telemetry'].map(n => [n, 'success'])
  )),
};

const HF_MODELS_DDL = `
  CREATE TABLE huggingface_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL,
    pipeline_tag TEXT, repo_type TEXT NOT NULL DEFAULT 'model', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(HF_MODELS_DDL + huggingfaceStatsDdl('huggingface_stats') + HF_STATS_INDEXES);
  return db;
}

// The committed database, copied into memory so a test can change it freely.
function committedCopy() {
  const src = new Database(DB_PATH, { readonly: true });
  try {
    return new Database(src.serialize());
  } finally {
    src.close();
  }
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hf-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a response without `downloads` gives a null count with a reason, never 0', () => {
  const c = countsFor({ id: 'org/model', downloadsAllTime: 120, likes: 0 });
  assert.strictEqual(c.downloads30d, null);
  assert.strictEqual(c.downloadsAllTime, 120);
  assert.strictEqual(c.likes, 0, 'a returned 0 is a measured zero and is kept');
  assert.match(c.absentReason, /^downloads absent from the API response$/);

  const bad = countsFor({ id: 'org/model', downloads: '7', downloadsAllTime: -1, likes: 1.5 });
  assert.deepStrictEqual([bad.downloads30d, bad.downloadsAllTime, bad.likes], [null, null, null]);
  assert.match(bad.absentReason, /downloads not a non-negative integer/);
  assert.match(bad.absentReason, /downloadsAllTime not a non-negative integer/);
  assert.match(bad.absentReason, /likes not a non-negative integer/);

  assert.strictEqual(countsFor({ id: 'org/model', downloads: 3, downloadsAllTime: 9, likes: 2 }).absentReason, null);
});

test('the collector stores an absent count as NULL with absent_reason and leaves the badge alone', () => {
  withTmp((dataDir) => {
    const db = freshDb();
    try {
      recordModel(db, { id: 'org/absent', likes: 4 }, { today: '2026-10-01', dataDir });
      const row = db.prepare(`
        SELECT downloads_30d, downloads_all_time, likes, absent_reason FROM huggingface_stats s
        JOIN huggingface_models m ON m.id = s.model_id WHERE m.model_id = 'org/absent'
      `).get();
      assert.strictEqual(row.downloads_30d, null, 'absent rolling count is NULL, not 0');
      assert.strictEqual(row.downloads_all_time, null, 'absent all-time count is NULL, not 0');
      assert.strictEqual(row.likes, 4);
      assert.strictEqual(row.absent_reason, 'downloads absent from the API response; downloadsAllTime absent from the API response');
      assert.ok(!existsSync(join(dataDir, 'hf-badge-org_absent.json')), 'no badge claiming 0 downloads');

      recordModel(db, { id: 'org/measured', downloads: 5, downloadsAllTime: 50, likes: 1 }, { today: '2026-10-01', dataDir });
      const ok = db.prepare(`
        SELECT downloads_30d, downloads_all_time, likes, absent_reason FROM huggingface_stats s
        JOIN huggingface_models m ON m.id = s.model_id WHERE m.model_id = 'org/measured'
      `).get();
      assert.deepStrictEqual({ ...ok }, { downloads_30d: 5, downloads_all_time: 50, likes: 1, absent_reason: null });
      assert.strictEqual(JSON.parse(readFileSync(join(dataDir, 'hf-badge-org_measured.json'), 'utf8')).message, '50');
    } finally {
      db.close();
    }
  });
});

test('the migration makes an existing NOT NULL table nullable and keeps every row', () => {
  const db = new Database(':memory:');
  try {
    db.exec(HF_MODELS_DDL + `
      CREATE TABLE huggingface_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL, date TEXT NOT NULL,
        downloads_30d INTEGER NOT NULL DEFAULT 0, downloads_all_time INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0, collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (model_id) REFERENCES huggingface_models(id), UNIQUE(model_id, date)
      );
      CREATE INDEX idx_hf_stats_model ON huggingface_stats(model_id);
      CREATE INDEX idx_hf_stats_date ON huggingface_stats(date);
      INSERT INTO huggingface_models (model_id, author) VALUES ('org/a', 'org');
      INSERT INTO huggingface_stats (model_id, date, downloads_30d, downloads_all_time, likes, collected_at)
        VALUES (1, '2026-09-01', 3, 30, 1, '2026-09-01 06:00:00'), (1, '2026-09-02', 4, 34, 1, '2026-09-02 06:00:00');
    `);
    const before = db.prepare('SELECT * FROM huggingface_stats ORDER BY id').all();
    assert.strictEqual(migrateHuggingfaceStats(db), true);
    const after = db.prepare('SELECT id, model_id, date, downloads_30d, downloads_all_time, likes, collected_at FROM huggingface_stats ORDER BY id').all();
    assert.deepStrictEqual(after, before, 'rows, ids and collection times are kept');
    const cols = db.prepare('PRAGMA table_info(huggingface_stats)').all();
    for (const name of ['downloads_30d', 'downloads_all_time', 'likes']) {
      assert.strictEqual(cols.find(c => c.name === name).notnull, 0, `${name} is nullable`);
    }
    assert.ok(cols.some(c => c.name === 'absent_reason'));
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='huggingface_stats'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_hf_stats_model') && indexes.includes('idx_hf_stats_date'));
    db.prepare("INSERT INTO huggingface_stats (model_id, date, absent_reason) VALUES (1, '2026-09-03', 'x')").run();
    assert.strictEqual(migrateHuggingfaceStats(db), false, 'a second run is a no-op');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM huggingface_stats').get().n, 3);
  } finally {
    db.close();
  }
});

test('the summary keeps the last measured value, with its date, when the newest snapshot is absent', () => {
  withTmp((dataDir) => {
    const db = committedCopy();
    try {
      migrateHuggingfaceStats(db);
      const base = buildSummary(db, { dataDir, env: ALL_COLLECTED });
      const baseOverview = computeOverview(db, {});
      assert.strictEqual(typeof base.total.hf, 'number');
      assert.ok(base.total.hf > 0, 'the committed database has measured Hugging Face downloads');
      for (const key of Object.keys(base.series)) assert.strictEqual(base.series[key].status, 'ok', `${key} is ok before the gap`);

      // One model's newest snapshot arrives without a count.
      const target = db.prepare(`
        SELECT s.model_id AS id, m.model_id AS name, MAX(s.date) AS last
        FROM huggingface_stats s JOIN huggingface_models m ON m.id = s.model_id
        GROUP BY s.model_id ORDER BY MAX(s.downloads_all_time) DESC LIMIT 1
      `).get();
      const absentDate = db.prepare("SELECT date(MAX(date), '+1 day') AS d FROM huggingface_stats").get().d;
      db.prepare(`
        INSERT INTO huggingface_stats (model_id, date, downloads_30d, downloads_all_time, likes, absent_reason)
        VALUES (?, ?, NULL, NULL, 2, 'downloads absent from the API response; downloadsAllTime absent from the API response')
      `).run(target.id, absentDate);

      const s = buildSummary(db, { dataDir, env: ALL_COLLECTED });
      assert.strictEqual(s.total.hf, base.total.hf, 'the absent snapshot does not lower the total');
      assert.strictEqual(s.total.downloads, base.total.downloads);
      assert.strictEqual(s.total.adoption, base.total.adoption);
      const w = s.series.downloads.window.huggingface;
      assert.strictEqual(w.asOf, base.series.downloads.window.huggingface.asOf, 'asOf stays on the newest measured date');
      assert.deepStrictEqual(w.gaps, [{
        model: target.name,
        reason: 'downloads absent from the API response; downloadsAllTime absent from the API response',
        newestSnapshot: absentDate,
        lastMeasured: target.last,
      }]);
      for (const key of Object.keys(s.series)) assert.strictEqual(s.series[key].status, 'partial', `${key} is partial through the gap`);
      assert.deepStrictEqual(s.momentum, base.momentum, 'momentum reads the absent snapshot as no data, not a drop to 0');

      const overview = computeOverview(db, {});
      for (const key of Object.keys(s.series)) {
        assert.strictEqual(overview.series[key].value, s.series[key].value, `overview ${key} agrees`);
      }
      assert.strictEqual(overview.totals.hf.downloadsAllTime, baseOverview.totals.hf.downloadsAllTime);
    } finally {
      db.close();
    }
  });
});

test('a model with no measured count, or no table at all, is a reported gap, never a total of 0', () => {
  withTmp((dataDir) => {
    const db = freshDb();
    try {
      recordModel(db, { id: 'org/new' }, { today: '2026-10-01', dataDir });
      const only = huggingfaceDownloads(db);
      assert.strictEqual(only.total, null, 'nothing measured is null, not 0');
      assert.strictEqual(only.asOf, null);
      assert.deepStrictEqual(only.models.map(m => m.downloadsAllTime), [null]);
      assert.strictEqual(only.gaps[0].model, 'org/new');
      assert.strictEqual(only.gaps[0].lastMeasured, null);

      recordModel(db, { id: 'org/old', downloads: 1, downloadsAllTime: 70, likes: 0 }, { today: '2026-10-01', dataDir });
      const mixed = huggingfaceDownloads(db);
      assert.strictEqual(mixed.total, 70, 'the measured model counts, the unmeasured one is left out');
      assert.deepStrictEqual(mixed.gaps.map(g => g.model), ['org/new']);
    } finally {
      db.close();
    }

    const copy = committedCopy();
    try {
      const base = buildSummary(copy, { dataDir, env: {} });
      copy.exec('DROP TABLE huggingface_stats');
      const s = buildSummary(copy, { dataDir, env: {} });
      assert.strictEqual(s.total.hf, null, 'a missing table is not a measured 0');
      assert.strictEqual(s.series.downloads.components.huggingface, null);
      assert.strictEqual(s.total.downloads, base.total.downloads - base.total.hf, 'left out of the sum, not added as 0');
      assert.deepStrictEqual(s.series.downloads.window.huggingface.gaps.map(g => g.reason), ['no huggingface_stats table in the database']);
      assert.strictEqual(s.series.downloads.status, 'partial');
    } finally {
      copy.close();
    }
  });
});

test('the API route and the overview keep each model\'s last measured counts, and give null when none is measured', () => {
  const db = committedCopy();
  try {
    migrateHuggingfaceStats(db);
    const target = db.prepare(`
      SELECT model_id AS id, MAX(date) AS last FROM huggingface_stats
      GROUP BY model_id ORDER BY MAX(downloads_all_time) DESC LIMIT 1
    `).get();
    const measured = db.prepare(`
      SELECT downloads_all_time AS downloadsAllTime, downloads_30d AS downloads30d, likes
      FROM huggingface_stats WHERE model_id = ? AND date = ?
    `).get(target.id, target.last);
    assert.ok(measured.downloadsAllTime > 0 && measured.downloads30d > 0 && measured.likes > 0,
      'the committed database has a model with non-zero counts');
    const baseEntry = huggingfaceModelList(db).find(m => m.id === target.id);
    const baseDetail = huggingfaceModelDetail(db, target.id, '0000-00-00');
    const baseOverview = computeOverview(db, {});
    assert.deepStrictEqual(
      { downloadsAllTime: baseEntry.downloadsAllTime, downloads30d: baseEntry.downloads30d, likes: baseEntry.likes },
      { ...measured });

    // The model's newest snapshot arrives with none of its counts.
    const absentDate = db.prepare("SELECT date(MAX(date), '+1 day') AS d FROM huggingface_stats").get().d;
    db.prepare(`
      INSERT INTO huggingface_stats (model_id, date, downloads_30d, downloads_all_time, likes, absent_reason)
      VALUES (?, ?, NULL, NULL, NULL, 'downloads absent from the API response')
    `).run(target.id, absentDate);

    const entry = huggingfaceModelList(db).find(m => m.id === target.id);
    assert.deepStrictEqual(entry, baseEntry, 'the list keeps the last measured counts, not 0');
    const detail = huggingfaceModelDetail(db, target.id, '0000-00-00');
    assert.deepStrictEqual(
      { ...detail.summary, daysTracked: null },
      { ...baseDetail.summary, daysTracked: null },
      'the summary keeps the last measured counts and the period growth');
    assert.strictEqual(detail.summary.daysTracked, baseDetail.summary.daysTracked + 1);
    const last = detail.series[detail.series.length - 1];
    assert.deepStrictEqual(last, { date: absentDate, downloadsAllTime: null, downloads30d: null, likes: null, dailyDownloads: null });

    const overview = computeOverview(db, {});
    assert.strictEqual(overview.totals.hf.downloads30d, baseOverview.totals.hf.downloads30d, '30-day total keeps the measured value');
    assert.strictEqual(overview.totals.hf.likes, baseOverview.totals.hf.likes, 'likes total keeps the measured value');
    assert.deepStrictEqual(overview.products.map(p => p.hf), baseOverview.products.map(p => p.hf));

    // Nothing measured at all: null, never 0.
    db.exec("UPDATE huggingface_stats SET downloads_30d = NULL, downloads_all_time = NULL, likes = NULL, absent_reason = 'x'");
    for (const m of huggingfaceModelList(db)) {
      assert.deepStrictEqual([m.downloadsAllTime, m.downloads30d, m.likes, m.last7Downloads], [null, null, null, null], m.name);
    }
    const none = huggingfaceModelDetail(db, target.id, '0000-00-00').summary;
    assert.deepStrictEqual([none.downloadsAllTime, none.downloads30d, none.likes, none.periodDownloads], [null, null, null, null]);
    const empty = computeOverview(db, {});
    assert.strictEqual(empty.totals.hf.downloads30d, null);
    assert.strictEqual(empty.totals.hf.likes, null);
    assert.strictEqual(huggingfaceModelDetail(db, -1, '0000-00-00'), null, 'an unknown model is not found');
  } finally {
    db.close();
  }
});

test('the dashboard shows a never-measured count as not measured, never 0, and totals only measured values', () => {
  assert.strictEqual(formatMeasured(null), NOT_MEASURED);
  assert.strictEqual(formatMeasured(undefined), NOT_MEASURED);
  assert.strictEqual(formatMeasured(0), '0', 'a measured zero is still shown as 0');
  assert.strictEqual(formatMeasured(1234567), (1234567).toLocaleString());

  const db = committedCopy();
  try {
    migrateHuggingfaceStats(db);
    db.exec('UPDATE huggingface_stats SET downloads_all_time = NULL, downloads_30d = NULL, likes = NULL');
    const models = huggingfaceModelList(db);
    assert.ok(models.length > 0, 'the committed database has Hugging Face models');
    // Per-model cells, footer totals and the overview figures, as the dashboard formats them.
    for (const m of models) {
      assert.deepStrictEqual([m.downloadsAllTime, m.downloads30d, m.likes].map(formatMeasured),
        [NOT_MEASURED, NOT_MEASURED, NOT_MEASURED], m.name);
    }
    for (const key of ['downloadsAllTime', 'downloads30d', 'likes']) {
      assert.strictEqual(formatMeasured(sumMeasured(models.map(m => m[key]))), NOT_MEASURED, `${key} total`);
    }
    const overview = computeOverview(db, {});
    assert.strictEqual(formatMeasured(overview.totals.hf.downloads30d), NOT_MEASURED);
    assert.strictEqual(formatMeasured(overview.totals.hf.likes), NOT_MEASURED);
  } finally {
    db.close();
  }
  // One measured model: the total is its value, the unmeasured ones add nothing.
  assert.strictEqual(formatMeasured(sumMeasured([null, 1200, undefined])), (1200).toLocaleString());

  // The dashboard renders those counts through formatMeasured, never through
  // fmtFull or `|| 0`, which turn null into 0.
  const index = readFileSync(join(__dirname, '..', 'pages', 'index.js'), 'utf8');
  const tab = index.slice(index.indexOf('function HuggingFaceTab('));
  const tabBody = tab.slice(0, tab.indexOf('\n/* ====='));
  assert.ok(tabBody.length > 0 && tabBody.includes('formatMeasured('), 'the Hugging Face tab formats through formatMeasured');
  assert.ok(!tabBody.includes('fmtFull('), 'the Hugging Face tab does not format a count with fmtFull');
  assert.ok(!tabBody.includes('|| 0'), 'the Hugging Face tab does not turn a null count into 0');
  index.split('\n').forEach((line, i) => {
    if (/totals\.hf\?\.(downloadsAllTime|downloads30d|likes) \|\| 0/.test(line)) {
      // The channel mix charts only values above 0, so an unmeasured count is left out, not drawn as 0.
      assert.ok(line.includes("name: 'HF Models'") && /\.filter\(d => d\.value > 0\)/.test(index),
        `pages/index.js:${i + 1} shows an unmeasured Hugging Face count as 0: ${line.trim()}`);
    }
  });
  assert.ok(index.includes('<span className="v">{formatMeasured(v)}</span>'), 'overview source rows show a null count as not measured');
});

test('the collector migrates a database created before the nullable schema before it writes', () => {
  withTmp((dir) => {
    const file = join(dir, 'analytics.db');
    copyFileSync(DB_PATH, file);
    const db = openDatabase(file);
    try {
      const cols = db.prepare('PRAGMA table_info(huggingface_stats)').all();
      assert.ok(cols.some(c => c.name === 'absent_reason'), 'absent_reason is added');
      const counts = recordModel(db, { id: 'org/after-migration', likes: 1 }, { today: '2026-10-01', dataDir: dir });
      assert.strictEqual(counts.downloadsAllTime, null);
      const row = db.prepare(`
        SELECT downloads_all_time, absent_reason FROM huggingface_stats s
        JOIN huggingface_models m ON m.id = s.model_id WHERE m.model_id = 'org/after-migration'
      `).get();
      assert.deepStrictEqual({ ...row }, {
        downloads_all_time: null,
        absent_reason: 'downloads absent from the API response; downloadsAllTime absent from the API response',
      });
    } finally {
      db.close();
    }
  });
});
