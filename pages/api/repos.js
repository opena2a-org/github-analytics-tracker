const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const repos = db.prepare('SELECT * FROM repositories ORDER BY created_at DESC').all();
    res.status(200).json(repos);
  } catch (error) {
    console.error('Error fetching repos:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  } finally {
    db.close();
  }
}
