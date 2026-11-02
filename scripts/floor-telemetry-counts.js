/**
 * Floor the stored first-party telemetry counts.
 *
 * Every count from 0 to 9 in the telemetry_*_snapshots tables is withheld:
 * stored as NULL, never as a number and never as the column's old DEFAULT 0.
 * Zero is included, because a series that shows 0 on some days and withheld on
 * others reveals one to nine. Counts of 10 or more are kept as they are, and so
 * is every row.
 *
 * The step is idempotent and safe to re-run on any copy of the store:
 *   1. a table whose count columns still carry NOT NULL or a default is rebuilt
 *      with nullable counts, keeping every row;
 *   2. every stored count under ten is set to NULL;
 *   3. when 1 or 2 changed anything, the file is rebuilt (VACUUM), so no
 *      replaced value is left behind in free pages; secure_delete zeroes freed
 *      content during the run itself;
 *   4. from the command line, the telemetry block of data/summary.json is
 *      rewritten from the floored store with the code generate-summary uses.
 *
 * setup-database.js and the collector run steps 1 to 3 on every collection, so
 * the committed store stays floored. Usage:
 *
 *   node scripts/floor-telemetry-counts.js [--db=data/analytics.db] [--summary=data/summary.json|none]
 *
 * It prints row counts only, never a stored figure, and exits 1 when a count
 * under ten is still stored afterwards.
 */
const fs = require('fs');
const path = require('path');
const { WITHHELD_FLOOR } = require('../lib/telemetry-withheld');

// Every count column, per table. Window lengths and thresholds (retention_days,
// engaged_min_days, ...) are settings, not counts of installs, and are kept.
const TELEMETRY_COUNT_COLUMNS = Object.freeze({
  telemetry_snapshots: Object.freeze(['total_installs', 'wau', 'mau', 'engaged_mau']),
  telemetry_tool_snapshots: Object.freeze(['total_installs', 'wau', 'mau', 'engaged_mau']),
  telemetry_version_snapshots: Object.freeze(['installs']),
  telemetry_country_snapshots: Object.freeze(['installs']),
});

// Count columns are nullable with no default: NULL is a withheld count (under
// ten, zero included), and an insert that leaves a count out stores NULL, not 0.
const TABLE_DDL = {
  telemetry_snapshots: (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                        -- collection day (UTC)
    generated_at TEXT,                         -- feed's measured-at timestamp (RFC3339)
    provenance TEXT,                           -- honest basis + limits, carried from the feed (best-effort, not sybil-verified)
    retention_days INTEGER NOT NULL DEFAULT 0, -- events retention backing the counts
    wau_window_days INTEGER NOT NULL DEFAULT 0,
    mau_window_days INTEGER NOT NULL DEFAULT 0,
    total_installs INTEGER,                    -- fleet-wide distinct installs (retention window); NULL = withheld
    wau INTEGER,                               -- fleet-wide weekly active installs; NULL = withheld
    mau INTEGER,                               -- fleet-wide monthly active installs; NULL = withheld
    engaged_mau INTEGER,                       -- sybil-dampened floor (>=2 active days + a command), <= mau; NULL = withheld
    engaged_min_days INTEGER NOT NULL DEFAULT 0, -- active-days threshold behind engaged_mau
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date)
  );`,
  telemetry_tool_snapshots: (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    tool TEXT NOT NULL,                        -- Registry tool id (e.g. "hackmyagent")
    total_installs INTEGER,                    -- NULL = withheld
    wau INTEGER,                               -- NULL = withheld
    mau INTEGER,                               -- NULL = withheld
    engaged_mau INTEGER,                       -- sybil-dampened floor for this tool, <= mau; NULL = withheld
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, tool)
  );`,
  telemetry_version_snapshots: (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    tool TEXT NOT NULL,
    version TEXT NOT NULL,
    installs INTEGER,                          -- distinct installs active on this version (MAU window); NULL = withheld
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, tool, version)
  );`,
  telemetry_country_snapshots: (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    country_code TEXT NOT NULL,
    installs INTEGER,                          -- distinct installs by country (retention window); NULL = withheld
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, country_code)
  );`,
};

