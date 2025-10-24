const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'analytics.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner, repo)
  );

  CREATE TABLE IF NOT EXISTS traffic_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL,
    uniques INTEGER NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id),
    UNIQUE(repo_id, date)
  );

  CREATE TABLE IF NOT EXISTS traffic_clones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL,
    uniques INTEGER NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id),
    UNIQUE(repo_id, date)
  );

  CREATE TABLE IF NOT EXISTS referrers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    referrer TEXT NOT NULL,
    count INTEGER NOT NULL,
    uniques INTEGER NOT NULL,
    date TEXT NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id)
  );

  CREATE TABLE IF NOT EXISTS popular_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    title TEXT,
    count INTEGER NOT NULL,
    uniques INTEGER NOT NULL,
    date TEXT NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id)
  );

  CREATE TABLE IF NOT EXISTS stargazers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    total_stars INTEGER NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id),
    UNIQUE(repo_id, date)
  );

  CREATE TABLE IF NOT EXISTS forks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    total_forks INTEGER NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id),
    UNIQUE(repo_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_views_date ON traffic_views(date);
  CREATE INDEX IF NOT EXISTS idx_clones_date ON traffic_clones(date);
  CREATE INDEX IF NOT EXISTS idx_stargazers_date ON stargazers(date);
  CREATE INDEX IF NOT EXISTS idx_forks_date ON forks(date);
`);

console.log('✅ Database setup complete!');
console.log(`📁 Database location: ${dbPath}`);

db.close();
