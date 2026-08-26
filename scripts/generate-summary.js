/**
 * Generates the public summary JSON (data/summary.json): flat totals, the
 * registry series with their definitions and windows, and the collector status
 * of the run that produced it. All logic lives in lib/summary.js so the
 * regression tests can build the same object against a fixture database.
 *
 * Consumed by: opena2a-website (data/canonical-numbers.json refresh) and Atlas.
 *
 * Env: SUMMARY_DB (default data/analytics.db), SUMMARY_OUT (default
 * data/summary.json), COLLECTOR_OUTCOMES (set by the workflow).
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { buildSummary } = require('../lib/summary');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = process.env.SUMMARY_DB || path.join(dataDir, 'analytics.db');
const outPath = process.env.SUMMARY_OUT || path.join(dataDir, 'summary.json');
const db = new Database(dbPath, { readonly: true });

try {
  const summary = buildSummary(db, { dataDir });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Summary written to ${outPath}`);
  for (const [key, s] of Object.entries(summary.series)) {
    console.log(`  ${key}: ${s.value.toLocaleString()} (${s.status})`);
  }
  const g = summary.collectors.github;
  console.log(`  GitHub coverage: discovered ${g.reposDiscovered ?? 'n/a'}, collected today ${g.reposCollectedToday}, lagging ${g.reposLagging.length}`);
} catch (err) {
  console.error('Error generating summary:', err);
  process.exit(1);
} finally {
  db.close();
}