// The columns of each table above, in order, for the rebuild copy.
const TABLE_COLUMNS = Object.freeze({
  telemetry_snapshots: ['id', 'date', 'generated_at', 'provenance', 'retention_days', 'wau_window_days',
    'mau_window_days', 'total_installs', 'wau', 'mau', 'engaged_mau', 'engaged_min_days', 'collected_at'],
  telemetry_tool_snapshots: ['id', 'date', 'tool', 'total_installs', 'wau', 'mau', 'engaged_mau', 'collected_at'],
  telemetry_version_snapshots: ['id', 'date', 'tool', 'version', 'installs', 'collected_at'],
  telemetry_country_snapshots: ['id', 'date', 'country_code', 'installs', 'collected_at'],
});

const TABLE_INDEXES = {
  telemetry_snapshots: '',
  telemetry_tool_snapshots: 'CREATE INDEX IF NOT EXISTS idx_telemetry_tool_date ON telemetry_tool_snapshots(date);',
  telemetry_version_snapshots: 'CREATE INDEX IF NOT EXISTS idx_telemetry_version_date ON telemetry_version_snapshots(date);',
  telemetry_country_snapshots: 'CREATE INDEX IF NOT EXISTS idx_telemetry_country_date ON telemetry_country_snapshots(date);',
};

const TABLES = Object.keys(TELEMETRY_COUNT_COLUMNS);

/** The four telemetry tables and their indexes, for setup-database.js. */
function telemetrySchemaDdl() {
  return TABLES.map(t => TABLE_DDL[t](t)).join('\n') + '\n' +
    TABLES.map(t => TABLE_INDEXES[t]).filter(Boolean).join('\n');
}

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function countColumnsAreNullable(db, table) {
  const counts = TELEMETRY_COUNT_COLUMNS[table];
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .filter(c => counts.includes(c.name))
    .every(c => !c.notnull && c.dflt_value === null);
}

// The count columns a table has (an older table may lack one).
function presentCountColumns(db, table) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  return TELEMETRY_COUNT_COLUMNS[table].filter(c => existing.has(c));
}

/**
 * Rebuild each existing telemetry table whose count columns still carry NOT
 * NULL or a default, keeping every row. SQLite cannot drop NOT NULL in place.
 * Every table is checked before any is changed, and all are rebuilt in one
 * transaction, so a refusal leaves the store as it was. Returns the names of
 * the tables rebuilt.
 */
function migrateTelemetryCounts(db) {
  const plan = [];
  for (const table of TABLES) {
    if (!tableExists(db, table) || countColumnsAreNullable(db, table)) continue;
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    const unknown = existing.filter(c => !TABLE_COLUMNS[table].includes(c));
    if (unknown.length > 0) {
      // Rebuilding would drop these columns; stop rather than lose data.
      throw new Error(`${table} has columns the floored schema does not carry: ${unknown.join(', ')}`);
    }
    plan.push({ table, cols: TABLE_COLUMNS[table].filter(c => existing.includes(c)).join(', ') });
  }
  if (plan.length === 0) return [];
  db.transaction(() => {
    for (const { table, cols } of plan) {
      const temp = `${table}_floor_rebuild`;
      db.exec(`DROP TABLE IF EXISTS ${temp}`);
      db.exec(TABLE_DDL[table](temp));
      db.exec(`INSERT INTO ${temp} (${cols}) SELECT ${cols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${temp} RENAME TO ${table}`);
      if (TABLE_INDEXES[table]) db.exec(TABLE_INDEXES[table]);
    }
  })();
  return plan.map(p => p.table);
}

/**
 * Set every stored count under ten to NULL, in one transaction. Returns the
 * number of rows changed per existing table.
 */
function floorStoredTelemetryCounts(db) {
  const changed = {};
  db.transaction(() => {
    for (const table of TABLES) {
      if (!tableExists(db, table)) continue;
      const cols = presentCountColumns(db, table);
      if (cols.length === 0) { changed[table] = 0; continue; }
      const set = cols.map(c => `${c} = CASE WHEN ${c} < ${WITHHELD_FLOOR} THEN NULL ELSE ${c} END`).join(', ');
      const where = cols.map(c => `${c} < ${WITHHELD_FLOOR}`).join(' OR ');
      changed[table] = db.prepare(`UPDATE ${table} SET ${set} WHERE ${where}`).run().changes;
    }
  })();
  return changed;
}

