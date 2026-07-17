/**
 * First-party CLI telemetry helpers.
 *
 * The Registry exposes an anonymous, coarse adoption projection at
 * GET /api/v1/telemetry/v1/adoption/public. These are ACTIVE USERS (distinct
 * install_id over rolling windows) — not downloads. A download is not a user,
 * so telemetry is always shown distinctly and NEVER summed into the download
 * "adoption" total (same rule as Chrome Web Store weekly-active users).
 *
 * This module holds the pure, network-free, db-free logic (feed validation +
 * tool→product attribution) so it can be unit-tested without a live Registry or
 * a SQLite file. The collector and the API routes import it.
 */

// Registry tool-id → dashboard product display name. Mirrors the product names
// used in pages/api/overview.js productMap so the same tool reads consistently
// across the download and active-user surfaces. Unknown ids fall through to the
// raw id (never invented) so a new CLI shows up rather than vanishing.
const TOOL_PRODUCT_NAMES = {
  hackmyagent: 'HackMyAgent',
  hma: 'HackMyAgent',
  opena2a: 'OpenA2A CLI',
  'opena2a-cli': 'OpenA2A CLI',
  'ai-trust': 'ai-trust',
  aitrust: 'ai-trust',
  secretless: 'Secretless AI',
  'secretless-ai': 'Secretless AI',
  aim: 'AIM',
  nanomind: 'NanoMind',
};

function toolDisplayName(toolId) {
  if (typeof toolId !== 'string' || toolId === '') return 'Unknown';
  return TOOL_PRODUCT_NAMES[toolId.toLowerCase()] || toolId;
}

// Strict non-negative integer coercion. Returns null for anything that is not a
// finite number >= 0, so validation can reject a malformed feed rather than
// silently persisting NaN/garbage as a real measurement.
function toCount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.trunc(v);
}

/**
 * Validate + normalize the Registry public adoption feed into the shape the
 * collector persists. Throws on a structurally invalid payload — an empty field
 * is better than a fabricated one, and a bad feed must not overwrite good data
 * with zeros. Every numeric field is measured by the Registry; we only coerce
 * types and drop rows we cannot trust.
 *
 * @param {object} feed parsed JSON from the public adoption endpoint
 * @returns {{generatedAt:string, retentionDays:number, wauWindowDays:number,
 *   mauWindowDays:number, totalInstalls:number, wau:number, mau:number,
 *   tools:Array, byCountry:Array}}
 */
function normalizeAdoptionFeed(feed) {
  if (!feed || typeof feed !== 'object') {
    throw new Error('adoption feed is not an object');
  }
  const totalInstalls = toCount(feed.totalInstalls);
  const wau = toCount(feed.wau);
  const mau = toCount(feed.mau);
  if (totalInstalls === null || wau === null || mau === null) {
    throw new Error('adoption feed missing/invalid fleet totals (totalInstalls/wau/mau)');
  }

  const tools = [];
  for (const t of Array.isArray(feed.tools) ? feed.tools : []) {
    if (!t || typeof t.tool !== 'string' || t.tool === '') continue;
    const ti = toCount(t.totalInstalls);
    const tw = toCount(t.wau);
    const tm = toCount(t.mau);
    if (ti === null || tw === null || tm === null) continue; // skip untrusted row, don't zero it
    // engagedMau is the sybil-dampened floor; older feeds may omit it → default 0.
    const teng = toCount(t.engagedMau) ?? 0;
    const versions = [];
    for (const v of Array.isArray(t.versions) ? t.versions : []) {
      if (!v || typeof v.version !== 'string' || v.version === '') continue;
      const vi = toCount(v.installs);
      if (vi === null) continue;
      versions.push({ version: v.version, installs: vi });
    }
    tools.push({ tool: t.tool, totalInstalls: ti, wau: tw, mau: tm, engagedMau: teng, versions });
  }

  const byCountry = [];
  for (const c of Array.isArray(feed.byCountry) ? feed.byCountry : []) {
    if (!c || typeof c.countryCode !== 'string' || c.countryCode === '') continue;
    const ci = toCount(c.installs);
    if (ci === null) continue;
    byCountry.push({ countryCode: c.countryCode, installs: ci });
  }

  return {
    generatedAt: typeof feed.generatedAt === 'string' ? feed.generatedAt : '',
    // Honest basis + limits, carried verbatim from the feed so the dashboard can
    // show it rather than presenting these unauthenticated-ingest counts as a
    // verified metric. Never fabricated — empty when the feed omits it.
    provenance: typeof feed.provenance === 'string' ? feed.provenance : '',
    retentionDays: toCount(feed.retentionDays) ?? 0,
    wauWindowDays: toCount(feed.wauWindowDays) ?? 0,
    mauWindowDays: toCount(feed.mauWindowDays) ?? 0,
    totalInstalls,
    wau,
    mau,
    // Sybil-dampened floor (installs with a real multi-day footprint). The
    // honest, defensible headline; raw wau/mau are shown as context. Default 0
    // for older feeds that predate the field.
    engagedMau: toCount(feed.engagedMau) ?? 0,
    engagedMinDays: toCount(feed.engagedMinDays) ?? 0,
    tools,
    byCountry,
  };
}

