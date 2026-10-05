/**
 * Reach: where visitors to the repositories come from and which platforms the
 * PyPI packages are installed on, rolled up across the whole ecosystem. Both
 * inputs are already collected (referrers by scripts/collect-stats.js,
 * pypi_python_versions and pypi_system_stats by scripts/collect-pypi-stats.js)
 * and shown per repo / per package on the dashboard; this module is the
 * cross-ecosystem view the overview API and data/summary.json carry.
 *
 * githubReferrers
 *   GitHub's top-referrers API returns, per repository, the top 10 referring
 *   sites over the last 14 days, and the collector stores that list under the
 *   collection date. One date's rows are therefore one 14-day window. The
 *   rollup reads only the newest referrer date in the table (asOf), so every
 *   repo contributes the same window; takes one snapshot per canonical repo
 *   (the canonical row's, else the first twin's, as lib/repos.js does for every
 *   other snapshot metric); and sums views (`count`) and unique visitors
 *   (`uniques`) per referrer. `uniques` is a sum of per-repo distinct counts: a
 *   visitor who reached two repos counts twice. GitHub does not report
 *   referrers below a repo's top 10, so the mix covers those, not all traffic.
 *   Each referrer is assigned a channel by host (CHANNEL_HOSTS, longest match
 *   wins, a host on no list is `other`); the raw referrer rows are emitted next
 *   to the channel totals so the classification can be checked.
 *
 * pypiPlatforms
 *   Per package and collection date the PyPI collector stores the downloads
 *   pypistats.org reported by Python minor version and by operating system
 *   (mirrors excluded), summed over the days in that response. The rollup
 *   reads the newest date in each table and sums across packages. pypistats
 *   does not attribute every download: the collector drops the unattributed
 *   Python-version bucket and stores the unattributed OS bucket as "null".
 *   Shares are over attributed downloads only. The OS block carries the
 *   unattributed count; the Python-version block reports it as null because it
 *   is not stored. The response window is set by pypistats.org and not stored,
 *   so these totals are not comparable with the daily download series; the
 *   shares are the signal.
 *
 * Nothing is estimated: an absent or empty table gives a null asOf, zero
 * totals and empty lists.
 */
const { groupByCanonical, pickCanonical } = require('./repos');

const REFERRER_WINDOW_DAYS = 14;
const REFERRERS_PER_REPO = 10;

// Referrer host -> channel. GitHub reports search engines by name ("Google",
// "Bing") and every other source by host. A host matches an entry when it
// equals it or is a subdomain of it; the longest matching entry wins, so
// gemini.google.com is an assistant while google.com is search.
const CHANNEL_HOSTS = {
  github: ['github.com'],
  search: [
    'google', 'bing', 'duckduckgo', 'yahoo', 'baidu', 'yandex', 'ecosia',
    'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'baidu.com',
    'yandex.ru', 'yandex.com', 'search.brave.com', 'kagi.com', 'ecosia.org',
    'startpage.com', 'qwant.com',
  ],
  'ai-assistant': [
    'chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai',
    'gemini.google.com', 'copilot.microsoft.com', 'phind.com',
  ],
  social: [
    't.co', 'twitter.com', 'x.com', 'linkedin.com', 'lnkd.in', 'com.linkedin.android',
    'facebook.com', 'reddit.com', 'news.ycombinator.com', 'youtube.com', 'bsky.app',
  ],
  'package-registry': ['npmjs.com', 'pypi.org', 'hub.docker.com', 'huggingface.co'],
  'own-site': ['opena2a.org'],
};
const OTHER_CHANNEL = 'other';

// Category values the PyPI collector stores for downloads pypistats did not
// attribute (the OS collector writes the API's "null" verbatim, or "unknown"
// when the category is missing).
const UNATTRIBUTED = new Set(['null', 'unknown', '']);

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/** Percent of total, two decimals; null when there is no total. */
function sharePct(value, total) {
  return total > 0 ? round2((value / total) * 100) : null;
}

function normalizeHost(referrer) {
  return String(referrer).trim().toLowerCase().replace(/^www\./, '');
}

/** The channel a referrer belongs to (see CHANNEL_HOSTS). */
function channelOf(referrer) {
  const host = normalizeHost(referrer);
  let best = OTHER_CHANNEL;
  let bestLen = 0;
  for (const [channel, hosts] of Object.entries(CHANNEL_HOSTS)) {
    for (const h of hosts) {
      if ((host === h || host.endsWith(`.${h}`)) && h.length > bestLen) {
        best = channel;
        bestLen = h.length;
      }
    }
  }
  return best;
}

