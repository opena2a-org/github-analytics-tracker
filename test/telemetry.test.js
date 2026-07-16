const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeAdoptionFeed,
  toolDisplayName,
  toCount,
  classifyCollectionSkip,
  daysBetween,
} = require('../lib/telemetry');

const validFeed = () => ({
  generatedAt: '2026-07-02T12:00:00Z',
  provenance: 'anonymous first-party CLI telemetry; best-effort, not a sybil-verified count',
  retentionDays: 90,
  wauWindowDays: 7,
  mauWindowDays: 30,
  totalInstalls: 1200,
  wau: 300,
  mau: 800,
  engagedMau: 210,
  engagedMinDays: 2,
  tools: [
    {
      tool: 'hackmyagent', totalInstalls: 700, wau: 180, mau: 500, engagedMau: 140,
      versions: [{ version: '0.22.0', installs: 400 }, { version: '0.21.0', installs: 100 }],
    },
    { tool: 'opena2a', totalInstalls: 500, wau: 120, mau: 300, engagedMau: 90, versions: [] },
  ],
  byCountry: [{ countryCode: 'US', installs: 500 }, { countryCode: 'DE', installs: 120 }],
});

test('toolDisplayName maps known ids to product names, falls through otherwise', () => {
  assert.equal(toolDisplayName('hackmyagent'), 'HackMyAgent');
  assert.equal(toolDisplayName('hma'), 'HackMyAgent');
  assert.equal(toolDisplayName('opena2a'), 'OpenA2A CLI');
  assert.equal(toolDisplayName('ai-trust'), 'ai-trust');
  assert.equal(toolDisplayName('secretless-ai'), 'Secretless AI');
  assert.equal(toolDisplayName('HackMyAgent'.toLowerCase()), 'HackMyAgent');
  assert.equal(toolDisplayName('brand-new-cli'), 'brand-new-cli'); // never invented
  assert.equal(toolDisplayName(''), 'Unknown');
  assert.equal(toolDisplayName(null), 'Unknown');
});

test('toCount rejects non-finite, negative and non-number values', () => {
  assert.equal(toCount(5), 5);
  assert.equal(toCount(5.9), 5);
  assert.equal(toCount(0), 0);
  assert.equal(toCount(-1), null);
  assert.equal(toCount(NaN), null);
  assert.equal(toCount(Infinity), null);
  assert.equal(toCount('5'), null);
  assert.equal(toCount(undefined), null);
});

test('normalizeAdoptionFeed passes a valid feed through', () => {
  const n = normalizeAdoptionFeed(validFeed());
  assert.equal(n.totalInstalls, 1200);
  assert.equal(n.wau, 300);
  assert.equal(n.mau, 800);
  assert.equal(n.retentionDays, 90);
  assert.equal(n.tools.length, 2);
  assert.equal(n.tools[0].tool, 'hackmyagent');
  assert.equal(n.tools[0].versions.length, 2);
  assert.equal(n.byCountry.length, 2);
  // Provenance is carried verbatim so the dashboard can show it.
  assert.match(n.provenance, /not a sybil-verified count/);
  // Sybil-dampened floor carried through; per-tool too.
  assert.equal(n.engagedMau, 210);
  assert.equal(n.engagedMinDays, 2);
  assert.equal(n.tools[0].engagedMau, 140);
  assert.ok(n.engagedMau <= n.mau, 'engaged floor must be <= mau');
});

test('normalizeAdoptionFeed defaults provenance + engagedMau when absent (never fabricated)', () => {
  const n = normalizeAdoptionFeed({ totalInstalls: 10, wau: 5, mau: 8 });
  assert.equal(n.provenance, '');
  assert.equal(n.engagedMau, 0); // absent → 0, not invented
  assert.equal(n.tools.length, 0);
});

test('normalizeAdoptionFeed throws on a non-object or missing fleet totals', () => {
  assert.throws(() => normalizeAdoptionFeed(null));
  assert.throws(() => normalizeAdoptionFeed('nope'));
  assert.throws(() => normalizeAdoptionFeed({ wau: 1, mau: 1 })); // no totalInstalls
  assert.throws(() => normalizeAdoptionFeed({ totalInstalls: -1, wau: 1, mau: 1 })); // negative
});

test('normalizeAdoptionFeed drops untrusted rows rather than zeroing them', () => {
  const feed = validFeed();
  feed.tools.push({ tool: 'broken', totalInstalls: 'x', wau: 1, mau: 1 }); // invalid count
  feed.tools.push({ totalInstalls: 1, wau: 1, mau: 1 }); // missing tool id
  feed.tools[0].versions.push({ version: 'bad', installs: -5 }); // invalid install count
  feed.byCountry.push({ countryCode: '', installs: 5 }); // empty code
  const n = normalizeAdoptionFeed(feed);
  // Only the two originally-valid tools survive.
  assert.equal(n.tools.length, 2);
  assert.ok(!n.tools.some(t => t.tool === 'broken'));
  // The invalid version was dropped, the two good ones remain.
  assert.equal(n.tools[0].versions.length, 2);
  // The empty-code country was dropped.
  assert.equal(n.byCountry.length, 2);
});

