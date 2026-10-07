/**
 * What the cron route (pages/api/cron/collect.js) runs, and the environment it
 * hands each collector, kept apart from the handler so both can be tested.
 */

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

/** The allowlisted subset of `env` that a collector child process receives. */
function collectorEnv(env = process.env) {
  return Object.fromEntries(
    COLLECTOR_ENV_KEYS.filter(k => env[k] !== undefined).map(k => [k, env[k]])
  );
}

module.exports = { CRON_COLLECTORS, COLLECTOR_ENV_KEYS, collectorEnv };
