const Database = require('better-sqlite3');
const path = require('path');
const { huggingfaceModelList, huggingfaceModelDetail } = require('../../lib/huggingface');

/**
 * Hugging Face API: the models list, or one model's series and summary with
 * ?model_id=. Counts are each model's last measured value, null when never
 * measured; the computation lives in lib/huggingface.js.
 */
export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='huggingface_models'"
    ).get();

    if (!tableCheck) {
      return res.status(200).json({ models: [] });
    }

    const { model_id, days = '30' } = req.query;

    if (model_id) {
      const mId = parseInt(model_id);
      const daysNum = days === 'all' ? 999999 : parseInt(days);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      const startDateStr = startDate.toISOString().split('T')[0];

      const detail = huggingfaceModelDetail(db, mId, startDateStr);
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
