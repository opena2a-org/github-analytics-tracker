/**
 * Hugging Face storage, the all-time downloads figure the summary and the
 * overview publish, and the per-model counts the overview and
 * /api/huggingface-stats publish (each the last measured value, null when
 * never measured).
 *
 * The collector stores a count the API did not return as NULL with the reason
 * in absent_reason, never as 0 (scripts/collect-huggingface-stats.js). So each
 * model's all-time figure is its newest MEASURED snapshot, published with the
 * date it was measured on:
 *   - a model whose newest snapshot has no count keeps its last measured value
 *     under that value's own date, and is listed in `gaps`;
 *   - a model with no measured snapshot at all contributes nothing and is
 *     listed in `gaps`;
 *   - with no table, or no measured model, the total is null, never 0.
 */

// Counts are nullable: NULL is "the API did not return it", with the reason
// in absent_reason. A 0 written under this schema is a measured zero. A row
// written before it, when the counts were NOT NULL, stored an absent count as
// 0 too; migrateHuggingfaceStats keeps those rows as they were, so a 0 in
// one may be either, and cannot be told apart from a measured zero.
function huggingfaceStatsDdl(name) {
  return `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    downloads_30d INTEGER,
    downloads_all_time INTEGER,
    likes INTEGER,
    absent_reason TEXT,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (model_id) REFERENCES huggingface_models(id),
    UNIQUE(model_id, date)
  );
`;
}

const HF_STATS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_hf_stats_model ON huggingface_stats(model_id);
  CREATE INDEX IF NOT EXISTS idx_hf_stats_date ON huggingface_stats(date);
