const { Octokit } = require('@octokit/rest');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_ORG = process.env.GITHUB_ORG || '';
const REPOS_TO_TRACK = process.env.REPOS_TO_TRACK?.split(',').map(r => r.trim()).filter(Boolean) || [];

if (!GITHUB_TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is required');
  console.error('Get one at: https://github.com/settings/tokens');
  console.error('Required scopes: repo (for private repos) or public_repo (for public repos)');
  process.exit(1);
}

if (!GITHUB_ORG && REPOS_TO_TRACK.length === 0) {
  console.error('Error: Either GITHUB_ORG or REPOS_TO_TRACK environment variable is required');
  console.error('  GITHUB_ORG=opena2a-org  (auto-discovers all public repos)');
  console.error('  REPOS_TO_TRACK=owner/repo1,owner/repo2  (explicit list)');
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath);

const today = new Date().toISOString().split('T')[0];

/**
 * Discover all public repositories in a GitHub organization.
 * Uses pagination to handle orgs with many repos.
 */
async function discoverOrgRepos(org) {
  console.log('Discovering public repos in %s...', org);
  const repos = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.rest.repos.listForOrg({
      org,
      type: 'public',
      per_page: 100,
      page,
    });

    if (data.length === 0) break;

    for (const repo of data) {
      // Skip forks and archived repos
      if (repo.fork || repo.archived) continue;
      repos.push(`${org}/${repo.name}`);
    }

    if (data.length < 100) break;
    page++;
  }

  console.log('Found %d public repos in %s', repos.length, org);
  return repos;
}

function getOrCreateRepo(owner, repo) {
  const fullName = `${owner}/${repo}`;

  let repoRecord = db.prepare(
    'SELECT * FROM repositories WHERE owner = ? AND repo = ?'
  ).get(owner, repo);

  if (!repoRecord) {
    const insert = db.prepare(
      'INSERT INTO repositories (owner, repo, full_name) VALUES (?, ?, ?)'
    );
    const result = insert.run(owner, repo, fullName);
    repoRecord = { id: result.lastInsertRowid, owner, repo, full_name: fullName };
    console.log('  Added new repository: %s', fullName);
  }

  return repoRecord;
}

/**
 * GitHub traffic views API returns up to 14 days of daily data.
 * The current day (today) is always a partial count (still accumulating).
 * We skip today's data to avoid storing incomplete numbers that would
 * be overwritten tomorrow anyway. Only completed days are stored.
 *
 * We also store the 14-day summary totals (with properly deduplicated
 * unique counts) in the traffic_summary table.
 */
async function collectTrafficViews(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.getViews({
      owner,
      repo,
      per: 'day'
    });

    const insert = db.prepare(`
      INSERT OR REPLACE INTO traffic_views (repo_id, date, count, uniques)
      VALUES (?, ?, ?, ?)
    `);

    let storedDays = 0;
    for (const view of data.views) {
      const date = view.timestamp.split('T')[0];
      // Skip today - data is still accumulating and will be incomplete
      if (date === today) continue;
      insert.run(repoId, date, view.count, view.uniques);
      storedDays++;
    }

    // Store the 14-day API summary (properly deduplicated uniques)
    const summaryInsert = db.prepare(`
      INSERT INTO traffic_summary (repo_id, date, views_count, views_uniques)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_id, date) DO UPDATE SET
        views_count = excluded.views_count,
        views_uniques = excluded.views_uniques,
        collected_at = CURRENT_TIMESTAMP
    `);
    summaryInsert.run(repoId, today, data.count, data.uniques);

    console.log('  Views: %d days stored, 14-day total: %d (%d unique)', storedDays, data.count, data.uniques);
  } catch (error) {
    if (error.status === 403) {
      console.log('  Views: skipped (no push access to %s/%s)', owner, repo);
    } else {
      console.error('  Views: failed - %s', error.message);
    }
  }
}

