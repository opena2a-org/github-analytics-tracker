const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

/*
 * The dashboard's date is the time its data was collected (the lastUpdated
 * stamp of data/summary.json), never the moment the page or the API answered.
 * Past 30 hours it reads as stale; with no readable stamp it reads as unknown,
 * never as fresh.
 *
 * The module is loaded inside each test so that every cell fails on its own
 * while lib/freshness.js does not exist.
 */
const freshness = () => require('../lib/freshness');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const STAMP = '2026-11-16T06:05:47.696Z';
const STAMP_MS = Date.UTC(2026, 10, 16, 6, 5, 47, 696);
const UNKNOWN = { state: 'unknown', ageHours: null };

/* A temporary data directory, removed after the test. `summary` is the raw
 * text of summary.json; undefined writes no file. */
function dataDir(t, summary) {
  const dir = mkdtempSync(join(tmpdir(), 'gat-freshness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (summary !== undefined) writeFileSync(join(dir, 'summary.json'), summary);
  return dir;
}

/* ---------- readDataCollectedAt ---------- */

test('readDataCollectedAt returns the lastUpdated stamp of summary.json', (t) => {
  const dir = dataDir(t, JSON.stringify({ lastUpdated: STAMP, repos: [] }, null, 2));
  assert.equal(freshness().readDataCollectedAt(dir), STAMP);
});

test('readDataCollectedAt is null when summary.json is missing', (t) => {
  const dir = dataDir(t, undefined);
  assert.equal(freshness().readDataCollectedAt(dir), null);
});

test('readDataCollectedAt is null when summary.json is not valid JSON', (t) => {
  const dir = dataDir(t, `{"lastUpdated": "${STAMP}",`);
  assert.equal(freshness().readDataCollectedAt(dir), null);
});

test('readDataCollectedAt is null when summary.json has no lastUpdated', (t) => {
  const dir = dataDir(t, JSON.stringify({ repos: [], totals: {} }));
  assert.equal(freshness().readDataCollectedAt(dir), null);
});

test('readDataCollectedAt is null for a stamp with a non-UTC offset', (t) => {
  const dir = dataDir(t, JSON.stringify({ lastUpdated: '2026-11-16T08:05:47.696+02:00' }));
  assert.equal(freshness().readDataCollectedAt(dir), null);
});

test('readDataCollectedAt is null, without throwing, when summary.json cannot be read as a file', (t) => {
  const dir = dataDir(t, undefined);
  mkdirSync(join(dir, 'summary.json'));
  assert.equal(freshness().readDataCollectedAt(dir), null);
});

test('readDataCollectedAt is null, without throwing, when summary.json holds JSON null', (t) => {
  const dir = dataDir(t, 'null');
  assert.equal(freshness().readDataCollectedAt(dir), null);
});

/* ---------- dataFreshness ---------- */

test('the freshness bound is 30 hours', () => {
  assert.equal(freshness().FRESH_BOUND_HOURS, 30);
});

test('dataFreshness: data collected at this moment is fresh, 0 h', () => {
  assert.deepEqual(freshness().dataFreshness(STAMP, STAMP_MS), { state: 'fresh', ageHours: 0 });
});

test('dataFreshness: 29 h 59 min old is fresh, 29 h', () => {
  assert.deepEqual(freshness().dataFreshness(STAMP, STAMP_MS + 29 * HOUR + 59 * MINUTE), { state: 'fresh', ageHours: 29 });
});

test('dataFreshness: 30 h 59 min old is still fresh, 30 h', () => {
  assert.deepEqual(freshness().dataFreshness(STAMP, STAMP_MS + 30 * HOUR + 59 * MINUTE), { state: 'fresh', ageHours: 30 });
});

test('dataFreshness: 31 h 0 min old is stale, 31 h', () => {
  assert.deepEqual(freshness().dataFreshness(STAMP, STAMP_MS + 31 * HOUR), { state: 'stale', ageHours: 31 });
});

test('dataFreshness: a stamp 299 s ahead of the clock is fresh, 0 h', () => {
  assert.deepEqual(freshness().dataFreshness(STAMP, STAMP_MS - 299 * 1000), { state: 'fresh', ageHours: 0 });
});

test('dataFreshness: a stamp 301 s ahead of the clock is unknown', () => {
  assert.deepEqual(freshness().dataFreshness(STAMP, STAMP_MS - 301 * 1000), UNKNOWN);
});

test('dataFreshness: no stamp is unknown', () => {
  assert.deepEqual(freshness().dataFreshness(null, STAMP_MS), UNKNOWN);
});

test('dataFreshness: an unparsable stamp is unknown', () => {
  assert.deepEqual(freshness().dataFreshness('garbage', STAMP_MS), UNKNOWN);
});

/* ---------- dataDateLabel ---------- */

test('dataDateLabel: fresh data reads when it was collected', () => {
  // Read at 20:45:30Z over data collected at 06:05:47Z the same day.
  const now = Date.UTC(2026, 10, 16, 20, 45, 30, 393);
  assert.equal(freshness().dataDateLabel(STAMP, now), 'Data collected Nov 16, 06:05 UTC');
});

test('dataDateLabel: stale data reads its age in hours', () => {
  // A day like 2026-11-08: data collected on 2026-11-04 (the hour is illustrative), read at 07:30Z.
  const now = Date.UTC(2026, 10, 8, 7, 30, 0, 0);
  assert.equal(freshness().dataDateLabel('2026-11-04T06:05:47.696Z', now), 'Data is 97 h old (collected Nov 4, 06:05 UTC)');
});

test('dataDateLabel: data with no readable stamp reads as unknown', () => {
  assert.equal(freshness().dataDateLabel(null, STAMP_MS), 'Data date unknown');
  // An answer without the field at all reads the same way.
  assert.equal(freshness().dataDateLabel(undefined, STAMP_MS), 'Data date unknown');
});

/* ---------- fmtDate (the page's date format, shared with the label) ---------- */

test('fmtDate keeps the page date format', () => {
  assert.equal(freshness().fmtDate('2026-11-16'), 'Nov 16');
  assert.equal(freshness().fmtDate('2026-11-04'), 'Nov 4');
  assert.equal(freshness().fmtDate(''), '');
  assert.equal(freshness().fmtDate(null), '');
});
