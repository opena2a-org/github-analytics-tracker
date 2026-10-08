const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const crypto = require('node:crypto');

const {
  CRON_COLLECTORS, COLLECTOR_ENV_KEYS, SUMMARY_ENV_KEYS, collectorEnv, isAuthorized, runCron, cronHandler,
} = require('../lib/cron');

const SCRIPTS = join(__dirname, '..', 'scripts');
const ROUTE = join(__dirname, '..', 'pages', 'api', 'cron', 'collect.js');
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


for (const [label, env, header] of [
  ['unset', {}, 'Bearer undefined'],
  ['empty', { CRON_SECRET: '' }, 'Bearer '],
]) {
  test(`with CRON_SECRET ${label} the cron route answers 401 and runs nothing`, async () => {
    assert.equal(isAuthorized(header, env), false);
    const prevSecret = process.env.CRON_SECRET;
    const prevCwd = process.cwd();
    // An empty directory holds no collector, so a route that let the request
    // through would fail to start one rather than collect for real.
    const dir = mkdtempSync(join(tmpdir(), 'cron-route-'));
    process.chdir(dir);
    if (env.CRON_SECRET === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = env.CRON_SECRET;
    try {
      const res = { statusCode: null, body: null };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.body = obj; return res; };
      await cronHandler({ headers: { authorization: header } }, res);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'Unauthorized' });
    } finally {
      process.chdir(prevCwd);
      if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The route file is ES-module syntax in a package without "type": "module";
// importing it from a test fails on Node before 20.19 and warns after, so the
// tests load its handler from lib/cron.js and check the route serves that one.
test('the cron route serves the handler in lib/cron.js', () => {
  const source = readFileSync(ROUTE, 'utf8');
  assert.match(source, /^import \{ cronHandler \} from '\.\.\/\.\.\/\.\.\/lib\/cron\.js';$/m);
  assert.match(source, /^export default cronHandler;$/m);
});

test('the cron route compares the Authorization header in constant time', () => {
  const env = { CRON_SECRET: 's3cret' };
  const original = crypto.timingSafeEqual;
  const lengths = [];
  crypto.timingSafeEqual = (a, b) => { lengths.push([a.length, b.length]); return original(a, b); };
  try {
    assert.equal(isAuthorized('Bearer s3cret', env), true);
    assert.equal(isAuthorized('Bearer s3cres', env), false);
    assert.equal(isAuthorized('Bearer a-much-longer-wrong-token', env), false);
    assert.equal(isAuthorized(['Bearer s3cret'], env), false);
  } finally {
    crypto.timingSafeEqual = original;
  }
  assert.equal(lengths.length, 3, 'every string header goes through crypto.timingSafeEqual');
  for (const [a, b] of lengths) assert.equal(a, b, 'the buffers compared are of equal length');
});

test('the cron route accepts only the bearer token in CRON_SECRET', () => {
  const env = { CRON_SECRET: 's3cret' };
  assert.equal(isAuthorized('Bearer s3cret', env), true);
  assert.equal(isAuthorized('Bearer other', env), false);
  assert.equal(isAuthorized('s3cret', env), false);
  assert.equal(isAuthorized(undefined, env), false);
});

test('each cron child process receives only its allowlisted environment', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/cron', GITHUB_TOKEN: 'gh-token', NPM_PACKAGES: 'hackmyagent',
    SUMMARY_OUT: '/tmp/summary.json', COLLECTOR_OUTCOMES: '{}',
    CRON_SECRET: 'not-for-children', GOOGLE_APPLICATION_CREDENTIALS: '/keys/service-account.json',
    UNRELATED_SECRET: 'not-for-children',
  };
  const calls = [];
  const results = runCron({
    env, cwd: '/app', now: new Date('2026-09-02T00:00:00Z'),
    exec: (command, options) => calls.push({ command, options }),
  });
  const collectorEnvExpected = { PATH: '/usr/bin', HOME: '/home/cron', GITHUB_TOKEN: 'gh-token', NPM_PACKAGES: 'hackmyagent' };
  const collectorCalls = calls.filter(c => !c.command.endsWith('generate-summary.js'));
  assert.deepEqual(collectorCalls.map(c => c.command),
    CRON_COLLECTORS.map(c => `node ${join('/app', 'scripts', c.script)}`));
  for (const { options } of collectorCalls) {
    assert.deepEqual(options.env, collectorEnvExpected);
    assert.equal(options.cwd, '/app');
  }
  const summary = calls.filter(c => c.command.endsWith('generate-summary.js'));
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].options.env,
    { ...collectorEnvExpected, SUMMARY_OUT: '/tmp/summary.json', COLLECTOR_OUTCOMES: '{}' });
  assert.equal(results.summary, 'regenerated');
  assert.deepEqual(Object.values(results.collectors).map(r => r.status), CRON_COLLECTORS.map(() => 'success'));
});

test('every variable the summary step adds is read by the summary generator', () => {
  const sources = ['scripts/generate-summary.js', 'lib/summary.js']
    .map(file => readFileSync(join(__dirname, '..', file), 'utf8'));
  const unread = SUMMARY_ENV_KEYS.filter(key => !sources.some(source => source.includes(key)));
  assert.deepEqual(unread, []);
});
