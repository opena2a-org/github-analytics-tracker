/**
 * Post-publication run check for the collect workflow. Runs AFTER the day's
 * data is committed, so a failure here turns the run red (and fires the
 * scheduled-workflow failure notification) without costing the data.
 *
 * Fails (exit 1) when any of these hold in data/summary.json:
 *   - lastUpdated is older than MAX_AGE_HOURS (default 48): the summary that
 *     was just published is stale, i.e. runs have been missing;
 *   - any collector reports ok === false (a step failed, or the GitHub
 *     collector had per-repo failures);
 *   - GitHub discovery found more repos than reached traffic_summary today,
 *     beyond the repos allowlisted as expected-missing
 *     (TRAFFIC_MISSING_ALLOWLIST, comma-separated owner/repo).
 *
 * Env: SUMMARY_PATH (default data/summary.json), MAX_AGE_HOURS,
 * TRAFFIC_MISSING_ALLOWLIST.
 */
const fs = require('fs');
const path = require('path');

function checkRun(summary, { now = new Date(), maxAgeHours = 48, allowlist = [] } = {}) {
  const problems = [];

  const updated = Date.parse(summary.lastUpdated || '');
  if (Number.isNaN(updated)) {
    problems.push('summary.lastUpdated is missing or unparseable');
  } else {
    const ageHours = (now.getTime() - updated) / 36e5;
    if (ageHours > maxAgeHours) {
      problems.push(`summary.lastUpdated is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h): collection runs are being missed`);
    }
  }

  const collectors = summary.collectors || {};
  for (const [name, c] of Object.entries(collectors)) {
    if (c && c.ok === false) problems.push(`collector ${name} failed: ${c.error || 'no error text'}`);
  }

  const g = collectors.github;
  if (g && typeof g.reposDiscovered === 'number' && typeof g.reposCollectedToday === 'number') {
    const gap = g.reposDiscovered - g.reposCollectedToday;
    if (gap > allowlist.length) {
      // Traffic-denied repos (token lacks push access, 403) are named so the
      // red run is actionable: grant access, or declare the repo in
      // TRAFFIC_MISSING_ALLOWLIST. They are not auto-excused: an undeclared
      // denial is exactly the silent coverage loss this gate exists to catch.
      const denied = Array.isArray(g.trafficDenied) ? g.trafficDenied.filter(r => !allowlist.includes(r)) : [];
      const deniedNote = denied.length
        ? `; token lacks traffic access to: ${denied.join(', ')} (grant access or add to TRAFFIC_MISSING_ALLOWLIST)`
        : '';
      problems.push(`GitHub discovered ${g.reposDiscovered} repos but ${g.reposCollectedToday} have a traffic row today; gap ${gap} exceeds the ${allowlist.length} allowlisted (${allowlist.join(', ') || 'none'})${deniedNote}`);
    }
  }

  return problems;
}

if (require.main === module) {
  const summaryPath = process.env.SUMMARY_PATH || path.join(__dirname, '..', 'data', 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const allowlist = (process.env.TRAFFIC_MISSING_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
  const maxAgeHours = Number(process.env.MAX_AGE_HOURS || 48);
  const problems = checkRun(summary, { maxAgeHours, allowlist });
  if (problems.length === 0) {
    console.log('Run check passed: summary fresh, every collector ok, GitHub coverage within allowlist.');
    process.exit(0);
  }
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}

module.exports = { checkRun };
