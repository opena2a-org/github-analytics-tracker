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
    -- Canonical (current) owner/repo after any GitHub transfer or rename. For a
    -- live repo this equals full_name; for a stale row left behind by a transfer
    -- (opena2a-org -> opena2a-standards) or rename it points at the new path so
    -- aggregations can collapse the twins. Maintained by collect-stats.js and
    -- seeded by scripts/backfill-canonical.js. See lib/repos.js.
    canonical_full_name TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
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
    -- owner/repo this package was auto-discovered from, used to attribute the
    -- package to a tool in the dashboard. NULL for explicit-list packages.
    source_repo TEXT,
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

  -- PyPI downloads by country (from Google BigQuery public dataset)
  CREATE TABLE IF NOT EXISTS pypi_country_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    country_code TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0,
    collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
    UNIQUE(package_id, date, country_code)
  );

  CREATE INDEX IF NOT EXISTS idx_pypi_country_pkg_date ON pypi_country_downloads(package_id, date);

  -- Per-day country rows (one closed UTC day each); pypi_country_downloads
  -- above holds the locally-summed 30-day rollup the dashboard reads.
  CREATE TABLE IF NOT EXISTS pypi_country_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    country_code TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (package_id) REFERENCES pypi_packages(id),
    UNIQUE(package_id, date, country_code)
  );

  CREATE INDEX IF NOT EXISTS idx_pypi_country_daily_pkg_date ON pypi_country_daily(package_id, date);

  -- Which closed days the BigQuery collector has already fetched (a queried
  -- day that returned zero rows is still recorded, so it is never re-billed).
  CREATE TABLE IF NOT EXISTS pypi_country_fetch_days (
    date TEXT PRIMARY KEY,
    row_count INTEGER NOT NULL DEFAULT 0,
    bytes_billed INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL
  );

  -- HuggingFace model tracking.
  -- HF's API exposes only point-in-time counters (no per-day history), so we
  -- snapshot daily like Docker pulls: downloads_all_time is cumulative, while
  -- downloads_30d is HF's own rolling-30-day figure. Daily deltas are derived
  -- from successive all-time snapshots at read time.
  CREATE TABLE IF NOT EXISTS huggingface_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL UNIQUE,           -- e.g. "opena2a/nanomind-security-analyst"
    author TEXT NOT NULL,                    -- e.g. "opena2a"
    pipeline_tag TEXT,                       -- e.g. "text-generation"
    repo_type TEXT NOT NULL DEFAULT 'model', -- model | dataset (future-proofing)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS huggingface_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    downloads_30d INTEGER NOT NULL DEFAULT 0,
    downloads_all_time INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (model_id) REFERENCES huggingface_models(id),
    UNIQUE(model_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_hf_stats_model ON huggingface_stats(model_id);
  CREATE INDEX IF NOT EXISTS idx_hf_stats_date ON huggingface_stats(date);

  -- Chrome Web Store extension tracking.
  -- Google exposes no install/download API. The only public number is the
  -- listing page's user count, which is a ROUNDED WEEKLY-ACTIVE-USER figure
  -- (a snapshot, like GitHub stars), scraped daily. It is NOT a cumulative
  -- download total and must not be summed into the adoption metric.
  CREATE TABLE IF NOT EXISTS chrome_extensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extension_id TEXT NOT NULL UNIQUE,       -- 32-char Chrome Web Store id
    name TEXT,
    slug TEXT,                               -- URL slug, e.g. "ai-browser-guard"
    version TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chrome_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extension_id INTEGER NOT NULL,           -- FK to chrome_extensions.id
    date TEXT NOT NULL,
    users INTEGER NOT NULL DEFAULT 0,        -- rounded weekly-active users (snapshot)
    rating REAL,                             -- average rating, null when no ratings
    rating_count INTEGER,                    -- number of ratings, null when unknown
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (extension_id) REFERENCES chrome_extensions(id),
    UNIQUE(extension_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_chrome_stats_ext ON chrome_stats(extension_id);
  CREATE INDEX IF NOT EXISTS idx_chrome_stats_date ON chrome_stats(date);

  -- First-party CLI telemetry — COARSE public projection.
  -- Ingested from the Registry's GET /api/v1/telemetry/v1/adoption/public feed
  -- (see scripts/collect-telemetry-stats.js). These are ACTIVE USERS: distinct
  -- install_id counts over rolling windows (WAU 7d, MAU 30d) within the feed's
  -- retention window. They are NOT downloads — a download is not a user — so
  -- they are shown distinctly and NEVER summed into the download "adoption"
  -- total (same rule as Chrome weekly-active users).
  --
  -- IMPORTANT: this database is committed to a public repo. Only the coarse
  -- projection lands here. Fine-grained telemetry (command usage, retention
  -- cohorts, error rates) is fetched live behind ANALYTICS_TRACKER_PASSWORD from the
  -- Registry's authenticated internal endpoint and is never persisted.
  -- Daily snapshots (one row per collection day), like Chrome and HuggingFace.
  CREATE TABLE IF NOT EXISTS telemetry_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                        -- collection day (UTC)
    generated_at TEXT,                         -- feed's measured-at timestamp (RFC3339)
    provenance TEXT,                           -- honest basis + limits, carried from the feed (best-effort, not sybil-verified)
    retention_days INTEGER NOT NULL DEFAULT 0, -- events retention backing the counts
    wau_window_days INTEGER NOT NULL DEFAULT 0,
    mau_window_days INTEGER NOT NULL DEFAULT 0,
    total_installs INTEGER NOT NULL DEFAULT 0, -- fleet-wide distinct installs (retention window)
    wau INTEGER NOT NULL DEFAULT 0,            -- fleet-wide weekly active installs
    mau INTEGER NOT NULL DEFAULT 0,            -- fleet-wide monthly active installs
    engaged_mau INTEGER NOT NULL DEFAULT 0,    -- sybil-dampened floor (>=2 active days + a command); <= mau
    engaged_min_days INTEGER NOT NULL DEFAULT 0, -- active-days threshold behind engaged_mau
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date)
  );

  CREATE TABLE IF NOT EXISTS telemetry_tool_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    tool TEXT NOT NULL,                        -- Registry tool id (e.g. "hackmyagent")
    total_installs INTEGER NOT NULL DEFAULT 0,
    wau INTEGER NOT NULL DEFAULT 0,
    mau INTEGER NOT NULL DEFAULT 0,
    engaged_mau INTEGER NOT NULL DEFAULT 0,    -- sybil-dampened floor for this tool; <= mau
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, tool)
  );

  CREATE TABLE IF NOT EXISTS telemetry_version_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    tool TEXT NOT NULL,
    version TEXT NOT NULL,
    installs INTEGER NOT NULL DEFAULT 0,       -- distinct installs active on this version (MAU window)
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, tool, version)
  );

  CREATE TABLE IF NOT EXISTS telemetry_country_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    country_code TEXT NOT NULL,
    installs INTEGER NOT NULL DEFAULT 0,       -- distinct installs by country (retention window)
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, country_code)
  );

  CREATE INDEX IF NOT EXISTS idx_telemetry_tool_date ON telemetry_tool_snapshots(date);
  CREATE INDEX IF NOT EXISTS idx_telemetry_version_date ON telemetry_version_snapshots(date);
  CREATE INDEX IF NOT EXISTS idx_telemetry_country_date ON telemetry_country_snapshots(date);