test('normalizeAdoptionFeed tolerates missing optional arrays', () => {
  const n = normalizeAdoptionFeed({ totalInstalls: 10, wau: 5, mau: 8 });
  assert.deepEqual(n.tools, []);
  assert.deepEqual(n.byCountry, []);
  assert.equal(n.generatedAt, '');
});

// --- classifyCollectionSkip ------------------------------------------------
//
// Regression guard for the incident this logic exists to prevent: the collector
// had three separate silent `exit 0` paths, so registry #283 dropped live CLI
// telemetry for ~7 days (2026-06-26 -> 2026-07-03) with nothing in the logs
// saying so. Silence is not success.

const skip = (o) => classifyCollectionSkip({ reason: 'feed fetch failed: HTTP 404', today: '2026-07-16', ...o });

test('unconfigured and never collected: warns, does not fail the workflow', () => {
  const r = skip({ registryUrlSet: false, lastSuccessDate: null });
  assert.equal(r.level, 'warning');
  assert.equal(r.exitCode, 0);
  assert.match(r.message, /not configured/i);
  assert.match(r.message, /REGISTRY_URL/);
});

test('variable removed after it once worked: errors immediately', () => {
  // Config being deleted is not a transient blip — no staleness grace.
  const r = skip({ registryUrlSet: false, lastSuccessDate: '2026-07-15' });
  assert.equal(r.level, 'error');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /2026-07-15/);
});

test('configured but never succeeded: errors (broken feed, not unprovisioned)', () => {
  const r = skip({ registryUrlSet: true, lastSuccessDate: null });
  assert.equal(r.level, 'error');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /NEVER succeeded/i);
});

test('a single failed run is transient: warns, keeps yesterday data', () => {
  const r = skip({ registryUrlSet: true, lastSuccessDate: '2026-07-15' });
  assert.equal(r.level, 'warning');
  assert.equal(r.exitCode, 0);
  assert.match(r.message, /1d ago/);
});

test('at the staleness threshold: still tolerated', () => {
  const r = skip({ registryUrlSet: true, lastSuccessDate: '2026-07-14', staleAfterDays: 2 });
  assert.equal(r.level, 'warning');
  assert.equal(r.exitCode, 0);
});

test('past the staleness threshold: errors as an outage', () => {
  const r = skip({ registryUrlSet: true, lastSuccessDate: '2026-07-13', staleAfterDays: 2 });
  assert.equal(r.level, 'error');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /3 days/);
  assert.match(r.message, /outage/i);
});

test('the #283 shape: a 7-day gap fails loudly instead of exiting 0', () => {
  // 2026-06-26 -> 2026-07-03 went unnoticed. It must not be possible again.
  const r = classifyCollectionSkip({
    reason: 'feed fetch failed: HTTP 404',
    registryUrlSet: true,
    lastSuccessDate: '2026-06-26',
    today: '2026-07-03',
  });
  assert.equal(r.level, 'error');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /7 days/);
});

test('the reason is always carried into the message', () => {
  const r = classifyCollectionSkip({
    reason: 'feed failed validation: totalInstalls is not a number',
    registryUrlSet: true,
    lastSuccessDate: '2026-07-01',
    today: '2026-07-16',
  });
  assert.match(r.message, /totalInstalls is not a number/);
});

test('an unparseable last-success date errors rather than passing silently', () => {
  const r = skip({ registryUrlSet: true, lastSuccessDate: 'not-a-date' });
  assert.equal(r.level, 'error');
  assert.equal(r.exitCode, 1);
});

test('every classification returns a usable exit code and a non-empty message', () => {
  const cases = [
    { registryUrlSet: false, lastSuccessDate: null },
    { registryUrlSet: false, lastSuccessDate: '2026-07-15' },
    { registryUrlSet: true, lastSuccessDate: null },
    { registryUrlSet: true, lastSuccessDate: '2026-07-15' },
    { registryUrlSet: true, lastSuccessDate: '2026-06-01' },
  ];
  for (const c of cases) {
    const r = skip(c);
    assert.ok(r.exitCode === 0 || r.exitCode === 1, JSON.stringify(c));
    assert.ok(r.level === 'warning' || r.level === 'error', JSON.stringify(c));
    assert.ok(r.message.length > 0, JSON.stringify(c));
    // An error must never exit 0: that is the bug this whole change is about.
    if (r.level === 'error') assert.equal(r.exitCode, 1, JSON.stringify(c));
  }
});

test('daysBetween handles ordinary and malformed input', () => {
  assert.equal(daysBetween('2026-07-01', '2026-07-16'), 15);
  assert.equal(daysBetween('2026-07-16', '2026-07-16'), 0);
  assert.equal(daysBetween('garbage', '2026-07-16'), null);
});
