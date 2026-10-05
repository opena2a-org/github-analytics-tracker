const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { migrateHuggingfaceStats } = require('../lib/huggingface');

/*
 * HuggingFace model analytics collector.
 *
 * Auto-discovers every model under the orgs/users listed in HF_AUTHOR
 * (comma-separated), plus any explicit models in HF_MODELS. Snapshots
 * downloads (rolling 30d), downloadsAllTime (cumulative), and likes once
 * per day. HF exposes no per-day history, so the daily series is built
 * from successive all-time snapshots at read time (same model as Docker).
 *
 * A count the API does not return (or returns as anything other than a
 * non-negative integer) is stored as NULL with the reason in absent_reason,
 * never as 0: a stored 0 reads as a measured zero and would reach the
 * published downloads total. Readers carry the last measured value forward
 * under its own date (lib/huggingface.js).
 *
 * Config (env):
 *   HF_AUTHOR=opena2a              # comma-separated orgs/users to auto-discover
 *   HF_MODELS=org/model,org/other  # optional explicit extras
 *   HF_TOKEN=hf_...                # optional, raises rate limits / private repos
 */
const DATA_DIR = path.join(__dirname, '..', 'data');

const listEnv = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

function httpGetJson(url, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'github-analytics-tracker' };
    if (token) headers.Authorization = `Bearer ${token}`;
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

const EXPAND = 'expand[]=downloads&expand[]=downloadsAllTime&expand[]=likes&expand[]=pipeline_tag&expand[]=lastModified';

async function discoverModels(author, token) {
  const url = `https://huggingface.co/api/models?author=${encodeURIComponent(author)}&${EXPAND}&limit=1000`;
  const models = await httpGetJson(url, token);
  return Array.isArray(models) ? models : [];
}

async function fetchModel(modelId, token) {
  const url = `https://huggingface.co/api/models/${modelId}?${EXPAND}`;
  return httpGetJson(url, token);
}

// API field -> huggingface_stats column, for the three counts snapshotted daily.
const COUNT_FIELDS = [
  ['downloads', 'downloads_30d'],
  ['downloadsAllTime', 'downloads_all_time'],
  ['likes', 'likes'],
];

/**
 * One count from a model response: { value, reason }. `value` is the count
 * when the API returned a non-negative integer, otherwise null with `reason`
 * naming the field and what was wrong. The reason never echoes the response.
 */
function readCount(model, field) {
  const v = model[field];
  if (v === undefined || v === null) return { value: null, reason: `${field} absent from the API response` };
  if (!Number.isSafeInteger(v) || v < 0) return { value: null, reason: `${field} not a non-negative integer in the API response` };
  return { value: v, reason: null };
}

/**
 * The row values for one model response: downloads30d, downloadsAllTime and
 * likes (each a count or null), and absentReason (the reasons for every null,
 * joined, or null when all three were measured).
 */
function countsFor(model) {
  const [d30, all, likes] = COUNT_FIELDS.map(([field]) => readCount(model, field));
  const reasons = [d30, all, likes].map(c => c.reason).filter(Boolean);
  return {
    downloads30d: d30.value,
    downloadsAllTime: all.value,
    likes: likes.value,
    absentReason: reasons.length ? reasons.join('; ') : null,
  };
}

function getOrCreateModel(db, modelId, author, pipelineTag) {
  let record = db.prepare('SELECT * FROM huggingface_models WHERE model_id = ?').get(modelId);
  if (!record) {
    const result = db.prepare(
      'INSERT INTO huggingface_models (model_id, author, pipeline_tag) VALUES (?, ?, ?)'
    ).run(modelId, author, pipelineTag || null);
    record = { id: result.lastInsertRowid, model_id: modelId, author, pipeline_tag: pipelineTag };
    console.log('  Added new HF model: %s', modelId);
  } else if (pipelineTag && pipelineTag !== record.pipeline_tag) {
    db.prepare('UPDATE huggingface_models SET pipeline_tag = ? WHERE id = ?').run(pipelineTag, record.id);
  }
  return record;
}

