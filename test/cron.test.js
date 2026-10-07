const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { CRON_COLLECTORS, COLLECTOR_ENV_KEYS, collectorEnv } = require('../lib/cron');

const SCRIPTS = join(__dirname, '..', 'scripts');
const PROCESS_KEYS = ['PATH', 'NODE_ENV', 'HOME'];

test('the cron route hands its collectors no Google Cloud credential variable', () => {
  const env = collectorEnv({
    PATH: '/usr/bin',
    NPM_PACKAGES: 'hackmyagent',
    GOOGLE_APPLICATION_CREDENTIALS: '/keys/service-account.json',
    GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
    GOOGLE_CLOUD_PROJECT: 'example-project',
    CRON_SECRET: 'not-for-collectors',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', NPM_PACKAGES: 'hackmyagent' });
});

test('every config variable the cron route passes on is read by a collector it runs', () => {
  const sources = CRON_COLLECTORS.map(c => readFileSync(join(SCRIPTS, c.script), 'utf8'));
  const unread = COLLECTOR_ENV_KEYS
    .filter(key => !PROCESS_KEYS.includes(key))
    .filter(key => !sources.some(source => source.includes(key)));
  assert.deepEqual(unread, [], 'a variable no collector reads is a secret handed out for nothing');
});

test('the cron route does not run the BigQuery country collector', () => {
  assert.ok(!CRON_COLLECTORS.some(c => c.script === 'collect-pypi-country-stats.js'));
});