`);

// --- Idempotent migrations for pre-existing databases ---
// `CREATE TABLE IF NOT EXISTS` won't add columns to a table that already exists,
// so add the canonical-repo columns here when an older DB is missing them.
const repoCols = db.prepare("PRAGMA table_info(repositories)").all().map(c => c.name);
if (!repoCols.includes('canonical_full_name')) {
  db.exec('ALTER TABLE repositories ADD COLUMN canonical_full_name TEXT');
  console.log('Migration: added repositories.canonical_full_name');
}
if (!repoCols.includes('archived')) {
  db.exec('ALTER TABLE repositories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  console.log('Migration: added repositories.archived');
}

// telemetry_snapshots.provenance was added after the table first shipped.
const telSnapExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_snapshots'"
).get();
if (telSnapExists) {
  const telCols = db.prepare('PRAGMA table_info(telemetry_snapshots)').all().map(c => c.name);
  if (!telCols.includes('provenance')) {
    db.exec('ALTER TABLE telemetry_snapshots ADD COLUMN provenance TEXT');
    console.log('Migration: added telemetry_snapshots.provenance');
  }
  // engagedMau (sybil-dampened floor) was added after the table first shipped.
  if (!telCols.includes('engaged_mau')) {
    db.exec('ALTER TABLE telemetry_snapshots ADD COLUMN engaged_mau INTEGER NOT NULL DEFAULT 0');
    console.log('Migration: added telemetry_snapshots.engaged_mau');
  }
  if (!telCols.includes('engaged_min_days')) {
    db.exec('ALTER TABLE telemetry_snapshots ADD COLUMN engaged_min_days INTEGER NOT NULL DEFAULT 0');
    console.log('Migration: added telemetry_snapshots.engaged_min_days');
  }
}

const telToolExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_tool_snapshots'"
).get();
if (telToolExists) {
  const cols = db.prepare('PRAGMA table_info(telemetry_tool_snapshots)').all().map(c => c.name);
  if (!cols.includes('engaged_mau')) {
    db.exec('ALTER TABLE telemetry_tool_snapshots ADD COLUMN engaged_mau INTEGER NOT NULL DEFAULT 0');
    console.log('Migration: added telemetry_tool_snapshots.engaged_mau');
  }
}

console.log('Database setup complete: %s', dbPath);

db.close();
