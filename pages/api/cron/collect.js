const { execSync } = require('child_process');
const path = require('path');

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { timestamp: new Date().toISOString(), collectors: {} };
  const scriptsDir = path.join(process.cwd(), 'scripts');

  const collectors = [
    { name: 'github', script: 'collect-stats.js', needsToken: true },
    { name: 'npm', script: 'collect-npm-stats.js', needsToken: false },
    { name: 'pypi', script: 'collect-pypi-stats.js', needsToken: false },
    { name: 'docker', script: 'collect-docker-stats.js', needsToken: false },
    { name: 'huggingface', script: 'collect-huggingface-stats.js', needsToken: false },
  ];

  for (const collector of collectors) {
    if (collector.needsToken && !process.env.GITHUB_TOKEN) {
      results.collectors[collector.name] = { status: 'skipped', reason: 'no GITHUB_TOKEN' };
      continue;
    }
    try {
      execSync(`node ${path.join(scriptsDir, collector.script)}`, {
        encoding: 'utf-8',
        timeout: 120000,
        env: { ...process.env },
        cwd: process.cwd(),
      });
      results.collectors[collector.name] = { status: 'success' };
    } catch (err) {
      results.collectors[collector.name] = { status: 'error', message: err.message.slice(0, 200) };
    }
  }

  try {
    execSync(`node ${path.join(scriptsDir, 'generate-summary.js')}`, {
      encoding: 'utf-8', timeout: 30000, cwd: process.cwd(),
    });
    results.summary = 'regenerated';
  } catch (err) {
    results.summary = 'failed';
  }

  return res.status(200).json(results);
}
