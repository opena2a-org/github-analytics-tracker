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

// Use DELETE journal mode for compatibility with read-only filesystems (Vercel).
// WAL mode requires writable -shm/-wal files which don't work on Vercel's read-only fs.
db.pragma('journal_mode = DELETE');

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

  -- Docker image tracking
  CREATE TABLE IF NOT EXISTS docker_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(namespace, name)
  );

  CREATE TABLE IF NOT EXISTS docker_pulls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    pull_count INTEGER NOT NULL,
    star_count INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES docker_images(id),
    UNIQUE(image_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_docker_pulls_image ON docker_pulls(image_id);
  CREATE INDEX IF NOT EXISTS idx_docker_pulls_date ON docker_pulls(date);

  -- PyPI package tracking
  CREATE TABLE IF NOT EXISTS pypi_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pypi_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    downloads INTEGER NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
    UNIQUE(package_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_pypi_downloads_pkg ON pypi_downloads(package_id);
  CREATE INDEX IF NOT EXISTS idx_pypi_downloads_date ON pypi_downloads(date);

  -- ==============================================
  -- Advanced metrics tables
  -- ==============================================

  -- PyPI downloads by Python version (from pypistats.org /python_minor)
  CREATE TABLE IF NOT EXISTS pypi_python_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    python_version TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
    UNIQUE(package_id, date, python_version)
  );

  CREATE INDEX IF NOT EXISTS idx_pypi_pyver_pkg ON pypi_python_versions(package_id);
  CREATE INDEX IF NOT EXISTS idx_pypi_pyver_date ON pypi_python_versions(date);

  -- PyPI downloads by OS (from pypistats.org /system)
  CREATE TABLE IF NOT EXISTS pypi_system_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    os_name TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
    UNIQUE(package_id, date, os_name)
  );

  CREATE INDEX IF NOT EXISTS idx_pypi_sys_pkg ON pypi_system_stats(package_id);
  CREATE INDEX IF NOT EXISTS idx_pypi_sys_date ON pypi_system_stats(date);

  -- npm downloads by version (from npm versions API)
  CREATE TABLE IF NOT EXISTS npm_version_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    version TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES npm_packages(id),
    UNIQUE(package_id, date, version)
  );

  CREATE INDEX IF NOT EXISTS idx_npm_ver_pkg ON npm_version_downloads(package_id);
  CREATE INDEX IF NOT EXISTS idx_npm_ver_date ON npm_version_downloads(date);

  -- GitHub contributor stats
  CREATE TABLE IF NOT EXISTS github_contributors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    login TEXT NOT NULL,
    contributions INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id),
    UNIQUE(repo_id, date, login)
  );

  CREATE INDEX IF NOT EXISTS idx_gh_contrib_repo ON github_contributors(repo_id);
  CREATE INDEX IF NOT EXISTS idx_gh_contrib_date ON github_contributors(date);

  -- GitHub release download counts
  CREATE TABLE IF NOT EXISTS github_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    tag_name TEXT NOT NULL,
    release_name TEXT,
    published_at TEXT,
    total_downloads INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_id) REFERENCES repositories(id),
    UNIQUE(repo_id, date, tag_name)
  );

  CREATE INDEX IF NOT EXISTS idx_gh_rel_repo ON github_releases(repo_id);
  CREATE INDEX IF NOT EXISTS idx_gh_rel_date ON github_releases(date);

  -- Docker Hub tag info
  CREATE TABLE IF NOT EXISTS docker_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    full_size INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT,
    date TEXT NOT NULL,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES docker_images(id),
    UNIQUE(image_id, date, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_docker_tags_img ON docker_tags(image_id);
  CREATE INDEX IF NOT EXISTS idx_docker_tags_date ON docker_tags(date);
`);

console.log('Database setup complete: %s', dbPath);

db.close();
