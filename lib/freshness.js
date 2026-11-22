/**
 * When the dashboard's data was collected, and whether that still reads as
 * current. Shared by the API (pages/api/overview.js, server) and the dashboard
 * (pages/index.js, client) so the stamp is read and judged one way.
 *
 * The stamp is the lastUpdated field of data/summary.json, written by each
 * collection run as an ISO 8601 UTC time. A date taken from the moment the
 * page or the API answered would read as today whatever the age of the data.
 */

/* Data older than this many whole hours reads as stale. */
const FRESH_BOUND_HOURS = 30;

/* A stamp up to this far ahead of the reader's clock is clock skew and reads
 * as 0 h old; further ahead it cannot be trusted and reads as unknown. */
const AHEAD_TOLERANCE_MS = 300 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/* ISO 8601 UTC, e.g. 2026-11-16T06:05:47.696Z (fraction optional, 1 to 9 digits). */
const STAMP_FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;

/* The page's date format for a YYYY-MM-DD day: "Nov 16". */
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The lastUpdated stamp of <dataDir>/summary.json when it is in ISO 8601 UTC
 * form; null when the file is absent or unreadable, is not JSON, has no such
 * key, or holds another form. Never throws.
 */
function readDataCollectedAt(dataDir) {
  try {
    // The page bundles this module too, so fs and path are loaded when this
    // runs (on the server, Node 24 per package.json engines) instead of being
    // required at the top, which would pull Node built-ins into the browser.
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const summary = JSON.parse(fs.readFileSync(path.join(dataDir, 'summary.json'), 'utf8'));
    const stamp = summary !== null && typeof summary === 'object' ? summary.lastUpdated : undefined;
    return typeof stamp === 'string' && STAMP_FORM.test(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

/* Milliseconds since the epoch for a stamp in STAMP_FORM, else null. Parsed by
 * hand so every browser reads it alike (engines differ on fractions longer
 * than 3 digits) and a calendar-impossible value such as 2026-02-30T00:00:00Z
 * is null instead of rolling over into March. */
function parseStamp(stamp) {
  if (typeof stamp !== 'string') return null;
  const m = STAMP_FORM.exec(stamp);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Number(m[7].slice(1, 4).padEnd(3, '0')) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) {
    return null;
  }
  return t;
}

/**
 * { state, ageHours } for data collected at `dataCollectedAt`, read at `nowMs`.
 * 'unknown' (ageHours null) when there is no parsable stamp or it is more than
 * 300 s ahead of nowMs. Otherwise ageHours is the whole hours since collection
 * (0 when the stamp is up to 300 s ahead), and the state is 'stale' past
 * FRESH_BOUND_HOURS, else 'fresh'.
 */
function dataFreshness(dataCollectedAt, nowMs) {
  const t = parseStamp(dataCollectedAt);
  if (t === null || !Number.isFinite(nowMs) || t - nowMs > AHEAD_TOLERANCE_MS) {
    return { state: 'unknown', ageHours: null };
  }
  const ageHours = Math.max(0, Math.floor((nowMs - t) / HOUR_MS));
  return { state: ageHours > FRESH_BOUND_HOURS ? 'stale' : 'fresh', ageHours };
}

/**
 * The dashboard's text for data collected at `dataCollectedAt`, read at `nowMs`:
 *   fresh    Data collected Nov 16, 06:05 UTC
 *   stale    Data is 97 h old (collected Nov 4, 06:05 UTC)
 *   unknown  Data date unknown
 */
function dataDateLabel(dataCollectedAt, nowMs) {
  const { state, ageHours } = dataFreshness(dataCollectedAt, nowMs);
  if (state === 'unknown') return 'Data date unknown';
  const iso = new Date(parseStamp(dataCollectedAt)).toISOString();
  const collected = `${fmtDate(iso.slice(0, 10))}, ${iso.slice(11, 16)} UTC`;
  return state === 'stale' ? `Data is ${ageHours} h old (collected ${collected})` : `Data collected ${collected}`;
}

module.exports = { FRESH_BOUND_HOURS, fmtDate, readDataCollectedAt, dataFreshness, dataDateLabel };
