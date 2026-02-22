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

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

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

  -- Referrers: 14-day rolling snapshot from GitHub API.
  -- We store one snapshot per (repo, date). On re-runs for the same day,
  -- we delete old rows and re-insert to avoid duplicates.
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

  -- Popular paths: same 14-day rolling snapshot approach as referrers.
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

  -- Stores the 14-day summary totals from the GitHub API.
  -- These have properly deduplicated unique counts across the window.
  CREATE TABLE IF NOT EXISTS traffic_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    views_count INTEGER NOT NULL DEFAULT 0,
    views_uniques INTEGER NOT NULL DEFAULT 0,
    clones_count INTEGER NOT NULL DEFAULT 0,
    clones_uniques INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id),
    UNIQUE(repo_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_views_date ON traffic_views(date);
  CREATE INDEX IF NOT EXISTS idx_clones_date ON traffic_clones(date);
  CREATE INDEX IF NOT EXISTS idx_views_repo ON traffic_views(repo_id);
  CREATE INDEX IF NOT EXISTS idx_clones_repo ON traffic_clones(repo_id);
  CREATE INDEX IF NOT EXISTS idx_referrers_repo_date ON referrers(repo_id, date);
  CREATE INDEX IF NOT EXISTS idx_paths_repo_date ON popular_paths(repo_id, date);
  CREATE INDEX IF NOT EXISTS idx_stargazers_date ON stargazers(date);
  CREATE INDEX IF NOT EXISTS idx_forks_date ON forks(date);
  CREATE INDEX IF NOT EXISTS idx_summary_repo ON traffic_summary(repo_id);

  -- npm package tracking
  CREATE TABLE IF NOT EXISTS npm_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS npm_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    downloads INTEGER NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES npm_packages(id),
    UNIQUE(package_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_npm_downloads_pkg ON npm_downloads(package_id);
  CREATE INDEX IF NOT EXISTS idx_npm_downloads_date ON npm_downloads(date);
`);

console.log('Database setup complete: %s', dbPath);

db.close();
