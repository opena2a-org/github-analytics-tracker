const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

/*
 * HuggingFace model analytics collector.
 *
 * Auto-discovers every model under the orgs/users listed in HF_AUTHOR
 * (comma-separated), plus any explicit models in HF_MODELS. Snapshots
 * downloads (rolling 30d), downloadsAllTime (cumulative), and likes once
 * per day. HF exposes no per-day history, so the daily series is built
 * from successive all-time snapshots at read time (same model as Docker).
 *
 * Config (env):
 *   HF_AUTHOR=opena2a              # comma-separated orgs/users to auto-discover
 *   HF_MODELS=org/model,org/other  # optional explicit extras
 *   HF_TOKEN=hf_...                # optional, raises rate limits / private repos
 */
const HF_AUTHORS = (process.env.HF_AUTHOR || '').split(',').map(s => s.trim()).filter(Boolean);
const HF_EXTRA_MODELS = (process.env.HF_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
const HF_TOKEN = process.env.HF_TOKEN || '';

if (HF_AUTHORS.length === 0 && HF_EXTRA_MODELS.length === 0) {
  console.error('Error: set HF_AUTHOR (e.g. opena2a) and/or HF_MODELS to collect HuggingFace stats');
  process.exit(1);
}

const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath);

const today = new Date().toISOString().split('T')[0];

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'github-analytics-tracker' };
    if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;
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

async function discoverModels(author) {
  const url = `https://huggingface.co/api/models?author=${encodeURIComponent(author)}&${EXPAND}&limit=1000`;
  const models = await httpGetJson(url);
  return Array.isArray(models) ? models : [];
}

async function fetchModel(modelId) {
  const url = `https://huggingface.co/api/models/${modelId}?${EXPAND}`;
  return httpGetJson(url);
}

function getOrCreateModel(modelId, author, pipelineTag) {
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

const upsertStats = db.prepare(`
  INSERT INTO huggingface_stats (model_id, date, downloads_30d, downloads_all_time, likes)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(model_id, date) DO UPDATE SET
    downloads_30d = excluded.downloads_30d,
    downloads_all_time = excluded.downloads_all_time,
    likes = excluded.likes,
    collected_at = CURRENT_TIMESTAMP
`);

function recordModel(model) {
  const modelId = model.id || model.modelId;
  if (!modelId) return;
  const author = modelId.split('/')[0];
  const record = getOrCreateModel(modelId, author, model.pipeline_tag);

  const downloads30d = model.downloads || 0;
  const downloadsAllTime = model.downloadsAllTime || 0;
  const likes = model.likes || 0;

  upsertStats.run(record.id, today, downloads30d, downloadsAllTime, likes);
  console.log('  %s — 30d: %d | all-time: %d | likes: %d', modelId, downloads30d, downloadsAllTime, likes);

  // Badge JSON (consumable by external sites, mirrors docker-badge-*.json)
  const badge = {
    schemaVersion: 1,
    label: 'HF downloads',
    message: downloadsAllTime.toLocaleString(),
    color: 'yellow',
    namedLogo: 'huggingface',
    style: 'flat',
  };
  const safeName = modelId.replace(/\//g, '_');
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', `hf-badge-${safeName}.json`),
    JSON.stringify(badge, null, 2)
  );
}

async function main() {
  console.log('HuggingFace Analytics Collector');
  console.log('Date: %s', today);

  const seen = new Set();

  for (const author of HF_AUTHORS) {
    console.log('\nDiscovering models for author "%s"...', author);
    try {
      const models = await discoverModels(author);
      console.log('  Found %d model(s)', models.length);
      for (const model of models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        recordModel(model);
      }
    } catch (err) {
      console.error('  Discovery failed for %s: %s', author, err.message);
    }
  }

  for (const modelId of HF_EXTRA_MODELS) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    console.log('\nFetching explicit model %s...', modelId);
    try {
      const model = await fetchModel(modelId);
      recordModel(model);
    } catch (err) {
      console.error('  Failed %s: %s', modelId, err.message);
    }
  }

  console.log('\nHuggingFace collection complete! Tracked %d model(s).', seen.size);
  db.close();
}

main().catch(error => {
  console.error('Fatal error: %s', error.message);
  process.exit(1);
});