// Consecutive days a collection may fail before it stops being "transient" and
// becomes an outage worth failing on. Two days tolerates a single bad run plus a
// retry; anything longer is a real gap in the data.
const DEFAULT_STALE_AFTER_DAYS = 2;

function daysBetween(fromISODate, toISODate) {
  const from = Date.parse(`${fromISODate}T00:00:00Z`);
  const to = Date.parse(`${toISODate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}

// The GitHub Actions runner scans BOTH stdout and stderr for `::command::`
// lines, so any untrusted text reaching a log line can forge or suppress
// workflow commands.
//
// A lone \r matters. .NET line readers break on \r, \n AND \r\n, so /\r?\n/ is
// not enough - a bare CR starts a new line by itself.
//
// Not hypothetical here: the HTTP error path embeds up to 200 bytes of the
// registry raw response body, and a JSON parse error echoes body bytes even on
// a 200 response. A compromised or MITM-d registry (httpGetJson permits http:)
// could otherwise emit an add-mask or stop-commands directive and suppress the
// very outage annotation this module exists to raise.
//
// Written as escapes on purpose: pasting the raw characters in makes `file` and
// `grep` classify this source as binary data. U+2028/U+2029/U+0085 are NOT .NET
// line terminators and cannot inject on their own - they are collapsed anyway
// because they render as breaks in some viewers and have no business on a log
// line.
const LOG_UNSAFE = /[\r\n\u2028\u2029\u0085]/g;

/**
 * Make untrusted text safe to place on a log line.
 * Collapses every line terminator and defangs the `::` command sigil.
 */
function sanitizeForLog(value, maxLength = 300) {
  const flat = String(value ?? '').replace(LOG_UNSAFE, ' ');
  // A workflow command must start the line, but defanging `::` costs nothing
  // and removes the class rather than reasoning about column positions.
  const defanged = flat.replace(/::/g, "__");
  return defanged.length > maxLength ? `${defanged.slice(0, maxLength)}...` : defanged;
}

/**
 * Decide how loudly a skipped/failed telemetry collection should complain.
 *
 * Why this exists: the collector had three separate silent `exit 0` paths — an
 * unset REGISTRY_URL, a failed fetch, and a failed validation. Each was
 * individually defensible (don't fail the daily workflow; don't write zeros
 * over a good snapshot), but together they made a broken collector look exactly
 * like a healthy no-op. Silence is not success.
 *
 * Scope, stated honestly: this catches the collector failing to RETRIEVE the
 * feed. It does NOT catch the feed being served successfully with wrong or
 * collapsed numbers — that is `classifyFeedHealth` below, and it is the shape a
 * broken ingest actually takes.
 *
 * The rule: a single failed run is transient and warns. A sustained one is an
 * outage and fails. Losing the variable after it once worked is a regression
 * and fails immediately — that is config being removed, not a flaky endpoint.
 *
 * Pure: no db, no network, no clock. The caller supplies `today` and the last
 * known-good snapshot so this is deterministic and testable.
 *
 * @param {object} o
 * @param {string} o.reason cause, echoed into the message (untrusted: may carry
 *   registry response bytes, so the returned message is always sanitized)
 * @param {boolean} o.registryUrlSet whether REGISTRY_URL is configured
 * @param {{state:'known'|'never'|'unknown', date?:string}|string|null}
 *   o.lastSuccess newest stored snapshot. `unknown` means the store could not be
 *   read — which is NOT the same as "never collected" and must not be reported
 *   as it. A bare string/null is accepted for convenience and mapped to
 *   known/never.
 * @param {string} o.today YYYY-MM-DD
 * @param {number} [o.staleAfterDays]
 * @returns {{level:'warning'|'error', exitCode:0|1, message:string}}
 */
function classifyCollectionSkip({
  reason,
  registryUrlSet,
  lastSuccess,
  lastSuccessDate,
  today,
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
}) {
  // Accept the older bare-date/null shape so callers and tests can use either.
  const last = normalizeLastSuccess(lastSuccess !== undefined ? lastSuccess : lastSuccessDate);
  const tolerance = normalizeStaleAfterDays(staleAfterDays);
  const why = sanitizeForLog(reason);

  const out = (level, message) => ({
    level,
    exitCode: level === 'error' ? 1 : 0,
    message: sanitizeForLog(message, 500),
  });

  if (last.state === 'unknown') {
    // The store is unreadable (corrupt / locked / permission denied). We cannot
    // tell a first run from a seven-day outage, so say exactly that rather than
    // asserting a specific false diagnosis.
    return out(
      'error',
      `Telemetry collection failed: ${why}. Additionally, the snapshot store could not be read ` +
        `(${last.detail || 'unknown error'}), so how long this has been failing is UNKNOWN.`
    );
  }

  if (!registryUrlSet) {
    if (last.state === 'never') {
      // Never configured: legitimately optional. Erroring every day before the
      // endpoint is provisioned would train everyone to ignore the annotation.
      return out(
        'warning',
        'Telemetry collection is not configured: REGISTRY_URL is unset and no snapshot has ever ' +
          'been stored. Set the REGISTRY_URL repo variable to enable it.'
      );
    }
    // It worked before and the variable is gone. Config removed, not a blip.
    return out(
      'error',
      `REGISTRY_URL is unset but telemetry was collected as recently as ${last.date}. ` +
        'The variable was removed or lost; collection has stopped.'
    );
  }

  if (last.state === 'never') {
    // Configured deliberately, yet nothing has ever landed. Broken setup.
    return out(
      'error',
      `Telemetry collection failed and has never succeeded: ${why}. REGISTRY_URL is set, so this ` +
        'is a broken feed or a wrong URL, not an unprovisioned one.'
    );
  }

  const age = daysBetween(last.date, today);
  if (age === null) {
    return out('error', `Telemetry collection failed: ${why}. Last-success date ${last.date} is unparseable.`);
  }

  if (age < 0) {
    // A future snapshot date means clock skew or a bad row. Left alone this
    // silently disables escalation forever (a negative age never exceeds the
    // threshold), which defeats the entire point of this function.
    return out(
      'error',
      `Telemetry collection failed: ${why}. The last-success date ${last.date} is ${-age} day(s) in ` +
        `the FUTURE relative to ${today} — clock skew or a corrupt row. Staleness cannot be judged.`
    );
  }

  if (age > tolerance) {
    return out(
      'error',
      `Telemetry collection has failed for ${age} day(s) (last good snapshot ${last.date}): ${why}. ` +
        'This is an outage, not a blip — the dashboard is serving stale active-user numbers.'
    );
  }

  return out(
    'warning',
    `Telemetry collection skipped: ${why}. Last good snapshot ${last.date} (${age}d ago); ` +
      `tolerating up to ${tolerance}d before this becomes an error.`
  );
}

/**
 * Catch the failure a retrieval check structurally cannot see: the feed answers
 * 200 with a well-formed payload whose active-user counts have drained to zero.
 *
 * This is what a broken ingest looks like from here, and it is why the retrieval
 * check above is not sufficient alone. Registry #283 (2026-06-26) moved the
 * ingest route and CLIs silently stopped POSTing for ~7 days; the adoption feed
 * this collector reads is a different endpoint and was unaffected, so it would
 * have kept answering 200 while the counts drained. (Stated as the mechanism,
 * not an observation — this collector was written 2026-07-02, after the gap, so
 * nothing here watched it happen.)
 *
 * Two things this gets right that the obvious version does not:
 *
 * 1. It keys on MAU alone, NOT on "mau AND installs are both zero". Those are
 *    different windows — `total_installs` is distinct installs over the 90-day
 *    retention, `mau` is 30 days (see setup-database.js). When ingest breaks,
 *    MAU hits zero at T+30 while installs bleeds down until T+90. Requiring both
 *    would wave through ~60 days of "zero monthly actives against a live install
 *    base" as healthy. Zero actives against hundreds of known installs is not
 *    churn; it is a dead pipeline.
 *
 * 2. It compares against the last snapshot that actually had users, NOT against
 *    yesterday. Comparing to yesterday makes the alert self-silencing: day one
 *    fires, its zeros persist and become "yesterday", and every later day sees
 *    zero-following-zero and reports healthy. That inverts this module's own
 *    rule — a sustained failure must escalate, not go quiet. Keying on the last
 *    live snapshot means the alarm keeps ringing, and gets louder, until someone
 *    fixes it or the fleet genuinely has no users to report.
 *
 * This REPORTS but never suppresses the write: the zeros are what the feed said,
 * and recording them honestly is right. Raising the alarm is the job.
 *
 * @param {{mau:number, totalInstalls:number}} current normalized feed
 * @param {{mau:number, totalInstalls:number, date:string}|null} lastLive the
 *   newest stored snapshot with mau > 0, or null if none exists (a brand-new
 *   deployment, or a fleet that has genuinely never reported an active user —
 *   neither is an outage, so both return null)
 * @param {string} today YYYY-MM-DD
 * @returns {{level:'error', message:string}|null} null when healthy
 */
function classifyFeedHealth(current, lastLive, today) {
  // Nothing has ever been alive, so nothing has died.
  if (!lastLive) return null;
  const lastMau = Number(lastLive.mau) || 0;
  if (lastMau <= 0) return null;

  const mau = Number(current.mau) || 0;
  if (mau > 0) return null;

  const installs = Number(current.totalInstalls) || 0;
  const days = daysBetween(lastLive.date, today);
  const forHowLong = days === null || days < 0 ? '' : ` for ${days} day(s)`;

  // The install base still reporting while actives are zero is the tell: those
  // are different windows, and a real fleet cannot have installs but no actives.
  const installsClause =
    installs > 0
      ? `The feed still reports ${installs} install(s) over the retention window, which is exactly ` +
        'what a drained ingest looks like: the 30-day active count empties first while the 90-day ' +
        'install count is still coasting on old events. '
      : 'Installs have drained to zero as well, so the retention window has now emptied too. ';

  return {
    level: 'error',
    message: sanitizeForLog(
      `Telemetry feed reports mau=0${forHowLong}, but the last snapshot with any activity had ` +
        `mau=${lastMau} on ${lastLive.date}. ${installsClause}` +
        'Users do not all disappear overnight — treat this as a broken ingest path until proven ' +
        'otherwise. The zeros were recorded as reported; investigate before trusting the dashboard.',
      500
    ),
  };
}

function normalizeLastSuccess(v) {
  if (v && typeof v === 'object' && typeof v.state === 'string') return v;
  if (typeof v === 'string' && v !== '') return { state: 'known', date: v };
  return { state: 'never' };
}

// Guard the operator-supplied tolerance. Number('') is 0, so the common Actions
// pattern `TELEMETRY_STALE_AFTER_DAYS: ${{ vars.UNSET }}` would otherwise
// silently set the tolerance to zero and error on the first transient blip.
// Negative values are worse: age is never < 0, so every run would error.
function normalizeStaleAfterDays(v) {
  if (v === null || v === undefined) return DEFAULT_STALE_AFTER_DAYS;
  // Number('') and Number('  ') are both 0, which Number.isInteger happily
  // accepts — so an empty `${{ vars.UNSET }}` would set the tolerance to zero
  // and error on the first transient blip. Reject empties before coercing.
  if (typeof v === 'string' && v.trim() === '') return DEFAULT_STALE_AFTER_DAYS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_STALE_AFTER_DAYS;
  return n;
}

module.exports = {
  normalizeAdoptionFeed,
  toolDisplayName,
  toCount,
  classifyCollectionSkip,
  classifyFeedHealth,
  sanitizeForLog,
  daysBetween,
  DEFAULT_STALE_AFTER_DAYS,
  TOOL_PRODUCT_NAMES,
};
