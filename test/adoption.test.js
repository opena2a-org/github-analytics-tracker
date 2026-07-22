const { test } = require('node:test');
const assert = require('node:assert');
const { periodPick, hfPeriod, sumAdoption, rowAdoption } = require('../lib/adoption');

/*
 * The whole point of this module: adoption counts UNIQUE CLONERS, never raw
 * git-clone count. "Unique cloners" here is GitHub's 14-day DEDUPLICATED count
 * (recentUniqueCloners / clones_uniques) — a period-independent snapshot — NOT a
 * sum of per-day uniques (which would count a cloner once per active day and
 * re-inflate the very noise this removes). hackmyagent: ~71,000 raw clones and
 * ~2,000/day from 5-10 actors, but only ~69 distinct cloners over 14 days.
 * If a future edit wires raw clones (or cloner-days) back into adoption, these fail.
 */

// A product whose raw clone count is enormous but whose deduped unique-cloner
// count is tiny — the exact hackmyagent shape.
function hmaShaped() {
  return {
    github: {
      clones: 71077, clones30d: 31231, clones7d: 14000, clones24h: 2135, customClones: 999,
      cloneUniques: 69, // 14-day deduplicated distinct cloners (snapshot)
    },
    npm: { allTimeDownloads: 27731, last30Downloads: 1976, last7Downloads: 400, last24hDownloads: 50, customDownloads: 12 },
    pypi: {}, docker: { totalPulls: 0 }, hf: null,
  };
}

test('adoption uses deduped unique cloners, NOT raw clone count (30d)', () => {
  const p = hmaShaped();
  // 30d: cloneUniques(69) + npm last30(1976) = 2045. Raw 31231 must not appear.
  assert.equal(rowAdoption(p, '30d'), 69 + 1976);
  assert.notEqual(rowAdoption(p, '30d'), 31231 + 1976, 'raw clone count leaked into adoption');
});

test('the cloner term is a 14-day snapshot, identical under every period', () => {
  const p = hmaShaped();
  // Only the install term (npm) re-windows; the cloner term stays 69 everywhere.
  assert.equal(rowAdoption(p, '24h') - 50, 69, '24h cloner term is the 14d snapshot');
  assert.equal(rowAdoption(p, '7d') - 400, 69, '7d cloner term is the 14d snapshot');
  assert.equal(rowAdoption(p, '30d') - 1976, 69, '30d cloner term is the 14d snapshot');
  assert.equal(rowAdoption(p, 'all') - 27731, 69, 'all-time cloner term is the 14d snapshot');
  assert.equal(rowAdoption(p, 'custom') - 12, 69, 'custom cloner term is the 14d snapshot');
});

test('a pure re-clone loop (huge clones, tiny deduped cloners) adds ~nothing', () => {
  // 100k raw clones but the same single actor -> deduped uniques ~1. Adoption must
  // not move with the raw count, and must NOT scale with active days either.
  const looped = { github: { clones30d: 100000, clones: 500000, cloneUniques: 1 }, npm: {}, pypi: {}, docker: {}, hf: null };
  assert.equal(rowAdoption(looped, '30d'), 1, 'a re-clone loop must not inflate adoption');
  assert.equal(rowAdoption(looped, 'all'), 1, 'nor over all-time');
});

test('sumAdoption is cloners + installs and ignores raw clone count entirely', () => {
  // It has no `clones` input by construction — the only clone term is cloneUniques.
  assert.equal(sumAdoption({ cloneUniques: 10, npm: 5, pypi: 3, docker: 2, hf: 1 }), 21);
  assert.equal(sumAdoption({}), 0);
  assert.equal(sumAdoption({ npm: 7 }), 7);
});

test('docker and HF only count under all-time (unchanged behavior)', () => {
  const p = { github: { cloneUniques: 5 }, npm: {}, pypi: {}, docker: { totalPulls: 400 }, hf: { downloadsAllTime: 100, downloads30d: 10 } };
  assert.equal(rowAdoption(p, '30d'), 5 + 10, '30d includes HF 30d but not docker');
  assert.equal(rowAdoption(p, 'all'), 5 + 400 + 100, 'all includes docker pulls + HF all-time');
});

test('periodPick maps windows to the right field', () => {
  const o = { a: 1, k30: 2, k7: 3, k24: 4, kc: 5 };
  assert.equal(periodPick(o, 'a', 'k30', 'k7', 'k24', '24h', 'kc'), 4);
  assert.equal(periodPick(o, 'a', 'k30', 'k7', 'k24', '7d', 'kc'), 3);
  assert.equal(periodPick(o, 'a', 'k30', 'k7', 'k24', '30d', 'kc'), 2);
  assert.equal(periodPick(o, 'a', 'k30', 'k7', 'k24', 'custom', 'kc'), 5);
  assert.equal(periodPick(o, 'a', 'k30', 'k7', 'k24', 'all', 'kc'), 1);
  assert.equal(periodPick(null, 'a', 'k30', 'k7', 'k24', '30d', 'kc'), 0, 'missing object -> 0');
});

test('hfPeriod only reports all-time and 30d', () => {
  const hf = { downloadsAllTime: 100, downloads30d: 10 };
  assert.equal(hfPeriod(hf, 'all'), 100);
  assert.equal(hfPeriod(hf, '30d'), 10);
  assert.equal(hfPeriod(hf, '7d'), null);
  assert.equal(hfPeriod(null, 'all'), null);
});