const UPSERT_STATS = `
  INSERT INTO huggingface_stats (model_id, date, downloads_30d, downloads_all_time, likes, absent_reason)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(model_id, date) DO UPDATE SET
    downloads_30d = excluded.downloads_30d,
    downloads_all_time = excluded.downloads_all_time,
    likes = excluded.likes,
    absent_reason = excluded.absent_reason,
    collected_at = CURRENT_TIMESTAMP
`;

const shown = v => (v === null ? 'absent' : String(v));

/**
 * Store today's snapshot for one model response and refresh its badge.
 * Returns the stored counts, or null when the response names no model.
 */
function recordModel(db, model, { today, dataDir = DATA_DIR } = {}) {
  if (!model || typeof model !== 'object') return null;
  const modelId = model.id || model.modelId;
  if (!modelId) return null;
  const author = modelId.split('/')[0];
  const record = getOrCreateModel(db, modelId, author, model.pipeline_tag);

  const counts = countsFor(model);
  db.prepare(UPSERT_STATS).run(
    record.id, today, counts.downloads30d, counts.downloadsAllTime, counts.likes, counts.absentReason
  );
  console.log('  %s — 30d: %s | all-time: %s | likes: %s',
    modelId, shown(counts.downloads30d), shown(counts.downloadsAllTime), shown(counts.likes));
  if (counts.absentReason) console.warn('  %s — stored as absent: %s', modelId, counts.absentReason);

  // Badge JSON (consumable by external sites, mirrors docker-badge-*.json).
  // Without a measured all-time count the previous badge is left in place.
  if (counts.downloadsAllTime === null) return counts;
  const badge = {
    schemaVersion: 1,
    label: 'HF downloads',
    message: counts.downloadsAllTime.toLocaleString(),
    color: 'yellow',
    namedLogo: 'huggingface',
    style: 'flat',
  };
  const safeName = modelId.replace(/\//g, '_');
  fs.writeFileSync(
    path.join(dataDir, `hf-badge-${safeName}.json`),
    JSON.stringify(badge, null, 2)
  );
  return counts;
}

/**
 * Open the stats database with huggingface_stats on the nullable schema, so a
 * database created before it collects without a separate `npm run setup-db`.
 */
function openDatabase(file = path.join(DATA_DIR, 'analytics.db')) {
  const db = new Database(file);
  if (migrateHuggingfaceStats(db)) {
    console.log('Migration: rebuilt huggingface_stats with nullable counts and absent_reason');
  }
  return db;
}

async function main() {
  require('dotenv').config();
  const authors = listEnv(process.env.HF_AUTHOR);
  const extraModels = listEnv(process.env.HF_MODELS);
  const token = process.env.HF_TOKEN || '';
  if (authors.length === 0 && extraModels.length === 0) {
    console.error('Error: set HF_AUTHOR (e.g. opena2a) and/or HF_MODELS to collect HuggingFace stats');
    process.exit(1);
  }

  const db = openDatabase();
  const today = new Date().toISOString().split('T')[0];

  console.log('HuggingFace Analytics Collector');
  console.log('Date: %s', today);

  const seen = new Set();

  for (const author of authors) {
    console.log('\nDiscovering models for author "%s"...', author);
    try {
      const models = await discoverModels(author, token);
      console.log('  Found %d model(s)', models.length);
      for (const model of models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        recordModel(db, model, { today });
      }
    } catch (err) {
      console.error('  Discovery failed for %s: %s', author, err.message);
    }
  }

  for (const modelId of extraModels) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    console.log('\nFetching explicit model %s...', modelId);
    try {
      const model = await fetchModel(modelId, token);
      recordModel(db, model, { today });
    } catch (err) {
      console.error('  Failed %s: %s', modelId, err.message);
    }
  }

  console.log('\nHuggingFace collection complete! Tracked %d model(s).', seen.size);
  db.close();
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error: %s', error.message);
    process.exit(1);
  });
}

module.exports = { readCount, countsFor, recordModel, openDatabase };
