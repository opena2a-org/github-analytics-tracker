/**
 * What the cron route (pages/api/cron/collect.js) runs, who may run it, the
 * environment it hands each child process, and its request handler, kept out
 * of the ES-module route file so all of it can be tested with require().
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const CRON_COLLECTORS = [
  { name: 'github', script: 'collect-stats.js', needsToken: true },
  { name: 'npm', script: 'collect-npm-stats.js', needsToken: false },
  { name: 'pypi', script: 'collect-pypi-stats.js', needsToken: false },
  { name: 'docker', script: 'collect-docker-stats.js', needsToken: false },
  { name: 'huggingface', script: 'collect-huggingface-stats.js', needsToken: false },
  { name: 'telemetry', script: 'collect-telemetry-stats.js', needsToken: false },
];

// Pass only the variables the collectors actually need to the child processes,
// rather than spreading the entire environment (which would leak unrelated
// secrets into every subprocess). Add new collector config keys here. No
// Google Cloud credentials: only the BigQuery country collector reads them,
// and the route does not run it.
const COLLECTOR_ENV_KEYS = [
  'PATH', 'NODE_ENV', 'HOME',
  'GITHUB_TOKEN', 'GITHUB_ORG', 'REPOS_TO_TRACK',
  'NPM_AUTHOR', 'NPM_PACKAGES',
  'PYPI_PACKAGES',
  'DOCKER_IMAGES',
  'HF_AUTHOR', 'HF_MODELS', 'HF_TOKEN',
  'REGISTRY_URL',
];

// What scripts/generate-summary.js reads, on top of the collector set.
const SUMMARY_ENV_KEYS = ['SUMMARY_DB', 'SUMMARY_OUT', 'COLLECTOR_OUTCOMES'];

function pick(env, keys) {
  return Object.fromEntries(keys.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
}

/** The allowlisted subset of `env` that a collector child process receives. */
function collectorEnv(env = process.env) {
  return pick(env, COLLECTOR_ENV_KEYS);
}

/** The allowlisted subset of `env` that the summary step receives. */
function summaryEnv(env = process.env) {
  return { ...collectorEnv(env), ...pick(env, SUMMARY_ENV_KEYS) };
}

/** SHA-256 of a string: a fixed-length buffer whatever the input's length. */
function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * True when the Authorization header carries CRON_SECRET as a bearer token.
 * Fails closed: with CRON_SECRET unset or empty nothing is authorized, since
 * `Bearer undefined` and `Bearer ` are headers anyone can send. The header and
 * the expected value are compared as equal-length digests with
 * crypto.timingSafeEqual, so the time taken tells a caller neither how much
 * of the header matched nor how long the secret is.
 */
function isAuthorized(authorization, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret || typeof authorization !== 'string') return false;
  return crypto.timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

/**
 * The cron route's request handler: 401 unless isAuthorized, otherwise run
 * every collector and answer with the results. It lives here, not in the
 * ES-module route file, so tests can load it with require().
 */
async function cronHandler(req, res) {
  if (!isAuthorized(req.headers.authorization)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(200).json(runCron());
}

/**
 * Run every cron collector, then regenerate the summary, each as a child
 * process that receives only its allowlisted environment. `exec` defaults to
 * execSync; tests inject a recorder. Returns the per-collector results.
 */
function runCron({ env = process.env, exec = execSync, cwd = process.cwd(), now = new Date() } = {}) {
  const results = { timestamp: now.toISOString(), collectors: {} };
  const scriptsDir = path.join(cwd, 'scripts');

  const childEnv = collectorEnv(env);

  for (const collector of CRON_COLLECTORS) {
    if (collector.needsToken && !env.GITHUB_TOKEN) {
      results.collectors[collector.name] = { status: 'skipped', reason: 'no GITHUB_TOKEN' };
      continue;
    }
    try {
      exec(`node ${path.join(scriptsDir, collector.script)}`, {
        encoding: 'utf-8',
        timeout: 120000,
        env: childEnv,
        cwd,
      });
      results.collectors[collector.name] = { status: 'success' };
    } catch (err) {
      results.collectors[collector.name] = { status: 'error', message: err.message.slice(0, 200) };
    }
  }

  try {
    exec(`node ${path.join(scriptsDir, 'generate-summary.js')}`, {
      encoding: 'utf-8', timeout: 30000, env: summaryEnv(env), cwd,
    });
    results.summary = 'regenerated';
  } catch (err) {
    results.summary = 'failed';
  }

  return results;
}

module.exports = {
  CRON_COLLECTORS,
  COLLECTOR_ENV_KEYS,
  SUMMARY_ENV_KEYS,
  collectorEnv,
  summaryEnv,
  isAuthorized,
  runCron,
  cronHandler,
};