/**
 * Rows that still hold a count from 0 to 9, per table (0 for a missing table).
 * Every value must be 0 once the floor has run.
 */
function countsUnderFloor(db) {
  const out = {};
  for (const table of TABLES) {
    const cols = tableExists(db, table) ? presentCountColumns(db, table) : [];
    if (cols.length === 0) { out[table] = 0; continue; }
    const where = cols.map(c => `${c} BETWEEN 0 AND ${WITHHELD_FLOOR - 1}`).join(' OR ');
    out[table] = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
  }
  return out;
}

/**
 * Steps 1 to 3 on an open, writable connection (no transaction open).
 * Returns { rebuilt: [table], floored: { table: rows }, vacuumed: boolean }.
 */
function cleanTelemetryStore(db) {
  db.pragma('secure_delete = ON');
  const rebuilt = migrateTelemetryCounts(db);
  const floored = floorStoredTelemetryCounts(db);
  const changedRows = Object.values(floored).reduce((a, b) => a + b, 0);
  const vacuumed = rebuilt.length > 0 || changedRows > 0;
  if (vacuumed) db.exec('VACUUM');
  return { rebuilt, floored, vacuumed };
}

/**
 * Rewrite the telemetry block of a summary file from the store, with the same
 * code generate-summary uses. Every other key is left as it was. Returns
 * 'rewritten', 'unchanged' or 'absent'.
 */
function rewriteSummaryTelemetry(db, summaryPath) {
  if (!fs.existsSync(summaryPath)) return 'absent';
  const raw = fs.readFileSync(summaryPath, 'utf8');
  const summary = JSON.parse(raw);
  if (!summary || typeof summary.total !== 'object' || summary.total === null) return 'absent';
  const { telemetrySummary } = require('../lib/summary');
  const next = { ...summary, total: { ...summary.total, telemetry: telemetrySummary(db) } };
  const out = JSON.stringify(next, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  if (out === raw) return 'unchanged';
  fs.writeFileSync(summaryPath, out);
  return 'rewritten';
}

function parseArgs(argv) {
  const dataDir = path.join(__dirname, '..', 'data');
  const args = { db: path.join(dataDir, 'analytics.db'), summary: path.join(dataDir, 'summary.json') };
  for (const a of argv) {
    const m = /^--(db|summary)=(.+)$/.exec(a);
    if (!m) throw new Error(`unknown argument: ${a} (expected --db=<path> or --summary=<path>|none)`);
    args[m[1]] = m[2];
  }
  if (args.summary === 'none') args.summary = null;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.db)) throw new Error(`no database at ${args.db}`);
  const Database = require('better-sqlite3');
  const db = new Database(args.db);
  try {
    const { rebuilt, floored, vacuumed } = cleanTelemetryStore(db);
    console.log('Telemetry store floor (counts under ten withheld, zero included): %s', args.db);
    console.log('  schema: %s', rebuilt.length ? `rebuilt with nullable counts: ${rebuilt.join(', ')}` : 'counts already nullable');
    for (const [table, rows] of Object.entries(floored)) console.log('  %s: %d row(s) set to withheld', table, rows);
    console.log('  file rebuilt (VACUUM): %s', vacuumed ? 'yes' : 'no, nothing changed');
    if (args.summary) console.log('  summary telemetry block: %s', rewriteSummaryTelemetry(db, args.summary));
    const left = countsUnderFloor(db);
    for (const [table, rows] of Object.entries(left)) console.log('  check %s rows with a count from 0 to 9: %d', table, rows);
    if (Object.values(left).some(n => n !== 0)) {
      console.error('  a count under ten is still stored');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Error: %s', err && err.message);
    process.exit(1);
  }
}

module.exports = {
  TELEMETRY_COUNT_COLUMNS,
  cleanTelemetryStore,
  countsUnderFloor,
  floorStoredTelemetryCounts,
  migrateTelemetryCounts,
  rewriteSummaryTelemetry,
  telemetrySchemaDdl,
};
