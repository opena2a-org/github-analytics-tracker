/**
 * The one definition of "adoption" — shared by the API (pages/api/overview.js,
 * server) and the dashboard (pages/index.js, client) so the number can never
 * drift between where it's computed and where it's shown.
 *
 * Adoption sums acquisition events: distinct code-pullers + package installs +
 * image pulls + model downloads. The clone term is UNIQUE CLONERS, never the raw
 * git-clone count.
 *
 * Why uniques and not raw clones: GitHub's clone `count` is dominated by
 * automation — a single CI/mirror/scanner re-cloning a repo generates thousands
 * of clones from a handful of actors (hackmyagent: ~2,000 clones/day from 5-10
 * unique cloners, a 147x re-clone ratio). Raw count answers "how many git-clone
 * operations happened", which is not adoption. Unique cloners answers "how many
 * distinct people/systems pulled the code", which is. Raw clone count is retained
 * on the GitHub-traffic surfaces as an operational metric, never in adoption.
 *
 * What "unique cloners" is HERE: GitHub's own 14-day DEDUPLICATED distinct-cloner
 * count (`traffic_summary.clones_uniques`, surfaced as `recentUniqueCloners`).
 * That is the only honest distinct-cloner figure GitHub exposes — you cannot
 * deduplicate cloners across days you never captured identity for, so there is no
 * true 30-day or all-time unique-cloner count to be had. It is therefore a
 * ROLLING 14-DAY SNAPSHOT (like Chrome weekly-active users or the 14-day unique
 * visitors), shown identically under every period rather than re-windowed.
 *
 * Deliberately NOT used: SUM(traffic_clones.uniques) over a window. That sums
 * GitHub's per-day distinct-cloner counts, i.e. cloner-DAYS — a cloner active on
 * N days counts N times — which re-inflates the exact signal this fix removes and
 * would be a number labeled "unique cloners" that is not one.
 */

// Pick the value for the selected period from an object whose fields are named
// per-window (all / 30d / 7d / 24h / custom). Shared shape across github/npm/pypi.
function periodPick(o, allKey, k30, k7, k24, period, kCustom) {
  if (!o) return 0;
  switch (period) {
    case '24h': return o[k24] || 0;
    case '7d': return o[k7] || 0;
    case '30d': return o[k30] || 0;
    case 'custom': return o[kCustom] || 0;
    default: return o[allKey] || 0;
  }
}

// HuggingFace only reports all-time + rolling 30d, nothing finer.
function hfPeriod(hf, period) {
  if (!hf) return null;
  if (period === 'all') return hf.downloadsAllTime || 0;
  if (period === '30d') return hf.downloads30d || 0;
  return null; // 24h / 7d / custom -> not measured at this granularity
}

// The invariant: adoption is cloners + installs, never raw clone count. Every
// surface that reports adoption funnels through here.
function sumAdoption({ cloneUniques = 0, npm = 0, pypi = 0, docker = 0, hf = 0 }) {
  return cloneUniques + npm + pypi + docker + hf;
}

// Period-aware adoption for one product row (used by the dashboard table + KPIs).
// The clone term is GitHub's rolling 14-day distinct-cloner SNAPSHOT (period-
// independent — see the module header), NOT raw clones and NOT summed cloner-days.
function rowAdoption(p, period) {
  const cloneUniques = p.github?.cloneUniques || 0; // rolling 14-day distinct-cloner snapshot
  const npm = periodPick(p.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
  const pypi = periodPick(p.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
  const docker = period === 'all' ? (p.docker?.totalPulls || 0) : 0;
  const hf = hfPeriod(p.hf, period) || 0;
  return sumAdoption({ cloneUniques, npm, pypi, docker, hf });
}

module.exports = { periodPick, hfPeriod, sumAdoption, rowAdoption };
