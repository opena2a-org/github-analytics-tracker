/**
 * The floor on first-party telemetry counts.
 *
 * A count under ten is withheld, zero included. It is stored and served as
 * null, and a person reads WITHHELD_LABEL where the number would be. Zero
 * takes the label too: if 0 were shown and only one to nine were withheld,
 * the label would mean "at least one".
 *
 * The label is never a number. A withheld figure is never shown as 0, never
 * sorted as if it held a value, and never added into a figure the page
 * computes.
 *
 * Pure: no db, no network, no clock. Shared by the collector, the API route,
 * the dashboard, the summary and the store cleaning step.
 */

const WITHHELD_FLOOR = 10;
const WITHHELD_LABEL = 'fewer than 10';
const WITHHELD_NOTE = 'Figures under ten are withheld, zero included.';

// Served beside the figures so a null reads as withheld, not as missing.
const WITHHELD = Object.freeze({ below: WITHHELD_FLOOR, label: WITHHELD_LABEL });

/**
 * A count at or above the floor, or null. Null, a count from 0 to 9, and
 * anything that is not a finite number all come out as null.
 */
function floorCount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n >= WITHHELD_FLOOR ? n : null;
}

/** The text a person reads for a count: the number, or the withheld label. */
function formatTelemetryCount(v) {
  const n = floorCount(v);
  return n === null ? WITHHELD_LABEL : n.toLocaleString();
}

/**
 * Comparator for rows ordered by a count, largest first. A row whose count is
 * withheld follows every measured row, and withheld rows are ordered by `key`
 * alone: their place says nothing about the count they hide. Ties on a
 * measured count are ordered by `key` too.
 */
function byMeasuredDesc(field, key) {
  const byKey = (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
  return (a, b) => {
    const x = floorCount(a[field]);
    const y = floorCount(b[field]);
    if (x === null && y === null) return byKey(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x || byKey(a, b);
  };
}

/**
 * The version with the most installs among those with a measured count, or
 * null when every version's count is withheld. A withheld version is never
 * named as the top one.
 */
function topMeasuredVersion(versions) {
  let top = null;
  for (const v of Array.isArray(versions) ? versions : []) {
    const n = floorCount(v && v.installs);
    if (n !== null && (top === null || n > top.installs)) top = { version: v.version, installs: n };
  }
  return top;
}

/** The provenance text with the withheld note added once. */
function withWithheldNote(text) {
  const base = typeof text === 'string' ? text.trim() : '';
  if (base.includes(WITHHELD_NOTE)) return base;
  return base ? `${base} ${WITHHELD_NOTE}` : WITHHELD_NOTE;
}

module.exports = {
  WITHHELD,
  WITHHELD_FLOOR,
  WITHHELD_LABEL,
  WITHHELD_NOTE,
  byMeasuredDesc,
  floorCount,
  formatTelemetryCount,
  topMeasuredVersion,
  withWithheldNote,
};
