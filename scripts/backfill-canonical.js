/**
 * One-time / idempotent backfill of repositories.canonical_full_name + archived.
 *
 * The daily collector only ever re-collects repos returned by the live org
 * listing, so it can keep canonical_full_name fresh for active repos but never
 * touches the stale rows left behind by a transfer or rename. This script walks
 * EVERY repositories row and resolves its current canonical path via the GitHub
 * API (octokit.repos.get follows transfer/rename redirects and returns the new
 * full_name), so the historical twins get collapsed correctly too.
 *
 * Safe to re-run. Requires GITHUB_TOKEN. See lib/repos.js for how the columns
 * are consumed.
 *
 *   GITHUB_TOKEN=... node scripts/backfill-canonical.js
 */
const { Octokit } = require('@octokit/rest');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const db = new Database(path.join(__dirname, '..', 'data', 'analytics.db'));

async function main() {
  // Ensure columns exist (no-op if setup-database already added them).
  const cols = db.prepare('PRAGMA table_info(repositories)').all().map(c => c.name);
  if (!cols.includes('canonical_full_name')) db.exec('ALTER TABLE repositories ADD COLUMN canonical_full_name TEXT');
  if (!cols.includes('archived')) db.exec('ALTER TABLE repositories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');

  const repos = db.prepare('SELECT id, owner, repo, full_name FROM repositories ORDER BY full_name').all();
  const update = db.prepare('UPDATE repositories SET canonical_full_name = ?, archived = ? WHERE id = ?');

  let resolved = 0, redirected = 0, gone = 0;
  for (const r of repos) {
    try {
      const { data } = await octokit.rest.repos.get({ owner: r.owner, repo: r.repo });
      update.run(data.full_name, data.archived ? 1 : 0, r.id);
      resolved++;
      if (data.full_name !== r.full_name) {
        redirected++;
        console.log('  %s -> %s%s', r.full_name, data.full_name, data.archived ? ' (archived)' : '');
      }
    } catch (error) {
      if (error.status === 404) {
        // Repo deleted (no redirect target). Keep it as its own canonical so it
        // still counts once; it just won't collapse into anything.
        update.run(r.full_name, 0, r.id);
        gone++;
        console.warn('  %s -> 404 (deleted); kept as canonical', r.full_name);
      } else {
        console.error('  %s -> error %s', r.full_name, error.message);
      }
    }
  }

  console.log('Backfill complete: %d resolved (%d redirected to a new path), %d deleted/404.', resolved, redirected, gone);
  db.close();
}

main().catch(err => { console.error(err); db.close(); process.exit(1); });
