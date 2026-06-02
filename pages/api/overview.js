const Database = require('better-sqlite3');
const path = require('path');

/**
 * Compute windowed download metrics for one package straight from SQLite.
 * Deterministic and fast — no external API calls. The daily collector keeps
 * the store at most ~1 day stale, which we treat as the honest source of
 * truth rather than racing 100+ live API calls on every page load.
 *
 * Returns { name, version, allTimeDownloads, last24hDownloads, last7Downloads,
 *           last30Downloads, prev7Downloads, customDownloads }.
 */
function computeWindowedStats(db, table, fkColumn, fkId, { start, end, isCustomRange, name, version }) {
  // Anchor rolling windows to the latest COLLECTED date, not "now". Collection
  // lags real time by a day or two, so windowing from "now" leaves the trailing
  // 7-day window short a couple of days and makes healthy adoption look like a
  // drop (a phantom negative WoW). Anchoring to MAX(date) keeps the current and
  // previous windows the same length and fairly comparable.
  const anchor = `(SELECT MAX(date) FROM ${table})`;
  const sum = (clause, ...params) => db.prepare(
    `SELECT COALESCE(SUM(downloads), 0) AS total FROM ${table} WHERE ${fkColumn} = ?${clause ? ' AND ' + clause : ''}`
  ).get(fkId, ...params).total;

  return {
    name,
    version,
    allTimeDownloads: sum(''),
    last24hDownloads: sum(`date = ${anchor}`),
    last7Downloads: sum(`date > date(${anchor}, '-7 days')`),
    last30Downloads: sum(`date > date(${anchor}, '-30 days')`),
    prev7Downloads: sum(`date > date(${anchor}, '-14 days') AND date <= date(${anchor}, '-7 days')`),
    prev30Downloads: sum(`date > date(${anchor}, '-60 days') AND date <= date(${anchor}, '-30 days')`),
    customDownloads: isCustomRange ? sum('date >= ? AND date <= ?', start, end) : 0,
  };
}

/**
 * Overview API: Returns combined GitHub + npm metrics suitable for
 * investor presentations, dashboards, and growth tracking.
 *
 * Groups related packages and repos into "products" for unified metrics.
 */
