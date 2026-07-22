const { test } = require('node:test');
const assert = require('node:assert');
const { groupStandards, STANDARDS_ORG } = require('../lib/standards');

// Minimal repoStat row factory — only the fields groupStandards reads.
function repo(owner, name, { views = 0, clones = 0, uniqueCloners = 0, stars = 0, forks = 0, views7d = 0, clones7d = 0, starsGrowthAll = 0 } = {}) {
  return {
    owner, repo: name, name: `${owner}/${name}`,
    totalViews: views, views24h: 0, views7d, views30d: 0, customViews: 0,
    totalClones: clones, clones24h: 0, clones7d, clones30d: 0, customClones: 0,
    // 14-day deduplicated distinct cloners — a snapshot, from the canonical row.
    recentUniqueVisitors: 0, recentUniqueCloners: uniqueCloners,
    stars, starsGrowth24h: 0, starsGrowth7d: 0, starsGrowth30d: 0, starsGrowthAll, starsGrowthCustom: 0,
    forks,
  };
}

const families = [
  { name: 'Fam A', description: 'a', repos: ['spec-a', 'spec-a-conformance'] },
  { name: 'Fam B', description: 'b', repos: ['spec-b'] },
];

test('transferred repo merges stale opena2a-org row: traffic sums, stars from canonical', () => {
  const rows = [
    // Stale pre-transfer row left behind under opena2a-org.
    repo('opena2a-org', 'spec-a', { views: 30, clones: 100, uniqueCloners: 9, stars: 5, forks: 1 }),
    // Live row under the standards org (current stars/forks).
    repo(STANDARDS_ORG, 'spec-a', { views: 12, clones: 8, uniqueCloners: 4, stars: 7, forks: 2 }),
  ];
  const { standards } = groupStandards(rows, families);
  const famA = standards.find(f => f.name === 'Fam A');
  const specA = famA.repos.find(r => r.repo === 'spec-a');

  assert.strictEqual(specA.github.views, 42, 'views summed across both rows');
  assert.strictEqual(specA.github.clones, 108, 'raw clones summed across both rows');
  assert.strictEqual(specA.github.cloneUniques, 4, 'deduped unique cloners from canonical standards-org row (NOT summed to 13 — a 14-day dedup cannot be added across twins)');
  assert.strictEqual(specA.github.stars, 7, 'stars taken from canonical standards-org row, not summed');
  assert.strictEqual(specA.github.forks, 2, 'forks taken from canonical row');
  assert.strictEqual(specA.name, `${STANDARDS_ORG}/spec-a`, 'canonical name wins');
});

test('isStandardsRepo flags standards repos and their transferred twins, but not products or .github', () => {
  const rows = [
    repo(STANDARDS_ORG, 'spec-a'),
    repo('opena2a-org', 'spec-a'),       // transferred twin
    repo('opena2a-org', 'hackmyagent'),  // a real product, not standards
    repo(STANDARDS_ORG, '.github'),      // org profile repo, not a spec
  ];
  const { isStandardsRepo } = groupStandards(rows, families);
  assert.ok(isStandardsRepo(rows[0]), 'standards-org repo');
  assert.ok(isStandardsRepo(rows[1]), 'transferred twin by name collision');
  assert.ok(!isStandardsRepo(rows[2]), 'product repo excluded');
  assert.ok(!isStandardsRepo(rows[3]), '.github excluded');
});

test('orphan standards-org repos land in "Other Standards"', () => {
  const rows = [
    repo(STANDARDS_ORG, 'spec-b', { stars: 1 }),
    repo(STANDARDS_ORG, 'unfiled-spec', { stars: 3, clones: 9 }),
  ];
  const { standards } = groupStandards(rows, families);
  const other = standards.find(f => f.name === 'Other Standards');
  assert.ok(other, 'Other Standards bucket exists');
  assert.strictEqual(other.repoCount, 1);
  assert.strictEqual(other.repos[0].repo, 'unfiled-spec');
  assert.strictEqual(other.github.clones, 9);
});

test('family aggregate sums member stars (distinct specs, no double count)', () => {
  const rows = [
    repo(STANDARDS_ORG, 'spec-a', { stars: 2, clones: 10 }),
    repo(STANDARDS_ORG, 'spec-a-conformance', { stars: 1, clones: 5 }),
  ];
  const { standards } = groupStandards(rows, families);
  const famA = standards.find(f => f.name === 'Fam A');
  assert.strictEqual(famA.repoCount, 2);
  assert.strictEqual(famA.github.stars, 3, 'distinct member stars summed');
  assert.strictEqual(famA.github.clones, 15);
});

test('empty / no-standards input yields no families', () => {
  const { standards } = groupStandards([repo('opena2a-org', 'hackmyagent')], families);
  assert.strictEqual(standards.length, 0);
});
