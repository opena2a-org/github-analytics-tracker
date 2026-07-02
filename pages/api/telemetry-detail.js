const crypto = require('crypto');

/**
 * Password-gated FINE-GRAINED telemetry.
 *
 * Everything here is intentionally kept out of the committed database and the
 * public dashboard. On each request we:
 *   1. require ANALYTICS_TRACKER_PASSWORD to be configured (else feature is off);
 *   2. verify the caller-supplied password (timing-safe);
 *   3. fetch the Registry's AUTHENTICATED internal usage endpoint server-side
 *      with a service-account bearer token, and return only the fine-grained
 *      summary (command usage, reliability, by-day, by-country).
 *
 * The service-account token (REGISTRY_TELEMETRY_TOKEN) never reaches the
 * browser, and nothing fetched here is persisted. Coarse metrics have their own
 * public route (/api/telemetry); this route adds NOTHING to it unless the
 * password checks out.
 *
 * Config (env, all server-side only):
 *   ANALYTICS_TRACKER_PASSWORD  gate for the fine-grained view (required to enable).
 *                               Named for THIS dashboard — the org runs several,
 *                               so a bare DASHBOARD_PASSWORD wouldn't say which.
 *   REGISTRY_URL                Registry base URL
 *   REGISTRY_TELEMETRY_TOKEN    service-account bearer with internal:telemetry:read
 */

// Constant-time compare that also hides length differences by hashing both
// sides to a fixed width before comparing.
function passwordMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Per-IP fixed-window brute-force throttle. The password is the only control in
// front of a service-account-token-backed feed, and a timing-safe compare stops
// timing attacks but not online guessing — so cap attempts. NOTE: this state is
// per-process, so on a multi-instance/serverless deploy it throttles per
// instance, not globally; it is a speed bump, not a substitute for a
// high-entropy secret (`openssl rand -base64 24`). Best-effort by design.
const RL_WINDOW_MS = 5 * 60 * 1000;
const RL_MAX_ATTEMPTS = 10;
const rlHits = new Map(); // ip -> { count, resetAt }

function rateLimited(ip) {
  const now = Date.now();
  const rec = rlHits.get(ip);
  if (!rec || now >= rec.resetAt) {
    rlHits.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    // Opportunistic cleanup so the map can't grow unbounded.
    if (rlHits.size > 5000) {
      for (const [k, v] of rlHits) if (now >= v.resetAt) rlHits.delete(k);
    }
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX_ATTEMPTS;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Re-project upstream summary arrays to an explicit field whitelist. The
// Registry's internal summary rows may carry more than the dashboard needs;
// forwarding them verbatim would widen the surface past the coarse contract, so
// each element is rebuilt from known fields only.
function projectCommand(c) {
  return {
    tool: typeof c?.tool === 'string' ? c.tool : '',
    name: typeof c?.name === 'string' ? c.name : '',
    eventCount: Number.isFinite(c?.eventCount) ? c.eventCount : 0,
    successes: Number.isFinite(c?.successes) ? c.successes : 0,
    failures: Number.isFinite(c?.failures) ? c.failures : 0,
  };
}
function projectCountry(c) {
  return {
    countryCode: typeof c?.countryCode === 'string' ? c.countryCode : '',
    eventCount: Number.isFinite(c?.eventCount) ? c.eventCount : 0,
  };
}
function projectDay(d) {
  return {
    day: typeof d?.day === 'string' ? d.day : '',
    eventCount: Number.isFinite(d?.eventCount) ? d.eventCount : 0,
  };
}

export default async function handler(req, res) {
  // Never cache a gated response.
  res.setHeader('Cache-Control', 'no-store');

  const expected = process.env.ANALYTICS_TRACKER_PASSWORD || '';
  if (!expected) {
    // Feature not enabled — do not reveal whether detail exists.
    return res.status(404).json({ error: 'not found' });
  }

  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const supplied = req.headers['x-analytics-tracker-password'];
  if (!passwordMatches(Array.isArray(supplied) ? supplied[0] : supplied, expected)) {
    return res.status(401).json({ error: 'invalid dashboard password' });
  }

  const base = (process.env.REGISTRY_URL || '').trim().replace(/\/+$/, '');
  const token = process.env.REGISTRY_TELEMETRY_TOKEN || '';
  if (!base || !token) {
    return res.status(503).json({ error: 'telemetry detail not configured' });
  }

  try {
    const upstream = await fetch(base + '/internal/telemetry/v1/usage/internal', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `registry responded ${upstream.status}` });
    }
    const data = await upstream.json();
    const summary = data && data.summary ? data.summary : {};

    // Return only the fine-grained summary — the parts deliberately excluded
    // from the coarse public feed. Every array element is re-projected to a
    // known field whitelist so nothing the internal feed embeds in a row can
    // reach the browser beyond what the dashboard renders.
    return res.status(200).json({
      from: typeof summary.from === 'string' ? summary.from : null,
      to: typeof summary.to === 'string' ? summary.to : null,
      totalEvents: Number.isFinite(summary.totalEvents) ? summary.totalEvents : 0,
      uniqueInstalls: Number.isFinite(summary.uniqueInstalls) ? summary.uniqueInstalls : 0,
      commandSuccess: Number.isFinite(summary.commandSuccess) ? summary.commandSuccess : 0,
      commandFailure: Number.isFinite(summary.commandFailure) ? summary.commandFailure : 0,
      byCommand: (Array.isArray(summary.byCommand) ? summary.byCommand : []).map(projectCommand),
      byCountry: (Array.isArray(summary.byCountry) ? summary.byCountry : []).map(projectCountry),
      byDay: (Array.isArray(summary.byDay) ? summary.byDay : []).map(projectDay),
    });
  } catch (err) {
    return res.status(502).json({ error: 'failed to reach registry' });
  }
}