/**
 * GitHub traffic clones API - same 14-day window and partial-day issue as views.
 */
async function collectTrafficClones(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.getClones({
      owner,
      repo,
      per: 'day'
    });

    const insert = db.prepare(`
      INSERT OR REPLACE INTO traffic_clones (repo_id, date, count, uniques)
      VALUES (?, ?, ?, ?)
    `);

    let storedDays = 0;
    for (const clone of data.clones) {
      const date = clone.timestamp.split('T')[0];
      if (date === today) continue;
      insert.run(repoId, date, clone.count, clone.uniques);
      storedDays++;
    }

    // Store the 14-day API summary (properly deduplicated uniques)
    const summaryUpdate = db.prepare(`
      INSERT INTO traffic_summary (repo_id, date, clones_count, clones_uniques)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_id, date) DO UPDATE SET
        clones_count = excluded.clones_count,
        clones_uniques = excluded.clones_uniques,
        collected_at = CURRENT_TIMESTAMP
    `);
    summaryUpdate.run(repoId, today, data.count, data.uniques);

    console.log('  Clones: %d days stored, 14-day total: %d (%d unique)', storedDays, data.count, data.uniques);
  } catch (error) {
    if (error.status === 403) {
      console.log('  Clones: skipped (no push access to %s/%s)', owner, repo);
    } else {
      console.error('  Clones: failed - %s', error.message);
    }
  }
}

/**
 * GitHub top referrers API returns the top 10 referrers for the last 14 days.
 * This is a cumulative snapshot, NOT daily data.
 * We delete existing rows for (repo_id, date) before inserting to prevent
 * duplicates from re-runs.
 */
async function collectReferrers(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.getTopReferrers({
      owner,
      repo
    });

    // Delete existing referrer rows for this repo+date to prevent duplicates
    db.prepare('DELETE FROM referrers WHERE repo_id = ? AND date = ?').run(repoId, today);

    const insert = db.prepare(`
      INSERT INTO referrers (repo_id, referrer, count, uniques, date)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const referrer of data) {
      insert.run(repoId, referrer.referrer, referrer.count, referrer.uniques, today);
    }

    console.log('  Referrers: %d sources', data.length);
  } catch (error) {
    if (error.status === 403) {
      console.log('  Referrers: skipped (no push access)');
    } else {
      console.error('  Referrers: failed - %s', error.message);
    }
  }
}

/**
 * GitHub popular paths API returns the top 10 paths for the last 14 days.
 * Same cumulative snapshot approach as referrers.
 */
async function collectPopularPaths(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.getTopPaths({
      owner,
      repo
    });

    // Delete existing path rows for this repo+date to prevent duplicates
    db.prepare('DELETE FROM popular_paths WHERE repo_id = ? AND date = ?').run(repoId, today);

    const insert = db.prepare(`
      INSERT INTO popular_paths (repo_id, path, title, count, uniques, date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const p of data) {
      insert.run(repoId, p.path, p.title, p.count, p.uniques, today);
    }

    console.log('  Popular paths: %d paths', data.length);
  } catch (error) {
    if (error.status === 403) {
      console.log('  Popular paths: skipped (no push access)');
    } else {
      console.error('  Popular paths: failed - %s', error.message);
    }
  }
}

async function collectStarsAndForks(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.get({
      owner,
      repo
    });

    const starsInsert = db.prepare(`
      INSERT OR REPLACE INTO stargazers (repo_id, date, total_stars)
      VALUES (?, ?, ?)
    `);
    starsInsert.run(repoId, today, data.stargazers_count);

    const forksInsert = db.prepare(`
      INSERT OR REPLACE INTO forks (repo_id, date, total_forks)
      VALUES (?, ?, ?)
    `);
    forksInsert.run(repoId, today, data.forks_count);

    console.log('  Stars: %d | Forks: %d', data.stargazers_count, data.forks_count);
  } catch (error) {
    console.error('  Stars/Forks: failed - %s', error.message);
  }
}

