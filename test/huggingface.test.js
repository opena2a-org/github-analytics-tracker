const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');
const { buildSummary } = require('../lib/summary');
const { computeOverview } = require('../lib/overview');
const {
  huggingfaceStatsDdl, HF_STATS_INDEXES, migrateHuggingfaceStats, huggingfaceDownloads,
  huggingfaceModelList, huggingfaceModelDetail, sumMeasured, formatMeasured, NOT_MEASURED,
  parseModelDetailQuery, huggingfaceDownloadsByPeriod, measuredTooltipPayload,
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
    assert.strictEqual(empty.totals.hf.downloadsAllTime, null);
    assert.strictEqual(empty.totals.hf.downloads30d, null);
    assert.strictEqual(empty.totals.hf.likes, null);
    assert.strictEqual(huggingfaceModelDetail(db, -1, '0000-00-00'), null, 'an unknown model is not found');
  } finally {
    db.close();
  }
});

// The channelData statement in the dashboard source, or null without one: from
// `const channelData = [` through the line that closes the array at the
// statement's own indentation, so a `;` in a comment inside it does not end it.
function channelDataStatement(source) {
  const start = source.indexOf('const channelData = [');
  if (start < 0) return null;
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
  const close = source.indexOf(`\n${indent}]`, start);
  if (close < 0) return null;
  const end = source.indexOf('\n', close + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

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
    assert.strictEqual(overview.totals.hf.downloadsAllTime, null, 'the all-time total is null, never 0');
    assert.strictEqual(formatMeasured(overview.totals.hf.downloadsAllTime), NOT_MEASURED);
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

  // The adoption table footer sums the measured counts and shows a null total
  // as not measured. Its other cells use fmtFull and `|| 0`, so only the
  // Hugging Face cell is checked.
  const adoptionStart = index.indexOf('function AdoptionTable(');
  assert.ok(adoptionStart >= 0, 'the dashboard has an AdoptionTable');
  const adoption = index.slice(adoptionStart);
  const adoptionBody = adoption.slice(0, adoption.indexOf('\n/* ====='));
  assert.match(adoptionBody, /const hfTotal = sumMeasured\(/, 'the footer Hugging Face total sums measured counts only');
  const hfCells = adoptionBody.split('\n').filter(line => line.includes('<td key="h"'));
  assert.strictEqual(hfCells.length, 1, 'the footer has one Hugging Face cell');
  assert.ok(hfCells[0].includes('formatMeasured(hfTotal)'), 'the footer Hugging Face total formats through formatMeasured');
  assert.ok(!/fmtFull\(|\|\| 0/.test(hfCells[0]), `the footer Hugging Face total is not shown as 0: ${hfCells[0].trim()}`);

  // The channel mix charts only values above 0, so an unmeasured count is left
  // out, not drawn as 0. The filter must close the channelData statement itself.
  const channelData = channelDataStatement(index);
  assert.ok(channelData, 'the overview builds the channel mix as channelData');
  assert.ok(channelData.includes("name: 'HF Models'"), 'the channel mix has a Hugging Face entry');
  index.split('\n').forEach((line, i) => {
    if (/totals\.hf\?\.(downloadsAllTime|downloads30d|likes) \|\| 0/.test(line)) {
      assert.ok(line.includes("name: 'HF Models'") && channelData.includes(line)
        && /\]\.filter\(d => d\.value > 0\);$/.test(channelData),
        `pages/index.js:${i + 1} shows an unmeasured Hugging Face count as 0: ${line.trim()}`);
    }
  });
  assert.ok(index.includes('<span className="v">{formatMeasured(v)}</span>'), 'overview source rows show a null count as not measured');
});

test('the channel-mix check reads the whole channelData statement when a comment inside it has a semicolon', () => {
  const index = readFileSync(join(__dirname, '..', 'pages', 'index.js'), 'utf8');
  const opening = 'const channelData = [\n';
  assert.ok(index.includes(opening), 'the overview builds the channel mix as channelData');
  for (const comment of ['// a; b', '// a;', '/* a;\n     b; */']) {
    const statement = channelDataStatement(index.replace(opening, `${opening}    ${comment}\n`));
    const label = JSON.stringify(comment);
    assert.ok(statement.includes(comment), `the statement keeps the comment ${label}`);
    assert.ok(statement.includes("name: 'HF Models'"), `the statement keeps the Hugging Face entry after ${label}`);
    assert.match(statement, /\]\.filter\(d => d\.value > 0\);$/, `the statement runs to its filter after ${label}`);
  }
  // Without the filter the statement ends at the bare `];`, so the check still fails.
  const unfiltered = channelDataStatement(index.replace('].filter(d => d.value > 0);', '];'));
  assert.ok(unfiltered.includes("name: 'HF Models'"), 'the unfiltered statement keeps the Hugging Face entry');
  assert.doesNotMatch(unfiltered, /\.filter\(/, 'the unfiltered statement has no filter to find');
});

test('one model\'s detail reads that model\'s last counts only, however many models are tracked', () => {
  const db = freshDb();
  try {
    const addModel = db.prepare("INSERT INTO huggingface_models (model_id, author) VALUES (?, 'org')");
    const addSnapshot = db.prepare(`
      INSERT INTO huggingface_stats (model_id, date, downloads_30d, downloads_all_time, likes, absent_reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const target = addModel.run('org/target').lastInsertRowid;
    addSnapshot.run(target, '2026-10-01', 5, 50, 2, null);
    addSnapshot.run(target, '2026-10-02', null, null, null, 'downloads absent from the API response');

    // Every statement the detail executes, by SQL text.
    const executed = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = prepare(sql);
      for (const method of ['get', 'all', 'run', 'iterate']) {
        const run = stmt[method].bind(stmt);
        stmt[method] = (...args) => { executed.push(sql); return run(...args); };
      }
      return stmt;
    };
    const detailExecutions = () => {
      executed.length = 0;
      const detail = huggingfaceModelDetail(db, target, '0000-00-00');
      return { detail, count: executed.length };
    };

    const alone = detailExecutions();
    for (let i = 0; i < 20; i++) {
      addSnapshot.run(addModel.run(`org/other-${i}`).lastInsertRowid, '2026-10-01', i, 100 + i, i, null);
    }
    const among = detailExecutions();
    assert.strictEqual(among.count, alone.count, 'the statement count does not grow with the number of models');
    assert.deepStrictEqual(among.detail, alone.detail);
    assert.deepStrictEqual(
      [among.detail.summary.downloadsAllTime, among.detail.summary.downloads30d, among.detail.summary.likes],
      [50, 5, 2], 'the last measured counts of the requested model');

    const list = huggingfaceModelList(db);
    assert.strictEqual(list.length, 21);
    assert.deepStrictEqual(
      list.filter(m => m.id === target).map(m => [m.downloadsAllTime, m.downloads30d, m.likes]),
      [[50, 5, 2]], 'the list reads the same last measured counts');
    assert.deepStrictEqual(list.find(m => m.name === 'org/other-7').downloadsAllTime, 107);
  } finally {
    db.close();
  }
});

test('the model list and one model\'s detail give every count as null on a database without huggingface_stats', () => {
  const db = committedCopy();
  try {
    db.exec('DROP TABLE huggingface_stats');
    const list = huggingfaceModelList(db);
    assert.ok(list.length > 0, 'the committed database has Hugging Face models');
    for (const m of list) {
      assert.deepStrictEqual([m.downloadsAllTime, m.downloads30d, m.likes, m.last7Downloads],
        [null, null, null, null], m.name);
    }
    const detail = huggingfaceModelDetail(db, list[0].id, '0000-00-00');
    assert.deepStrictEqual(
      [detail.summary.downloadsAllTime, detail.summary.downloads30d, detail.summary.likes, detail.summary.periodDownloads],
      [null, null, null, null]);
    assert.deepStrictEqual(detail.series, []);
  } finally {
    db.close();
  }
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

// An API handler (pages/api/<name>.js), loaded as Next.js would serve it: its
// source rewritten from an ES module default export to a CommonJS one.
function loadApiHandler(name) {
  const Module = require('node:module');
  const file = join(__dirname, '..', 'pages', 'api', `${name}.js`);
  const source = readFileSync(file, 'utf8');
  const exportLine = 'export default function handler(';
  assert.ok(source.includes(exportLine), 'the handler is a default-exported function');
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(join(__dirname, '..', 'pages', 'api'));
  mod._compile(source.replace(exportLine, 'module.exports = function handler('), file);
  return mod.exports;
}

function callHandler(handler, query) {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handler({ query }, res);
  return res;
}

test('a model detail query gives the model id and the first date of its range', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  assert.deepStrictEqual(parseModelDetailQuery({ model_id: '3', days: '30' }, now), { modelId: 3, startDate: '2026-09-05' });
  assert.deepStrictEqual(parseModelDetailQuery({ model_id: '3' }, now), { modelId: 3, startDate: '2026-09-05' }, 'days defaults to 30');
  assert.deepStrictEqual(parseModelDetailQuery({ model_id: '3', days: '7' }, now), { modelId: 3, startDate: '2026-09-28' });
  const all = parseModelDetailQuery({ model_id: '3', days: 'all' }, now);
  assert.ok(all.startDate < '1970-01-01', 'days=all reaches before any snapshot');
  assert.deepStrictEqual(parseModelDetailQuery({ model_id: '3', days: '100000000000' }, now), all,
    'a range longer than all is all, not an invalid date');
});

test('a model_id that is not an integer, or a days that is neither all nor a positive integer, is an error naming it', () => {
  // A repeated parameter arrives as an array. A one-element array stringifies
  // to a valid value, so only the type check rejects it.
  for (const model_id of ['abc', '1.5', '1abc', '', ' 1', ['1', '2'], ['1']]) {
    assert.deepStrictEqual(parseModelDetailQuery({ model_id, days: '30' }), { error: 'model_id must be an integer' },
      `model_id ${JSON.stringify(model_id)}`);
  }
  for (const days of ['zzz', '0', '-5', '1.5', '7d', '', ['7', '30'], ['7']]) {
    assert.deepStrictEqual(parseModelDetailQuery({ model_id: '1', days }), { error: 'days must be "all" or a positive integer' },
      `days ${JSON.stringify(days)}`);
  }
});

test('/api/huggingface-stats answers a non-numeric model_id or days with 400, not 404 or 500', () => {
  const handler = loadApiHandler('huggingface-stats');
  const badDays = callHandler(handler, { model_id: '1', days: 'zzz' });
  assert.strictEqual(badDays.statusCode, 400);
  assert.match(badDays.body.error, /^days /);
  const negativeDays = callHandler(handler, { model_id: '1', days: '-5' });
  assert.strictEqual(negativeDays.statusCode, 400);
  const badModel = callHandler(handler, { model_id: 'abc' });
  assert.strictEqual(badModel.statusCode, 400);
  assert.match(badModel.body.error, /^model_id /);
});

// org/gap has a first measurement, a measured snapshot, an absent snapshot and
// a newest snapshot that measured only the all-time count; org/never has
// nothing measured. `day(n)` is the date n days back.
function gapFixture(db, day) {
  db.exec("INSERT INTO huggingface_models (id, model_id, author) VALUES (1, 'org/gap', 'org'), (2, 'org/never', 'org')");
  const ins = db.prepare(`
    INSERT INTO huggingface_stats (model_id, date, downloads_30d, downloads_all_time, likes, absent_reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  ins.run(1, day(10), 40, 900, 3, null);
  ins.run(1, day(2), 50, 1000, 4, null);
  ins.run(1, day(1), null, null, null, 'downloads absent from the API response; downloadsAllTime absent from the API response; likes absent from the API response');
  ins.run(1, day(0), null, 1100, null, 'downloads absent from the API response; likes absent from the API response');
  ins.run(2, day(0), null, null, null, 'HTTP 503');
}

const daysBefore = (today) => (n) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const WEEKLY = "date(date, 'weekday 0', '-6 days')"; // the bucket /api/trends uses

test('the install trend credits measured Hugging Face growth to its period and leaves an unmeasured period null, never 0', () => {
  const db = freshDb();
  try {
    const day = daysBefore('2026-10-06');
    gapFixture(db, day);
    const daily = huggingfaceDownloadsByPeriod(db, { bucketExpr: 'date', days: 'all' });
    assert.deepStrictEqual(daily.map(r => [r.period, r.hfDownloads]), [
      [day(10), null],
      [day(2), 100],
      [day(1), null],
      [day(0), 100],
    ], 'a first measurement and an absent snapshot measure no growth; a daily period is not 0 for holding one snapshot');
    assert.strictEqual(daily.reduce((s, r) => s + (r.hfDownloads ?? 0), 0), 200, 'growth across the gap is counted once');

    const weekly = huggingfaceDownloadsByPeriod(db, { bucketExpr: WEEKLY, days: 'all' });
    assert.deepStrictEqual(weekly.map(r => [r.period, r.hfDownloads]), [
      ['2026-09-21', null],
      ['2026-09-28', 100],
      ['2026-10-05', 100],
    ], 'growth since the previous week\'s measured count is credited to the newer week');

    db.exec('UPDATE huggingface_stats SET downloads_all_time = NULL');
    assert.ok(
      huggingfaceDownloadsByPeriod(db, { bucketExpr: 'date', days: 'all' }).every(r => r.hfDownloads === null),
      'nothing measured is null in every period'
    );
    db.exec('DROP TABLE huggingface_stats');
    assert.deepStrictEqual(huggingfaceDownloadsByPeriod(db, { bucketExpr: 'date', days: 'all' }), []);
  } finally {
    db.close();
  }
});

test('the install trend does not count a dip and recovery of a model\'s all-time count as new downloads', () => {
  const db = freshDb();
  try {
    db.exec("INSERT INTO huggingface_models (id, model_id, author) VALUES (1, 'org/dip', 'org')");
    const ins = db.prepare('INSERT INTO huggingface_stats (model_id, date, downloads_all_time) VALUES (1, ?, ?)');
    ins.run('2026-10-01', 1000);
    ins.run('2026-10-02', 900);
    ins.run('2026-10-03', 1000);
    ins.run('2026-10-04', 1100);
    const daily = huggingfaceDownloadsByPeriod(db, { bucketExpr: 'date', days: 'all' });
    assert.deepStrictEqual(daily.map(r => [r.period, r.hfDownloads]), [
      ['2026-10-01', null],
      ['2026-10-02', 0],
      ['2026-10-03', 0],
      ['2026-10-04', 100],
    ], 'a dip measures no growth, and its recovery adds nothing until the count passes its earlier high');
    assert.strictEqual(daily.reduce((s, r) => s + (r.hfDownloads ?? 0), 0), 100, 'the growth is the count\'s rise above its first high');
  } finally {
    db.close();
  }
});

test('the install trend lists Hugging Face periods in date order whatever order the models were measured in', () => {
  const db = freshDb();
  try {
    // The higher model id has the earlier dates, so model order is not date order.
    db.exec("INSERT INTO huggingface_models (id, model_id, author) VALUES (1, 'org/late', 'org'), (2, 'org/early', 'org')");
    const ins = db.prepare('INSERT INTO huggingface_stats (model_id, date, downloads_all_time) VALUES (?, ?, ?)');
    ins.run(1, '2026-10-02', 10);
    ins.run(1, '2026-10-03', 20);
    ins.run(2, '2026-10-01', 5);
    ins.run(2, '2026-10-02', 7);
    assert.deepStrictEqual(
      huggingfaceDownloadsByPeriod(db, { bucketExpr: 'date', days: 'all' }).map(r => [r.period, r.hfDownloads]),
      [['2026-10-01', null], ['2026-10-02', 2], ['2026-10-03', 10]]);
  } finally {
    db.close();
  }
});

// Today's date as SQLite's date('now') gives it: the clock /api/trends reads
// its window from.
function sqliteToday() {
  const db = new Database(':memory:');
  try {
    return db.prepare("SELECT date('now') AS d").get().d;
  } finally {
    db.close();
  }
}

// /api/trends daily over all time and over the last day, answered from the
// gap fixture dated back from `today`.
function trendsFromGapFixture(today) {
  return withTmp((dir) => {
    mkdirSync(join(dir, 'data'));
    const db = new Database(join(dir, 'data', 'analytics.db'));
    try {
      db.exec(`
        CREATE TABLE traffic_views (date TEXT, count INTEGER);
        CREATE TABLE traffic_clones (date TEXT, count INTEGER);
        CREATE TABLE repositories (id INTEGER PRIMARY KEY, full_name TEXT, canonical_full_name TEXT);
        CREATE TABLE stargazers (repo_id INTEGER, date TEXT, total_stars INTEGER);
      ` + HF_MODELS_DDL + huggingfaceStatsDdl('huggingface_stats') + HF_STATS_INDEXES);
      gapFixture(db, daysBefore(today));
    } finally {
      db.close();
    }

    // The route opens data/analytics.db under the working directory.
    const handler = loadApiHandler('trends');
    const before = process.cwd();
    process.chdir(dir);
    try {
      return {
        all: callHandler(handler, { granularity: 'daily', days: 'all' }),
        recent: callHandler(handler, { granularity: 'daily', days: '1' }),
      };
    } finally {
      process.chdir(before);
    }
  });
}

test('/api/trends plots an unmeasured Hugging Face period as null, never 0', () => {
  // The fixture is dated from the clock the route reads its window from. A run
  // that crosses midnight UTC between dating the fixture and calling the route
  // would see the window move by a day, so it is run again on the new date.
  let today;
  let responses;
  do {
    today = sqliteToday();
    responses = trendsFromGapFixture(today);
  } while (sqliteToday() !== today);
  const { all, recent } = responses;

  assert.strictEqual(all.statusCode, 200);
  assert.deepStrictEqual(all.body.series.map(r => r.hfDownloads), [null, 100, null, 100]);
  assert.deepStrictEqual(all.body.series.map(r => r.totalDownloads), [0, 100, 0, 100]);

  // The window's first period is measured against the last count before it.
  assert.strictEqual(recent.statusCode, 200);
  assert.deepStrictEqual(recent.body.series.map(r => r.hfDownloads), [null, 100]);
});

// The install trend's Tooltip rendered by recharts, as [name, value] per row.
function tooltipRows(props) {
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { Tooltip } = require('recharts');
  const html = renderToStaticMarkup(createElement(Tooltip, {
    active: true, coordinate: { x: 0, y: 0 }, viewBox: { x: 0, y: 0, width: 400, height: 300 }, ...props,
  }));
  return [...html.matchAll(/<li class="recharts-tooltip-item"[^>]*>(.*?)<\/li>/g)].map(([, item]) => [
    item.match(/recharts-tooltip-item-name">([^<]*)</)?.[1],
    item.match(/recharts-tooltip-item-value">([^<]*)</)?.[1],
  ]);
}

// Source with every whitespace character removed, so reformatting it (a line
// split, a wrapped prop) does not read as a change.
const squeeze = (source) => source.replace(/\s+/g, '');

// The squeezed function that starts at `head`, through the brace that closes
// its body; null when not found.
function functionSource(source, head) {
  const start = source.indexOf(head);
  const open = start < 0 ? -1 : source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

// The install trend's <Tooltip /> element and the MeasuredTooltipContent
// function in the dashboard source, each squeezed; null when not found.
function installTrendTooltipSource(index) {
  const source = squeeze(index);
  const start = source.indexOf('<Charttitle="InstallTrend"');
  const chart = start < 0 ? '' : source.slice(start, source.indexOf('</Chart>', start));
  return {
    tooltip: chart.match(/<Tooltip(?![\w.])[^]*?\/>/)?.[0] ?? null,
    component: functionSource(source, 'functionMeasuredTooltipContent('),
  };
}

// MeasuredTooltipContent, squeezed: the default rows with every prop and the
// payload rewritten by measuredTooltipPayload, set after the spread so it wins.
const MEASURED_TOOLTIP_CONTENT = /^functionMeasuredTooltipContent\(props\)\{return\(?<DefaultTooltipContent\{\.\.\.props\}payload=\{measuredTooltipPayload\(props\.payload\)\}\/>\)?;?\}$/;

test('the install trend tooltip shows an unmeasured Hugging Face period as not measured, never as an empty value', () => {
  const { createElement } = require('react');
  const { DefaultTooltipContent } = require('recharts');
  assert.deepStrictEqual(
    measuredTooltipPayload([{ value: null }, { value: undefined }, { value: 0 }, { value: 5 }]).map(e => e.value),
    [NOT_MEASURED, NOT_MEASURED, 0, 5], 'only a null row is given NOT_MEASURED; a measured 0 stays 0');
  assert.deepStrictEqual(measuredTooltipPayload(undefined), []);

  // A /api/trends period that measured no Hugging Face growth, and the rows
  // the chart passes to its Tooltip for it.
  const row = { periodStart: '2026-10-05', npmDownloads: 1200, pypiDownloads: 30, dockerPulls: 5, hfDownloads: null, totalDownloads: 1235 };
  const payload = [['npmDownloads', 'npm'], ['pypiDownloads', 'PyPI'], ['dockerPulls', 'Docker'], ['hfDownloads', 'HuggingFace'], ['totalDownloads', 'Total']]
    .map(([dataKey, name]) => ({ dataKey, name, value: row[dataKey], payload: row }));
  // The props the dashboard gives the install trend's Tooltip (checked against pages/index.js below).
  const trendTooltip = {
    label: row.periodStart, payload, filterNull: false,
    formatter: (v, name) => [formatMeasured(v), name],
    content: (props) => createElement(DefaultTooltipContent, { ...props, payload: measuredTooltipPayload(props.payload) }),
  };
  assert.deepStrictEqual(tooltipRows(trendTooltip), [
    ['npm', (1200).toLocaleString()], ['PyPI', '30'], ['Docker', '5'], ['HuggingFace', NOT_MEASURED], ['Total', (1235).toLocaleString()],
  ]);
  // Recharts calls a formatter only for a value that is not null: without the
  // content the row has an empty value, and without filterNull it is dropped.
  const { content, ...withoutContent } = trendTooltip;
  assert.deepStrictEqual(tooltipRows(withoutContent)[3], ['HuggingFace', ''], 'without the content the Hugging Face row is empty');
  const { filterNull, ...withoutFilterNull } = trendTooltip;
  assert.ok(!tooltipRows(withoutFilterNull).some(([name]) => name === 'HuggingFace'), 'without filterNull={false} the Hugging Face row is dropped');

  const index = readFileSync(join(__dirname, '..', 'pages', 'index.js'), 'utf8');
  const { tooltip, component } = installTrendTooltipSource(index);
  assert.ok(tooltip, 'the overview has an install trend with a tooltip');
  for (const prop of ['filterNull={false}', 'formatter={(v, name) => [formatMeasured(v), name]}', 'content={MeasuredTooltipContent}']) {
    assert.ok(tooltip.includes(squeeze(prop)), `the install trend tooltip has ${prop}`);
  }
  assert.match(component || '', MEASURED_TOOLTIP_CONTENT,
    'MeasuredTooltipContent gives a null row NOT_MEASURED before the default rows render');
});

test('the install trend tooltip source check reads through a reformat of the dashboard', () => {
  const index = readFileSync(join(__dirname, '..', 'pages', 'index.js'), 'utf8');
  const original = installTrendTooltipSource(index);
  assert.ok(original.tooltip && original.component, 'the dashboard has the install trend tooltip and its content');
  // Every space a line break, and every line joined to the next.
  for (const reformatted of [index.replace(/ /g, '\n'), index.replace(/\n\s*/g, ' ')]) {
    assert.notStrictEqual(reformatted, index);
    assert.deepStrictEqual(installTrendTooltipSource(reformatted), original);
  }

  const component = 'functionMeasuredTooltipContent(props){return<DefaultTooltipContent{...props}payload={measuredTooltipPayload(props.payload)}/>;}';
  assert.match(component, MEASURED_TOOLTIP_CONTENT);
  assert.match(component.replace('return<', 'return(<').replace('/>;}', '/>);}'), MEASURED_TOOLTIP_CONTENT, 'the JSX wrapped in parentheses');
  assert.match(component.replace('/>;}', '/>}'), MEASURED_TOOLTIP_CONTENT, 'without the semicolon');
  // The rewritten payload set before the spread, which then overrides it.
  assert.doesNotMatch(
    component.replace('{...props}payload={measuredTooltipPayload(props.payload)}', 'payload={measuredTooltipPayload(props.payload)}{...props}'),
    MEASURED_TOOLTIP_CONTENT);
});
