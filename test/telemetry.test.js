const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeAdoptionFeed,
  toolDisplayName,
  toCount,
  classifyCollectionSkip,
  classifyFeedHealth,
  sanitizeForLog,
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
// Covers the collector failing to RETRIEVE the feed. Note what this does NOT
// cover: a feed that answers 200 with collapsed numbers. That is the shape a
// broken ingest actually takes, and it is classifyFeedHealth's job — see the
// zero-collapse block further down.

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
  assert.match(r.message, /3 day/);
  assert.match(r.message, /outage/i);
});

test('a week-long retrieval gap fails loudly instead of exiting 0', () => {
  const r = classifyCollectionSkip({
    reason: 'feed fetch failed: HTTP 404',
    registryUrlSet: true,
    lastSuccessDate: '2026-06-26',
    today: '2026-07-03',
  });
  assert.equal(r.level, 'error');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /7 day/);
});

test('a FUTURE last-success date errors instead of disabling escalation forever', () => {
  // age < 0 never exceeds the threshold, so a single skewed/corrupt row would
  // otherwise pin this to "warning" permanently — silently undoing the whole point.
  const r = skip({ registryUrlSet: true, lastSuccessDate: '2026-08-20' });
  assert.equal(r.level, 'error');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /FUTURE/);
  assert.doesNotMatch(r.message, /-\d+d ago/); // the old nonsense phrasing
});

test('an unreadable store is reported as UNKNOWN, not as "never succeeded"', () => {
  // Conflating these asserts a specific false claim and points the operator at
  // the feed when the fault is the database.
  const r = skip({
    registryUrlSet: true,
    lastSuccess: { state: 'unknown', detail: 'database disk image is malformed' },
  });
  assert.equal(r.level, 'error');
  assert.match(r.message, /UNKNOWN/);
  assert.match(r.message, /malformed/);
  assert.doesNotMatch(r.message, /never succeeded/i);
});

test('staleAfterDays rejects junk rather than silently tightening the tolerance', () => {
  // Number('') === 0, so `${{ vars.UNSET }}` would otherwise error on the first blip.
  for (const bad of ['', ' ', 'abc', '-1', '2.5', NaN, Infinity, null, undefined]) {
    const r = skip({ registryUrlSet: true, lastSuccessDate: '2026-07-15', staleAfterDays: bad });
    assert.equal(r.level, 'warning', `staleAfterDays=${JSON.stringify(bad)} should fall back to the default`);
  }
  // A real value is still honored.
  assert.equal(skip({ registryUrlSet: true, lastSuccessDate: '2026-07-13', staleAfterDays: 5 }).level, 'warning');
  assert.equal(skip({ registryUrlSet: true, lastSuccessDate: '2026-07-13', staleAfterDays: 1 }).level, 'error');
});

// --- log-injection boundary -------------------------------------------------
//
// The HTTP error path embeds up to 200 bytes of the registry's raw response body
// into the message, which reaches BOTH an ::annotation:: on stdout and a
// console.error on stderr. The runner scans both for workflow commands, so
// untrusted bytes there can forge or suppress the very outage signal this module
// raises.

test('sanitizeForLog collapses every line terminator, including a lone CR', () => {
  // A bare \r is the one that /\r?\n/ misses: .NET line readers break on it.
  assert.equal(sanitizeForLog('a\rb'), 'a b');
  assert.equal(sanitizeForLog('a\nb'), 'a b');
  assert.equal(sanitizeForLog('a\r\nb'), 'a  b');
  assert.equal(sanitizeForLog("a\u2028b"), "a b");
  assert.equal(sanitizeForLog("a\u2029b"), "a b");
  assert.equal(sanitizeForLog("a\u0085b"), "a b");
});

test('sanitizeForLog defangs the workflow-command sigil', () => {
  assert.doesNotMatch(sanitizeForLog('x::add-mask::secret'), /::/);
});

test('a hostile feed body cannot inject a workflow command into the message', () => {
  const hostile = 'HTTP 500: x\r::add-mask::0\r::stop-commands::deadbeef';
  const r = classifyCollectionSkip({
    reason: `feed fetch failed: ${hostile}`,
    registryUrlSet: true,
    lastSuccessDate: '2026-07-15',
    today: '2026-07-16',
  });
  // Nothing that could start a new line, and no sigil left to start one with.
  assert.ok(!/[\r\n\u2028\u2029\u0085]/.test(r.message), "message must be single-line");
  assert.doesNotMatch(r.message, /::/);
  // The command names may survive as inert text; what must not survive is a
  // `::` that could begin a workflow command.
  assert.doesNotMatch(r.message, /::add-mask::/);
  assert.doesNotMatch(r.message, /::stop-commands::/);
});

test('the message is bounded so a 200-byte body cannot flood the annotation', () => {
  const r = classifyCollectionSkip({
    reason: `feed fetch failed: ${'A'.repeat(5000)}`,
    registryUrlSet: true,
    lastSuccessDate: '2026-07-15',
    today: '2026-07-16',
  });
  assert.ok(r.message.length <= 520, `message length ${r.message.length}`);
});

// --- classifyFeedHealth (the zero-collapse detector) -------------------------
//
// This is the failure a retrieval check structurally cannot see, and the one a
// broken ingest actually produces: the adoption feed answers 200 with valid,
// all-zero numbers. normalizeAdoptionFeed accepts them (correctly — they are
// well-formed), persist() writes them, and lastSuccessDate advances, so
// classifyCollectionSkip is never even called.

test('a live fleet collapsing to zero is reported as an outage', () => {
  const r = classifyFeedHealth({ mau: 0, totalInstalls: 0 }, { mau: 200, totalInstalls: 500 });
  assert.ok(r, 'a drop from 200 MAU to 0 must not pass silently');
  assert.equal(r.level, 'error');
  assert.match(r.message, /200/);
  assert.match(r.message, /do not all disappear overnight/i);
});

test('healthy numbers report nothing', () => {
  assert.equal(classifyFeedHealth({ mau: 200, totalInstalls: 500 }, { mau: 190, totalInstalls: 480 }), null);
});

test('a real decline is not an outage — only a total collapse is', () => {
  assert.equal(classifyFeedHealth({ mau: 1, totalInstalls: 1 }, { mau: 200, totalInstalls: 500 }), null);
});

test('no previous snapshot means nothing to compare against', () => {
  assert.equal(classifyFeedHealth({ mau: 0, totalInstalls: 0 }, null), null);
});

test('zero following zero is not a collapse (nothing to fall from)', () => {
  assert.equal(classifyFeedHealth({ mau: 0, totalInstalls: 0 }, { mau: 0, totalInstalls: 0 }), null);
});

test('installs surviving while MAU zeroes is not yet a collapse', () => {
  // Only a total collapse of both is unambiguous; MAU alone could be real churn.
  assert.equal(classifyFeedHealth({ mau: 0, totalInstalls: 500 }, { mau: 200, totalInstalls: 500 }), null);
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
