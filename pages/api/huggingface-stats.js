const Database = require('better-sqlite3');
const path = require('path');
const { huggingfaceModelList, huggingfaceModelDetail, parseModelDetailQuery } = require('../../lib/huggingface');

/**
 * Hugging Face API: the models list, or one model's series and summary with
 * ?model_id= (an integer) and ?days= (`all` or a positive integer, default 30);
 * any other value of either is a 400. Counts are each model's last measured
 * value, null when never measured; the computation lives in lib/huggingface.js.
 */
export default function handler(req, res) {
  const query = req.query.model_id ? parseModelDetailQuery(req.query) : null;
  if (query && query.error) {
    return res.status(400).json({ error: query.error });
  }

  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='huggingface_models'"
    ).get();

    if (!tableCheck) {
      return res.status(200).json({ models: [] });
    }

    if (query) {
      const detail = huggingfaceModelDetail(db, query.modelId, query.startDate);
      if (!detail) {
        return res.status(404).json({ error: 'Model not found' });
      }
      return res.status(200).json(detail);
    }

    res.status(200).json({ models: huggingfaceModelList(db) });
  } catch (error) {
    console.error('Error fetching HuggingFace stats:', error);
    res.status(500).json({ error: 'Failed to fetch HuggingFace statistics' });
  } finally {
    db.close();
  }
}