async function collectStatsForRepo(fullName) {
  const [owner, repo] = fullName.split('/');

  console.log('\nCollecting stats for %s...', fullName);

  const repoRecord = getOrCreateRepo(owner, repo);

  await collectTrafficViews(owner, repo, repoRecord.id);
  await collectTrafficClones(owner, repo, repoRecord.id);
  await collectReferrers(owner, repo, repoRecord.id);
  await collectPopularPaths(owner, repo, repoRecord.id);
  await collectStarsAndForks(owner, repo, repoRecord.id);
}

async function generateBadgeJson() {
  const repos = db.prepare('SELECT * FROM repositories').all();

  for (const repo of repos) {
    // Use the most recent 14-day summary for accurate totals
    const summary = db.prepare(`
      SELECT views_count, views_uniques, clones_count, clones_uniques
      FROM traffic_summary
      WHERE repo_id = ?
      ORDER BY date DESC
      LIMIT 1
    `).get(repo.id);

    // Get all-time totals from daily data
    const allTimeClones = db.prepare(`
      SELECT COALESCE(SUM(count), 0) as total
      FROM traffic_clones
      WHERE repo_id = ?
    `).get(repo.id);

    // Get latest stars/forks
    const latestStats = db.prepare(`
      SELECT s.total_stars, f.total_forks
      FROM stargazers s
      LEFT JOIN forks f ON s.repo_id = f.repo_id AND s.date = f.date
      WHERE s.repo_id = ?
      ORDER BY s.date DESC
      LIMIT 1
    `).get(repo.id);

    const badgeData = {
      schemaVersion: 1,
      label: "clones",
      message: (allTimeClones?.total || 0).toLocaleString(),
      color: "blue",
      namedLogo: "github",
      style: "social"
    };

    const statsData = {
      lastUpdated: new Date().toISOString(),
      repository: repo.full_name,
      stats: {
        recent14Days: {
          views: summary?.views_count || 0,
          viewsUnique: summary?.views_uniques || 0,
          clones: summary?.clones_count || 0,
          clonesUnique: summary?.clones_uniques || 0
        },
        allTime: {
          clones: allTimeClones?.total || 0
        },
        stars: latestStats?.total_stars || 0,
        forks: latestStats?.total_forks || 0
      }
    };

    const safeRepoName = repo.full_name.replace('/', '_');
    const badgePath = path.join(__dirname, '..', 'data', `badge-${safeRepoName}.json`);
    const statsPath = path.join(__dirname, '..', 'data', `stats-${safeRepoName}.json`);

    fs.writeFileSync(badgePath, JSON.stringify(badgeData, null, 2));
    fs.writeFileSync(statsPath, JSON.stringify(statsData, null, 2));

    console.log('  Badge for %s: %d all-time clones', repo.repo, allTimeClones?.total || 0);
  }
}

async function main() {
  console.log('GitHub Analytics Collector');
  console.log('Date: %s', today);

  // Build the repo list: org discovery OR explicit list
  let repos = [...REPOS_TO_TRACK];

  if (GITHUB_ORG) {
    const orgRepos = await discoverOrgRepos(GITHUB_ORG);
    // Merge: org repos + any explicit repos, deduplicated
    const repoSet = new Set([...orgRepos, ...repos]);
    repos = Array.from(repoSet);
  }

  if (repos.length === 0) {
    console.error('Error: No repositories found to track');
    process.exit(1);
  }

  console.log('Tracking %d repositories\n', repos.length);

  for (const repo of repos) {
    try {
      await collectStatsForRepo(repo);
    } catch (error) {
      console.error('Failed to collect stats for %s: %s', repo, error.message);
    }
  }

  console.log('\nGenerating badge JSON files...');
  await generateBadgeJson();

  console.log('\nCollection complete!');
  db.close();
}

main().catch(error => {
  console.error('Fatal error: %s', error.message);
  process.exit(1);
});
