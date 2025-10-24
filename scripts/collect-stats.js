const { Octokit } = require('@octokit/rest');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPOS_TO_TRACK = process.env.REPOS_TO_TRACK?.split(',') || [];

if (!GITHUB_TOKEN) {
  console.error('❌ Error: GITHUB_TOKEN environment variable is required');
  console.error('Get one at: https://github.com/settings/tokens');
  console.error('Required scopes: repo (for private repos) or public_repo (for public repos)');
  process.exit(1);
}

if (REPOS_TO_TRACK.length === 0) {
  console.error('❌ Error: REPOS_TO_TRACK environment variable is required');
  console.error('Format: owner/repo,owner/repo2');
  console.error('Example: opena2a-org/agent-identity-management');
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath);

const today = new Date().toISOString().split('T')[0];

async function getOrCreateRepo(owner, repo) {
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
    console.log(`📝 Added repository: ${fullName}`);
  }

  return repoRecord;
}

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

    for (const view of data.views) {
      const date = view.timestamp.split('T')[0];
      insert.run(repoId, date, view.count, view.uniques);
    }

    console.log(`  ✓ Views: ${data.count} total, ${data.uniques} unique`);
  } catch (error) {
    console.error(`  ✗ Failed to get views: ${error.message}`);
  }
}

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

    for (const clone of data.clones) {
      const date = clone.timestamp.split('T')[0];
      insert.run(repoId, date, clone.count, clone.uniques);
    }

    console.log(`  ✓ Clones: ${data.count} total, ${data.uniques} unique`);
  } catch (error) {
    console.error(`  ✗ Failed to get clones: ${error.message}`);
  }
}

async function collectReferrers(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.getTopReferrers({
      owner,
      repo
    });

    const insert = db.prepare(`
      INSERT INTO referrers (repo_id, referrer, count, uniques, date)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const referrer of data) {
      insert.run(repoId, referrer.referrer, referrer.count, referrer.uniques, today);
    }

    console.log(`  ✓ Referrers: ${data.length} sources`);
  } catch (error) {
    console.error(`  ✗ Failed to get referrers: ${error.message}`);
  }
}

async function collectPopularPaths(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.getTopPaths({
      owner,
      repo
    });

    const insert = db.prepare(`
      INSERT INTO popular_paths (repo_id, path, title, count, uniques, date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const path of data) {
      insert.run(repoId, path.path, path.title, path.count, path.uniques, today);
    }

    console.log(`  ✓ Popular paths: ${data.length} paths`);
  } catch (error) {
    console.error(`  ✗ Failed to get popular paths: ${error.message}`);
  }
}

async function collectStarsAndForks(owner, repo, repoId) {
  try {
    const { data } = await octokit.rest.repos.get({
      owner,
      repo
    });

    // Store stars
    const starsInsert = db.prepare(`
      INSERT OR REPLACE INTO stargazers (repo_id, date, total_stars)
      VALUES (?, ?, ?)
    `);
    starsInsert.run(repoId, today, data.stargazers_count);

    // Store forks
    const forksInsert = db.prepare(`
      INSERT OR REPLACE INTO forks (repo_id, date, total_forks)
      VALUES (?, ?, ?)
    `);
    forksInsert.run(repoId, today, data.forks_count);

    console.log(`  ✓ Stars: ${data.stargazers_count} | Forks: ${data.forks_count}`);
  } catch (error) {
    console.error(`  ✗ Failed to get stars/forks: ${error.message}`);
  }
}

async function collectStatsForRepo(fullName) {
  const [owner, repo] = fullName.split('/');

  console.log(`\n📊 Collecting stats for ${fullName}...`);

  const repoRecord = await getOrCreateRepo(owner, repo);

  await collectTrafficViews(owner, repo, repoRecord.id);
  await collectTrafficClones(owner, repo, repoRecord.id);
  await collectReferrers(owner, repo, repoRecord.id);
  await collectPopularPaths(owner, repo, repoRecord.id);
  await collectStarsAndForks(owner, repo, repoRecord.id);
}

async function main() {
  console.log('🚀 GitHub Analytics Collector');
  console.log(`📅 Date: ${today}`);
  console.log(`📦 Tracking ${REPOS_TO_TRACK.length} repositories\n`);

  for (const repo of REPOS_TO_TRACK) {
    try {
      await collectStatsForRepo(repo.trim());
    } catch (error) {
      console.error(`❌ Failed to collect stats for ${repo}:`, error.message);
    }
  }

  console.log('\n✅ Collection complete!');
  db.close();
}

main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