// Largest first; ties by name in code-point order so the output does not
// depend on the runtime's locale.
function byValueThenName(valueKey, nameKey) {
  return (a, b) => {
    if (b[valueKey] !== a[valueKey]) return b[valueKey] - a[valueKey];
    const x = String(a[nameKey]);
    const y = String(b[nameKey]);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

function emptyReferrers() {
  return {
    asOf: null,
    windowDays: REFERRER_WINDOW_DAYS,
    referrersPerRepo: REFERRERS_PER_REPO,
    repos: 0,
    views: 0,
    uniques: 0,
    channels: [],
    referrers: [],
  };
}

function computeReferrerMix(db) {
  if (!tableExists(db, 'referrers') || !tableExists(db, 'repositories')) return emptyReferrers();
  const asOf = db.prepare('SELECT MAX(date) AS d FROM referrers').get()?.d || null;
  if (!asOf) return emptyReferrers();

  const rows = db.prepare(
    'SELECT repo_id, referrer, count, uniques FROM referrers WHERE date = ? ORDER BY repo_id'
  ).all(asOf);
  const reporting = new Set(rows.map(r => r.repo_id));
  const repos = db.prepare('SELECT * FROM repositories ORDER BY id').all()
    .filter(r => reporting.has(r.id));

  // One snapshot per canonical repo: transferred twins can both hold a list
  // for the same date, and summing both would count that repo's visitors twice.
  const chosen = new Set();
  for (const [canon, group] of groupByCanonical(repos)) chosen.add(pickCanonical(group, canon).id);

  const byReferrer = new Map();
  for (const r of rows) {
    if (!chosen.has(r.repo_id)) continue;
    const key = String(r.referrer);
    if (!byReferrer.has(key)) byReferrer.set(key, { referrer: key, views: 0, uniques: 0, repoIds: new Set() });
    const agg = byReferrer.get(key);
    agg.views += r.count || 0;
    agg.uniques += r.uniques || 0;
    agg.repoIds.add(r.repo_id);
  }

  const views = [...byReferrer.values()].reduce((s, r) => s + r.views, 0);
  const uniques = [...byReferrer.values()].reduce((s, r) => s + r.uniques, 0);

  const referrers = [...byReferrer.values()].map(r => ({
    referrer: r.referrer,
    channel: channelOf(r.referrer),
    views: r.views,
    uniques: r.uniques,
    repos: r.repoIds.size,
    sharePct: sharePct(r.views, views),
  })).sort(byValueThenName('views', 'referrer'));

  const byChannel = new Map();
  for (const r of referrers) {
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, { channel: r.channel, views: 0, uniques: 0, referrers: 0 });
    const c = byChannel.get(r.channel);
    c.views += r.views;
    c.uniques += r.uniques;
    c.referrers += 1;
  }
  const channels = [...byChannel.values()]
    .map(c => ({ ...c, sharePct: sharePct(c.views, views) }))
    .sort(byValueThenName('views', 'channel'));

  return {
    asOf,
    windowDays: REFERRER_WINDOW_DAYS,
    referrersPerRepo: REFERRERS_PER_REPO,
    repos: chosen.size,
    views,
    uniques,
    channels,
    referrers,
  };
}

/**
 * Split of one pypistats breakdown table on its newest date, summed across
 * packages. `unattributedStored` says whether the collector keeps the
 * unattributed bucket; when it does not, `unattributed` is null rather than a
 * misleading 0.
 */
function computePlatformSplit(db, table, column, itemKey, { unattributedStored }) {
  const empty = {
    asOf: null,
    packages: 0,
    downloads: 0,
    unattributed: unattributedStored ? 0 : null,
    attributedPct: null,
    items: [],
  };
  if (!tableExists(db, table)) return empty;
  const asOf = db.prepare(`SELECT MAX(date) AS d FROM ${table}`).get()?.d || null;
  if (!asOf) return empty;

  const rows = db.prepare(
    `SELECT package_id, ${column} AS category, downloads FROM ${table} WHERE date = ?`
  ).all(asOf);

  const byCategory = new Map();
  const packages = new Set();
  let unattributed = 0;
  for (const r of rows) {
    packages.add(r.package_id);
    const category = String(r.category ?? '').trim();
    if (UNATTRIBUTED.has(category.toLowerCase())) {
      unattributed += r.downloads || 0;
      continue;
    }
    if (!byCategory.has(category)) byCategory.set(category, { name: category, downloads: 0, packageIds: new Set() });
    const agg = byCategory.get(category);
    agg.downloads += r.downloads || 0;
    agg.packageIds.add(r.package_id);
  }

  const downloads = [...byCategory.values()].reduce((s, c) => s + c.downloads, 0);
  const items = [...byCategory.values()].map(c => ({
    [itemKey]: c.name,
    downloads: c.downloads,
    packages: c.packageIds.size,
    sharePct: sharePct(c.downloads, downloads),
  })).sort(byValueThenName('downloads', itemKey));

  return {
    asOf,
    packages: packages.size,
    downloads,
    unattributed: unattributedStored ? unattributed : null,
    attributedPct: unattributedStored ? sharePct(downloads, downloads + unattributed) : null,
    items,
  };
}

function computeReach(db) {
  return {
    githubReferrers: computeReferrerMix(db),
    pypiPlatforms: {
      source: 'pypistats.org per-package breakdowns, mirrors excluded',
      pythonVersions: computePlatformSplit(db, 'pypi_python_versions', 'python_version', 'version', { unattributedStored: false }),
      operatingSystems: computePlatformSplit(db, 'pypi_system_stats', 'os_name', 'os', { unattributedStored: true }),
    },
  };
}

module.exports = { computeReach, channelOf, CHANNEL_HOSTS, sharePct };