export default async function handler(req, res) {
  // Cache response on Vercel edge for 5 minutes
  res.setHeader('Cache-Control', 's-maxage=300');
  const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
  const db = new Database(dbPath, { readonly: true });

  // Custom date range support
  const { start, end } = req.query;
  const isCustomRange = start && end && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);

  try {
    // --- GitHub Metrics ---
    const repos = db.prepare('SELECT * FROM repositories ORDER BY full_name').all();

    const repoStats = repos.map(repo => {
      const views = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_views WHERE repo_id = ?
      `).get(repo.id);

      const views24h = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_views WHERE repo_id = ? AND date >= date('now', '-1 day')
      `).get(repo.id);

      const views7d = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_views WHERE repo_id = ? AND date >= date('now', '-7 days')
      `).get(repo.id);

      const views30d = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_views WHERE repo_id = ? AND date >= date('now', '-30 days')
      `).get(repo.id);

      const clones = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_clones WHERE repo_id = ?
      `).get(repo.id);

      const clones24h = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_clones WHERE repo_id = ? AND date >= date('now', '-1 day')
      `).get(repo.id);

      const clones7d = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_clones WHERE repo_id = ? AND date >= date('now', '-7 days')
      `).get(repo.id);

      const clones30d = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_clones WHERE repo_id = ? AND date >= date('now', '-30 days')
      `).get(repo.id);

      const summary = db.prepare(`
        SELECT views_uniques, clones_uniques
        FROM traffic_summary WHERE repo_id = ?
        ORDER BY date DESC LIMIT 1
      `).get(repo.id);

      const stars = db.prepare(`
        SELECT COALESCE(total_stars, 0) as stars
        FROM stargazers WHERE repo_id = ?
        ORDER BY date DESC LIMIT 1
      `).get(repo.id);

      const forks = db.prepare(`
        SELECT COALESCE(total_forks, 0) as forks
        FROM forks WHERE repo_id = ?
        ORDER BY date DESC LIMIT 1
      `).get(repo.id);

      // Custom date range queries for GitHub traffic
      let customViews = 0, customClones = 0;
      if (isCustomRange) {
        const cv = db.prepare(`
          SELECT COALESCE(SUM(count), 0) as total
          FROM traffic_views WHERE repo_id = ? AND date >= ? AND date <= ?
        `).get(repo.id, start, end);
        customViews = cv.total;
        const cc = db.prepare(`
          SELECT COALESCE(SUM(count), 0) as total
          FROM traffic_clones WHERE repo_id = ? AND date >= ? AND date <= ?
        `).get(repo.id, start, end);
        customClones = cc.total;
      }

      return {
        name: repo.full_name,
        repo: repo.repo,
        totalViews: views.total,
        views24h: views24h.total,
        views7d: views7d.total,
        views30d: views30d.total,
        customViews,
        totalClones: clones.total,
        clones24h: clones24h.total,
        clones7d: clones7d.total,
        clones30d: clones30d.total,
        customClones,
        recentUniqueVisitors: summary?.views_uniques || 0,
        recentUniqueCloners: summary?.clones_uniques || 0,
        stars: stars?.stars || 0,
        forks: forks?.forks || 0,
      };
    });

    // --- npm Metrics ---
    const npmTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='npm_packages'"
    ).get();

    let npmStats = [];
    if (npmTableExists) {
      const packages = db.prepare('SELECT * FROM npm_packages ORDER BY name').all();
      // Source of truth is the daily-collected SQLite store (refreshed by the
      // cron every morning). We deliberately do NOT hit the live npm API per
      // package here: 38 packages x 3 endpoints = 100+ external calls per page
      // load, whose timeouts used to collapse last7 to 0 and render a phantom
      // "-100%" growth everywhere. SQLite is deterministic and at most ~1 day old.
      npmStats = packages.map(pkg => computeWindowedStats(db, 'npm_downloads', 'package_id', pkg.id, { start, end, isCustomRange, name: pkg.name, version: pkg.version }));
    }

    // --- PyPI Metrics ---
    const pypiTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_packages'"
    ).get();

    let pypiStats = [];
    if (pypiTableExists) {
      const pypiPackages = db.prepare('SELECT * FROM pypi_packages ORDER BY name').all();
      pypiStats = pypiPackages.map(pkg => computeWindowedStats(db, 'pypi_downloads', 'package_id', pkg.id, { start, end, isCustomRange, name: pkg.name, version: pkg.version }));
    }

    // --- Docker Metrics ---
    const dockerTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='docker_images'"
    ).get();

    let dockerStats = [];
    if (dockerTableExists) {
      const images = db.prepare('SELECT * FROM docker_images ORDER BY name').all();
      dockerStats = images.map(img => {
        const latest = db.prepare(`
          SELECT pull_count, star_count
          FROM docker_pulls WHERE image_id = ?
          ORDER BY date DESC LIMIT 1
        `).get(img.id);

        return {
          fullName: img.full_name,
          totalPulls: latest?.pull_count || 0,
          stars: latest?.star_count || 0,
        };
      });
    }

    // --- HuggingFace Metrics ---
    const hfTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='huggingface_models'"
    ).get();

    let hfStats = [];
    if (hfTableExists) {
      const models = db.prepare('SELECT * FROM huggingface_models ORDER BY model_id').all();
      hfStats = models.map(m => {
        const latest = db.prepare(`
          SELECT downloads_30d, downloads_all_time, likes
          FROM huggingface_stats WHERE model_id = ?
          ORDER BY date DESC LIMIT 1
        `).get(m.id);
        return {
          modelId: m.model_id,
          downloads30d: latest?.downloads_30d || 0,
          downloadsAllTime: latest?.downloads_all_time || 0,
          likes: latest?.likes || 0,
        };
      });
    }

    // --- Product-Level Aggregation ---
    // Map repos and packages to products for combined metrics
    const productMap = {
      'DVAA': {
        repos: ['damn-vulnerable-ai-agent'],
        packages: [],
        pypiPackages: [],
        dockerImages: ['opena2a/dvaa'],
        description: 'Vulnerable AI agent platform for security testing',
      },
      'OpenA2A CLI': {
        repos: ['opena2a'],
        packages: ['opena2a-cli', 'opena2a', '@opena2a/shared'],
        pypiPackages: [],
        description: 'Unified security CLI',
      },
      'HackMyAgent': {
        repos: ['hackmyagent'],
        packages: ['hackmyagent', 'hackmyagent-core'],
        pypiPackages: [],
        description: 'Security scanner for AI agents',
      },
      'Secretless AI': {
        repos: ['secretless-ai'],
        packages: ['secretless-ai'],
        pypiPackages: [],
        description: 'Keep secrets out of AI tools',
      },
      'AIM': {
        repos: ['agent-identity-management'],
        packages: ['@opena2a/aim-core'],
        pypiPackages: ['aim-sdk'],
        dockerImages: ['opena2a/aim-server', 'opena2a/aim-dashboard'],
        description: 'Agent Identity Management',
      },
      'ai-trust': {
        repos: ['ai-trust'],
        packages: ['ai-trust', '@opena2a/oa2a'],
        pypiPackages: [],
        description: 'Trust verification for AI packages',
      },
      'OASB': {
        repos: ['oasb'],
        packages: ['@opena2a/oasb'],
        pypiPackages: [],
        description: 'Open Agent Security Benchmark',
      },
      'CryptoServe': {
        repos: ['cryptoserve'],
        packages: ['cryptoserve'],
        pypiPackages: ['cryptoserve', 'cryptoserve-core', 'cryptoserve-auto', 'cryptoserve-client'],
        description: 'Cryptographic scanning and PQC analysis',
      },
      'ARP': {
        repos: ['arp'],
        packages: ['@opena2a/arp'],
        pypiPackages: [],
        description: 'Agent Runtime Protection',
      },
      'OpenClaw Plugins': {
        repos: ['openclaw'],
        packages: ['@opena2a/plugin-core', '@opena2a/credvault-openclaw', '@opena2a/signcrypt-openclaw', '@opena2a/skillguard-openclaw', '@opena2a/semantic-engine'],
        pypiPackages: [],
        description: 'Security plugins for OpenClaw bots',
      },
      'NanoMind': {
        repos: ['nanomind'],
        packages: ['@nanomind/cli', '@nanomind/engine', '@nanomind/daemon', '@nanomind/guard', '@nanomind/router', '@nanomind/runtime-core', '@nanomind/atc', '@nanomind/hma-adapter', '@nanomind/opena2a-adapter'],
        pypiPackages: [],
        hfModels: ['opena2a/nanomind-security-analyst', 'opena2a/nanomind-security-classifier'],
        description: 'Nano Language Models for inline security analysis',
      },
    };

    const products = Object.entries(productMap).map(([name, config]) => {
      const matchedRepos = repoStats.filter(r => config.repos.some(rn => r.repo === rn));
      const matchedPackages = npmStats.filter(p => config.packages.includes(p.name));
      const matchedPypi = pypiStats.filter(p => (config.pypiPackages || []).includes(p.name));
      const matchedDocker = dockerStats.filter(d => (config.dockerImages || []).includes(d.fullName));
      const matchedHf = hfStats.filter(m => (config.hfModels || []).includes(m.modelId));

      const githubClones = matchedRepos.reduce((s, r) => s + r.totalClones, 0);
      const npmDownloads = matchedPackages.reduce((s, p) => s + p.allTimeDownloads, 0);
      const pypiDownloads = matchedPypi.reduce((s, p) => s + p.allTimeDownloads, 0);
      const dockerPulls = matchedDocker.reduce((s, d) => s + d.totalPulls, 0);
      const hfDownloads = matchedHf.reduce((s, m) => s + m.downloadsAllTime, 0);

      return {
        name,
        description: config.description,
        github: {
          views: matchedRepos.reduce((s, r) => s + r.totalViews, 0),
          views24h: matchedRepos.reduce((s, r) => s + r.views24h, 0),
          views7d: matchedRepos.reduce((s, r) => s + r.views7d, 0),
          views30d: matchedRepos.reduce((s, r) => s + r.views30d, 0),
          customViews: matchedRepos.reduce((s, r) => s + (r.customViews || 0), 0),
          clones: githubClones,
          clones24h: matchedRepos.reduce((s, r) => s + r.clones24h, 0),
          clones7d: matchedRepos.reduce((s, r) => s + r.clones7d, 0),
          clones30d: matchedRepos.reduce((s, r) => s + r.clones30d, 0),
          customClones: matchedRepos.reduce((s, r) => s + (r.customClones || 0), 0),
          stars: matchedRepos.reduce((s, r) => s + r.stars, 0),
          forks: matchedRepos.reduce((s, r) => s + r.forks, 0),
          recentUniqueVisitors: matchedRepos.reduce((s, r) => s + r.recentUniqueVisitors, 0),
        },
        npm: {
          allTimeDownloads: npmDownloads,
          customDownloads: matchedPackages.reduce((s, p) => s + (p.customDownloads || 0), 0),
          last24hDownloads: matchedPackages.reduce((s, p) => s + p.last24hDownloads, 0),
          last30Downloads: matchedPackages.reduce((s, p) => s + p.last30Downloads, 0),
          last7Downloads: matchedPackages.reduce((s, p) => s + p.last7Downloads, 0),
          prev7Downloads: matchedPackages.reduce((s, p) => s + p.prev7Downloads, 0),
          packageCount: matchedPackages.length,
        },
        pypi: {
          allTimeDownloads: pypiDownloads,
          customDownloads: matchedPypi.reduce((s, p) => s + (p.customDownloads || 0), 0),
          last24hDownloads: matchedPypi.reduce((s, p) => s + p.last24hDownloads, 0),
          last30Downloads: matchedPypi.reduce((s, p) => s + p.last30Downloads, 0),
          last7Downloads: matchedPypi.reduce((s, p) => s + p.last7Downloads, 0),
          prev7Downloads: matchedPypi.reduce((s, p) => s + p.prev7Downloads, 0),
          packageCount: matchedPypi.length,
        },
        docker: {
          totalPulls: dockerPulls,
          imageCount: matchedDocker.length,
        },
        hf: {
          downloadsAllTime: hfDownloads,
          downloads30d: matchedHf.reduce((s, m) => s + m.downloads30d, 0),
          likes: matchedHf.reduce((s, m) => s + m.likes, 0),
          modelCount: matchedHf.length,
        },
        // Combined adoption: clones + npm + pypi + docker pulls + HF model downloads
        totalAdoption: githubClones + npmDownloads + pypiDownloads + dockerPulls + hfDownloads,
      };
    });

    // --- Catch ungrouped repos/packages so nothing is invisible ---
    const allGroupedRepos = new Set(Object.values(productMap).flatMap(c => c.repos || []));
    const allGroupedNpm = new Set(Object.values(productMap).flatMap(c => c.packages || []));
    const allGroupedPypi = new Set(Object.values(productMap).flatMap(c => c.pypiPackages || []));
    const allGroupedDocker = new Set(Object.values(productMap).flatMap(c => c.dockerImages || []));
    const allGroupedHf = new Set(Object.values(productMap).flatMap(c => c.hfModels || []));

    const ungroupedRepos = repoStats.filter(r => !allGroupedRepos.has(r.repo));
    const ungroupedNpm = npmStats.filter(p => !allGroupedNpm.has(p.name));
    const ungroupedPypi = pypiStats.filter(p => !allGroupedPypi.has(p.name));
    const ungroupedDocker = dockerStats.filter(d => !allGroupedDocker.has(d.fullName));
    const ungroupedHf = hfStats.filter(m => !allGroupedHf.has(m.modelId));

    if (ungroupedRepos.length > 0 || ungroupedNpm.length > 0 || ungroupedPypi.length > 0 || ungroupedDocker.length > 0 || ungroupedHf.length > 0) {
      const ugClones = ungroupedRepos.reduce((s, r) => s + r.totalClones, 0);
      const ugNpm = ungroupedNpm.reduce((s, p) => s + p.allTimeDownloads, 0);
      const ugPypi = ungroupedPypi.reduce((s, p) => s + p.allTimeDownloads, 0);
      const ugDocker = ungroupedDocker.reduce((s, d) => s + d.totalPulls, 0);
      const ugHf = ungroupedHf.reduce((s, m) => s + m.downloadsAllTime, 0);
      products.push({
        name: 'Other',
        description: `${ungroupedRepos.length} repos, ${ungroupedNpm.length} npm, ${ungroupedPypi.length} PyPI packages not assigned to a tool`,
        github: {
          views: ungroupedRepos.reduce((s, r) => s + r.totalViews, 0),
          views24h: ungroupedRepos.reduce((s, r) => s + r.views24h, 0),
          views7d: ungroupedRepos.reduce((s, r) => s + r.views7d, 0),
          views30d: ungroupedRepos.reduce((s, r) => s + r.views30d, 0),
          customViews: ungroupedRepos.reduce((s, r) => s + (r.customViews || 0), 0),
          clones: ugClones,
          clones24h: ungroupedRepos.reduce((s, r) => s + r.clones24h, 0),
          clones7d: ungroupedRepos.reduce((s, r) => s + r.clones7d, 0),
          clones30d: ungroupedRepos.reduce((s, r) => s + r.clones30d, 0),
          customClones: ungroupedRepos.reduce((s, r) => s + (r.customClones || 0), 0),
          stars: ungroupedRepos.reduce((s, r) => s + r.stars, 0),
          forks: ungroupedRepos.reduce((s, r) => s + r.forks, 0),
          recentUniqueVisitors: ungroupedRepos.reduce((s, r) => s + r.recentUniqueVisitors, 0),
        },
        npm: {
          allTimeDownloads: ugNpm,
          customDownloads: ungroupedNpm.reduce((s, p) => s + (p.customDownloads || 0), 0),
          last24hDownloads: ungroupedNpm.reduce((s, p) => s + p.last24hDownloads, 0),
          last30Downloads: ungroupedNpm.reduce((s, p) => s + p.last30Downloads, 0),
          last7Downloads: ungroupedNpm.reduce((s, p) => s + p.last7Downloads, 0),
          prev7Downloads: ungroupedNpm.reduce((s, p) => s + p.prev7Downloads, 0),
          packageCount: ungroupedNpm.length,
        },
        pypi: {
          allTimeDownloads: ugPypi,
          customDownloads: ungroupedPypi.reduce((s, p) => s + (p.customDownloads || 0), 0),
          last24hDownloads: ungroupedPypi.reduce((s, p) => s + p.last24hDownloads, 0),
          last30Downloads: ungroupedPypi.reduce((s, p) => s + p.last30Downloads, 0),
          last7Downloads: ungroupedPypi.reduce((s, p) => s + p.last7Downloads, 0),
          prev7Downloads: ungroupedPypi.reduce((s, p) => s + p.prev7Downloads, 0),
          packageCount: ungroupedPypi.length,
        },
        docker: { totalPulls: ugDocker, imageCount: ungroupedDocker.length },
        hf: {
          downloadsAllTime: ugHf,
          downloads30d: ungroupedHf.reduce((s, m) => s + m.downloads30d, 0),
          likes: ungroupedHf.reduce((s, m) => s + m.likes, 0),
          modelCount: ungroupedHf.length,
        },
        totalAdoption: ugClones + ugNpm + ugPypi + ugDocker + ugHf,
      });
    }

    // --- Aggregate Totals ---
    const totalDockerPulls = dockerStats.reduce((s, d) => s + d.totalPulls, 0);
    const totalPypiDownloads = pypiStats.reduce((s, p) => s + p.allTimeDownloads, 0);
    const totalHfDownloads = hfStats.reduce((s, m) => s + m.downloadsAllTime, 0);
    const totals = {
      github: {
        repos: repos.length,
        totalViews: repoStats.reduce((s, r) => s + r.totalViews, 0),
        views24h: repoStats.reduce((s, r) => s + r.views24h, 0),
        views7d: repoStats.reduce((s, r) => s + r.views7d, 0),
        views30d: repoStats.reduce((s, r) => s + r.views30d, 0),
        totalClones: repoStats.reduce((s, r) => s + r.totalClones, 0),
        clones24h: repoStats.reduce((s, r) => s + r.clones24h, 0),
        clones7d: repoStats.reduce((s, r) => s + r.clones7d, 0),
        clones30d: repoStats.reduce((s, r) => s + r.clones30d, 0),
        totalStars: repoStats.reduce((s, r) => s + r.stars, 0),
        totalForks: repoStats.reduce((s, r) => s + r.forks, 0),
      },
      npm: {
        packages: npmStats.length,
        allTimeDownloads: npmStats.reduce((s, p) => s + p.allTimeDownloads, 0),
        last24hDownloads: npmStats.reduce((s, p) => s + p.last24hDownloads, 0),
        last30Downloads: npmStats.reduce((s, p) => s + p.last30Downloads, 0),
        last7Downloads: npmStats.reduce((s, p) => s + p.last7Downloads, 0),
        prev7Downloads: npmStats.reduce((s, p) => s + p.prev7Downloads, 0),
        prev30Downloads: npmStats.reduce((s, p) => s + p.prev30Downloads, 0),
      },
      pypi: {
        packages: pypiStats.length,
        allTimeDownloads: totalPypiDownloads,
        last24hDownloads: pypiStats.reduce((s, p) => s + p.last24hDownloads, 0),
        last30Downloads: pypiStats.reduce((s, p) => s + p.last30Downloads, 0),
        last7Downloads: pypiStats.reduce((s, p) => s + p.last7Downloads, 0),
        prev7Downloads: pypiStats.reduce((s, p) => s + p.prev7Downloads, 0),
        prev30Downloads: pypiStats.reduce((s, p) => s + p.prev30Downloads, 0),
      },
      docker: {
        images: dockerStats.length,
        totalPulls: totalDockerPulls,
      },
      hf: {
        models: hfStats.length,
        downloadsAllTime: totalHfDownloads,
        downloads30d: hfStats.reduce((s, m) => s + m.downloads30d, 0),
        likes: hfStats.reduce((s, m) => s + m.likes, 0),
      },
      combined: {
        totalAdoption: repoStats.reduce((s, r) => s + r.totalClones, 0) +
                       npmStats.reduce((s, p) => s + p.allTimeDownloads, 0) +
                       totalPypiDownloads +
                       totalDockerPulls +
                       totalHfDownloads,
        totalPageViews: repoStats.reduce((s, r) => s + r.totalViews, 0),
      },
    };

    // --- Growth Trends ---
    // Get weekly npm download trends (last 12 weeks)
    let weeklyNpmTrend = [];
    if (npmTableExists) {
      weeklyNpmTrend = db.prepare(`
        SELECT
          strftime('%Y-W%W', date) as week,
          MIN(date) as week_start,
          SUM(downloads) as downloads
        FROM npm_downloads
        WHERE date >= date('now', '-84 days')
        GROUP BY strftime('%Y-W%W', date)
        ORDER BY week ASC
      `).all();
    }

    // Get weekly PyPI download trends (last 12 weeks)
    let weeklyPypiTrend = [];
    if (pypiTableExists) {
      weeklyPypiTrend = db.prepare(`
        SELECT
          strftime('%Y-W%W', date) as week,
          MIN(date) as week_start,
          SUM(downloads) as downloads
        FROM pypi_downloads
        WHERE date >= date('now', '-84 days')
        GROUP BY strftime('%Y-W%W', date)
        ORDER BY week ASC
      `).all();
    }

    // Merge npm and pypi weekly trends into a combined trend
    const weekMap = {};
    for (const w of weeklyNpmTrend) {
      weekMap[w.week] = { week: w.week, week_start: w.week_start, npm: w.downloads, pypi: 0 };
    }
    for (const w of weeklyPypiTrend) {
      if (!weekMap[w.week]) {
        weekMap[w.week] = { week: w.week, week_start: w.week_start, npm: 0, pypi: 0 };
      }
      weekMap[w.week].pypi = w.downloads;
    }
    const weeklyTrend = Object.values(weekMap)
      .sort((a, b) => a.week.localeCompare(b.week))
      .map(w => ({ ...w, downloads: w.npm + w.pypi }));

    // --- Advanced Metrics Summaries ---

    // Total contributor count across all repos
    let totalContributors = 0;
    const contribTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='github_contributors'"
    ).get();
    if (contribTableExists) {
      const contribCount = db.prepare(`
        SELECT COUNT(DISTINCT login) as count
        FROM github_contributors
        WHERE date = (SELECT MAX(date) FROM github_contributors)
      `).get();
      totalContributors = contribCount?.count || 0;
    }

    // Total release downloads across all repos
    let totalReleaseDownloads = 0;
    const relTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='github_releases'"
    ).get();
    if (relTableExists) {
      const relDl = db.prepare(`
        SELECT COALESCE(SUM(total_downloads), 0) as total
        FROM github_releases
        WHERE date = (SELECT MAX(date) FROM github_releases)
      `).get();
      totalReleaseDownloads = relDl?.total || 0;
    }

    totals.github.totalContributors = totalContributors;
    totals.github.totalReleaseDownloads = totalReleaseDownloads;

    // --- Top Countries (from BigQuery PyPI country data) ---
    let topCountries = [];
    const countryTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_country_downloads'"
    ).get();
    if (countryTableExists) {
      topCountries = db.prepare(`
        SELECT country_code AS countryCode, SUM(downloads) AS downloads
        FROM pypi_country_downloads
        WHERE date = (SELECT MAX(date) FROM pypi_country_downloads)
        GROUP BY country_code
        ORDER BY downloads DESC
        LIMIT 5
      `).all();
    }

    res.status(200).json({
      lastUpdated: new Date().toISOString(),
      totals,
      products: products.sort((a, b) => b.totalAdoption - a.totalAdoption),
      weeklyTrend,
      repositories: repoStats,
      npmPackages: npmStats,
      pypiPackages: pypiStats,
      dockerImages: dockerStats,
      hfModels: hfStats,
      topCountries,
    });
  } catch (error) {
    console.error('Error fetching overview:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  } finally {
    db.close();
  }
}