`;

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * Bring a pre-existing huggingface_stats table to the nullable schema.
 * SQLite cannot drop NOT NULL in place, so a table that still carries it (or
 * lacks absent_reason) is rebuilt with every row kept. Idempotent; returns
 * true when it rebuilt.
 */
function migrateHuggingfaceStats(db) {
  if (!tableExists(db, 'huggingface_stats')) return false;
  const cols = db.prepare('PRAGMA table_info(huggingface_stats)').all();
  const current = cols.some(c => c.name === 'absent_reason')
    && !cols.some(c => ['downloads_30d', 'downloads_all_time', 'likes'].includes(c.name) && c.notnull);
  if (current) return false;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS huggingface_stats_rebuild');
    db.exec(huggingfaceStatsDdl('huggingface_stats_rebuild'));
    db.exec(`
      INSERT INTO huggingface_stats_rebuild (id, model_id, date, downloads_30d, downloads_all_time, likes, collected_at)
      SELECT id, model_id, date, downloads_30d, downloads_all_time, likes, collected_at FROM huggingface_stats
    `);
    db.exec('DROP TABLE huggingface_stats');
    db.exec('ALTER TABLE huggingface_stats_rebuild RENAME TO huggingface_stats');
    db.exec(HF_STATS_INDEXES);
  })();
  return true;
}

/**
 * All-time downloads per model from huggingface_stats:
 *   total   sum of each model's last measured count, or null when none is measured
 *   first   oldest measured snapshot date (null when none)
 *   asOf    newest measured snapshot date (null when none)
 *   models  [{ id, model, downloadsAllTime, asOf }] — downloadsAllTime and asOf
 *           are the last measured value and its date, or null
 *   gaps    [{ model, reason, newestSnapshot, lastMeasured }] — every model whose
 *           newest snapshot is not a measured count, and the missing table
 */
function huggingfaceDownloads(db) {
  if (!tableExists(db, 'huggingface_stats')) {
    return {
      total: null, first: null, asOf: null, models: [],
      gaps: [{ model: null, reason: 'no huggingface_stats table in the database', newestSnapshot: null, lastMeasured: null }],
    };
  }
  const cols = db.prepare('PRAGMA table_info(huggingface_stats)').all().map(c => c.name);
  const reasonCol = cols.includes('absent_reason') ? 'absent_reason' : 'NULL';
  const nameOf = tableExists(db, 'huggingface_models')
    ? db.prepare('SELECT model_id FROM huggingface_models WHERE id = ?')
    : null;
  const measured = db.prepare(`
    SELECT date, downloads_all_time AS value FROM huggingface_stats
    WHERE model_id = ? AND downloads_all_time IS NOT NULL ORDER BY date DESC LIMIT 1
  `);
  const newest = db.prepare(`
    SELECT date, ${reasonCol} AS reason FROM huggingface_stats
    WHERE model_id = ? ORDER BY date DESC LIMIT 1
  `);

  const models = [];
  const gaps = [];
  for (const { id } of db.prepare('SELECT DISTINCT model_id AS id FROM huggingface_stats ORDER BY model_id').all()) {
    const model = (nameOf && nameOf.get(id)?.model_id) || String(id);
    const m = measured.get(id);
    const n = newest.get(id);
    models.push({ id, model, downloadsAllTime: m ? m.value : null, asOf: m ? m.date : null });
    if (!m || m.date !== n.date) {
      gaps.push({
        model,
        reason: n.reason || 'downloads_all_time not recorded',
        newestSnapshot: n.date,
        lastMeasured: m ? m.date : null,
      });
    }
  }

  const counted = models.filter(x => x.downloadsAllTime !== null);
  const range = db.prepare(
    'SELECT MIN(date) AS first, MAX(date) AS asOf FROM huggingface_stats WHERE downloads_all_time IS NOT NULL'
  ).get();
  return {
    total: counted.length ? counted.reduce((s, x) => s + x.downloadsAllTime, 0) : null,
    first: range.first || null,
    asOf: range.asOf || null,
    models,
    gaps,
  };
}

// Published count -> huggingface_stats column.
const HF_COUNTS = [
  ['downloadsAllTime', 'downloads_all_time'],
  ['downloads30d', 'downloads_30d'],
  ['likes', 'likes'],
];

const NOTHING_MEASURED = { downloadsAllTime: null, downloads30d: null, likes: null };

/**
 * The last measured value of each count, per model: Map(model row id ->
 * { downloadsAllTime, downloads30d, likes }), each the newest non-NULL value
 * of its column, or null when the model has none. Empty without the table.
 */
function huggingfaceLastMeasured(db) {
  const out = new Map();
  if (!tableExists(db, 'huggingface_stats')) return out;
  const newest = HF_COUNTS.map(([key, col]) => [key, db.prepare(`
    SELECT ${col} AS value FROM huggingface_stats
    WHERE model_id = ? AND ${col} IS NOT NULL ORDER BY date DESC LIMIT 1
  `)]);
  for (const { id } of db.prepare('SELECT DISTINCT model_id AS id FROM huggingface_stats').all()) {
    out.set(id, Object.fromEntries(newest.map(([key, stmt]) => [key, stmt.get(id)?.value ?? null])));
  }
  return out;
}

// Sum of the measured values; null when none is measured, never 0.
function sumMeasured(values) {
  const measured = values.filter(v => v !== null && v !== undefined);
  return measured.length ? measured.reduce((s, v) => s + v, 0) : null;
}

/**
 * The models list of /api/huggingface-stats. Each model carries its last
 * measured counts (null when never measured) and last7Downloads: the growth
 * of the all-time count since the newest measured snapshot at least 7 days
 * old, null without one.
 */
function huggingfaceModelList(db) {
  const counts = huggingfaceLastMeasured(db);
  const weekAgo = tableExists(db, 'huggingface_stats') ? db.prepare(`
    SELECT downloads_all_time AS value FROM huggingface_stats
    WHERE model_id = ? AND downloads_all_time IS NOT NULL AND date <= date('now', '-7 days')
    ORDER BY date DESC LIMIT 1
  `) : null;
  return db.prepare('SELECT * FROM huggingface_models ORDER BY model_id').all().map(m => {
    const c = counts.get(m.id) || NOTHING_MEASURED;
    const base = weekAgo ? weekAgo.get(m.id)?.value ?? null : null;
    return {
      id: m.id,
      name: m.model_id,
      full_name: m.model_id,
      author: m.author,
      pipeline_tag: m.pipeline_tag,
      downloadsAllTime: c.downloadsAllTime,
      downloads30d: c.downloads30d,
      likes: c.likes,
      last7Downloads: c.downloadsAllTime !== null && base !== null ? Math.max(0, c.downloadsAllTime - base) : null,
    };
  });
}

/**
 * One model of /api/huggingface-stats?model_id=, or null when there is no
 * such model. `series` is every snapshot dated on or after startDate; a
 * snapshot without an all-time count has dailyDownloads null, and the next
 * measured one is compared with the last measured before it. `summary` holds
 * the model's last measured counts (null when never measured), and
 * periodDownloads spans the first and last measured all-time counts in the
 * range (null when the range has none).
 */
function huggingfaceModelDetail(db, modelId, startDate) {
  const model = db.prepare('SELECT * FROM huggingface_models WHERE id = ?').get(modelId);
  if (!model) return null;
  const snapshots = tableExists(db, 'huggingface_stats') ? db.prepare(`
    SELECT date, downloads_30d, downloads_all_time, likes
    FROM huggingface_stats
    WHERE model_id = ? AND date >= ?
    ORDER BY date ASC
  `).all(modelId, startDate) : [];

  let previous = null;
  const series = snapshots.map(row => {
    const all = row.downloads_all_time;
    const dailyDownloads = all === null ? null : previous === null ? 0 : Math.max(0, all - previous);
    if (all !== null) previous = all;
    return {
      date: row.date,
      downloadsAllTime: all,
      downloads30d: row.downloads_30d,
      likes: row.likes,
      dailyDownloads,
    };
  });

  const measured = snapshots.filter(r => r.downloads_all_time !== null);
  const c = huggingfaceLastMeasured(db).get(modelId) || NOTHING_MEASURED;
  return {
    model,
    summary: {
      downloadsAllTime: c.downloadsAllTime,
      downloads30d: c.downloads30d,
      likes: c.likes,
      periodDownloads: measured.length
        ? Math.max(0, measured[measured.length - 1].downloads_all_time - measured[0].downloads_all_time)
        : null,
      daysTracked: snapshots.length,
    },
    series,
  };
}

module.exports = {
  huggingfaceStatsDdl, HF_STATS_INDEXES, migrateHuggingfaceStats, huggingfaceDownloads,
  huggingfaceLastMeasured, sumMeasured, huggingfaceModelList, huggingfaceModelDetail,
};
