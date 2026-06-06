/**
 * Standards grouping for the opena2a-standards org.
 *
 * Specs, protocols and conformance suites are organized separately from
 * products: their adoption signal is stars / views / clones, not installs.
 * Repos are bucketed into protocol families; anything in the org that doesn't
 * match a family falls into "Other Standards" so nothing is invisible.
 *
 * Transfer handling: when a repo is moved from opena2a-org into
 * opena2a-standards, the daily auto-discovery (which only ever ADDS rows, never
 * prunes) leaves a stale opena2a-org row behind that holds the pre-transfer
 * traffic history. We detect these by name collision with a live standards-org
 * repo and merge them into one logical spec — summing traffic (the two
 * histories are disjoint in time) but taking stars/forks from the canonical
 * standards-org row, since stars move with the repo on transfer and summing
 * would double-count against the old row's frozen snapshot.
 *
 * Shared by pages/api/overview.js and the standards regression test.
 */

const STANDARDS_ORG = 'opena2a-standards';

const STANDARDS_FAMILIES = [
  {
    name: 'Agent Trust (ATP / ATX)',
    description: 'Verifiable trust assertions and credential format for AI agents',
    repos: ['agent-trust-protocol', 'atx-spec', 'atx-conformance', 'atp-conformance'],
  },
  {
    name: 'Agent Identity (AIP)',
    description: 'Agent identity, capabilities, DID method, and authz observability',
    repos: ['agent-identity-protocol', 'aip-conformance', 'did-method-opena2a', 'otel-semconv-agent-identity'],
  },
  {
    name: 'A2A-IDF',
    description: 'Agent-to-Agent Identity Framework conformance suite + SDK',
    repos: ['a2a-idf-conformance', 'a2a-idf-sdk'],
  },
  {
    name: 'Agent Authorization (AAP)',
    description: 'Scoped, attested authorization for AI agent systems',
    repos: ['agent-authorization-protocol'],
  },
  {
    name: 'Governance & Threat',
    description: 'Behavioral governance, threat classification, and injection signatures',
    repos: ['agent-governance-spec', 'agent-threat-matrix', 'aiis-signatures', 'awesome-agent-souls'],
  },
];

// Merge same-named rows (across orgs) into one logical spec. Traffic sums;
// stars/forks come from the canonical (standards-org) row.
function mergeSpec(rows) {
  const canonical = rows.find(r => r.owner === STANDARDS_ORG) || rows[0];
  const sum = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    name: canonical.name,
    repo: canonical.repo,
    github: {
      views: sum('totalViews'), views24h: sum('views24h'), views7d: sum('views7d'), views30d: sum('views30d'), customViews: sum('customViews'),
      clones: sum('totalClones'), clones24h: sum('clones24h'), clones7d: sum('clones7d'), clones30d: sum('clones30d'), customClones: sum('customClones'),
      stars: canonical.stars || 0,
      starsGrowth24h: canonical.starsGrowth24h || 0, starsGrowth7d: canonical.starsGrowth7d || 0, starsGrowth30d: canonical.starsGrowth30d || 0,
      starsGrowthAll: canonical.starsGrowthAll || 0, starsGrowthCustom: canonical.starsGrowthCustom || 0,
      forks: canonical.forks || 0,
    },
  };
}

// Sum a list of already-merged specs into a family-level github aggregate.
function sumGithub(members) {
  const acc = k => members.reduce((s, m) => s + (m.github[k] || 0), 0);
  return {
    views: acc('views'), views24h: acc('views24h'), views7d: acc('views7d'), views30d: acc('views30d'), customViews: acc('customViews'),
    clones: acc('clones'), clones24h: acc('clones24h'), clones7d: acc('clones7d'), clones30d: acc('clones30d'), customClones: acc('customClones'),
    stars: acc('stars'),
    starsGrowth24h: acc('starsGrowth24h'), starsGrowth7d: acc('starsGrowth7d'), starsGrowth30d: acc('starsGrowth30d'),
    starsGrowthAll: acc('starsGrowthAll'), starsGrowthCustom: acc('starsGrowthCustom'),
    forks: acc('forks'),
  };
}

/**
 * Group repo stats into standards families.
 *
 * @param {Array} repoStats  rows shaped like pages/api/overview.js repoStats
 *   (need: owner, repo, name, totalViews, views24h/7d/30d, customViews,
 *   totalClones, clones24h/7d/30d, customClones, stars, starsGrowth*, forks).
 * @param {Array} families   family config (defaults to STANDARDS_FAMILIES).
 * @returns {{ standards: Array, isStandardsRepo: (r) => boolean }}
 */
function groupStandards(repoStats, families = STANDARDS_FAMILIES) {
  const claimed = new Set(families.flatMap(f => f.repos));
  // Key off the live standards-org names so transferred repos not yet assigned
  // to a family still merge their stale opena2a-org twin.
  const standardsOrgNames = new Set(repoStats.filter(r => r.owner === STANDARDS_ORG).map(r => r.repo));
  const isStandardsRepo = r => standardsOrgNames.has(r.repo) && r.repo !== '.github';

  const byName = {};
  for (const r of repoStats.filter(isStandardsRepo)) {
    (byName[r.repo] = byName[r.repo] || []).push(r);
  }
  const specByName = {};
  for (const [name, rows] of Object.entries(byName)) specByName[name] = mergeSpec(rows);

  const standards = [];
  for (const fam of families) {
    const members = fam.repos.filter(n => specByName[n]).map(n => specByName[n]);
    if (!members.length) continue; // skip families whose repos aren't collected yet
    standards.push({ name: fam.name, description: fam.description, repoCount: members.length, github: sumGithub(members), repos: members });
  }

  const orphans = Object.keys(specByName).filter(n => !claimed.has(n)).map(n => specByName[n]);
  if (orphans.length) {
    standards.push({
      name: 'Other Standards',
      description: `${orphans.length} repo(s) in ${STANDARDS_ORG} not yet assigned to a family`,
      repoCount: orphans.length,
      github: sumGithub(orphans),
      repos: orphans,
    });
  }

  return { standards, isStandardsRepo };
}

module.exports = { STANDARDS_ORG, STANDARDS_FAMILIES, groupStandards };
