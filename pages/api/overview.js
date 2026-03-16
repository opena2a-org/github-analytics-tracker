const Database = require('better-sqlite3');
const path = require('path');

/**
 * Fetch live npm download counts from the npm registry API.
 * Returns { lastDay, lastWeek, lastMonth } for the given package.
 * Falls back to null on timeout or error.
 */
async function fetchNpmLiveDownloads(packageName, timeoutMs = 5000) {
  const encodedName = encodeURIComponent(packageName);
  const periods = {
    lastDay: `https://api.npmjs.org/downloads/point/last-day/${encodedName}`,
    lastWeek: `https://api.npmjs.org/downloads/point/last-week/${encodedName}`,
    lastMonth: `https://api.npmjs.org/downloads/point/last-month/${encodedName}`,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const [dayRes, weekRes, monthRes] = await Promise.all(
      Object.values(periods).map(url =>
        fetch(url, { signal: controller.signal }).then(r => r.json())
      )
    );

    clearTimeout(timer);

    return {
      lastDay: dayRes.downloads ?? 0,
      lastWeek: weekRes.downloads ?? 0,
      lastMonth: monthRes.downloads ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch live PyPI download counts from the pypistats.org API.
 * Returns { lastDay, lastWeek, lastMonth } for the given package.
 */
async function fetchPypiLiveDownloads(packageName, timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(
      `https://pypistats.org/api/packages/${encodeURIComponent(packageName)}/recent`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const data = await res.json();
    return {
      lastDay: data.data?.last_day ?? 0,
      lastWeek: data.data?.last_week ?? 0,
      lastMonth: data.data?.last_month ?? 0,
    };
  } catch {
    return null;
  }
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

      return {
        name: repo.full_name,
        repo: repo.repo,
        totalViews: views.total,
        views24h: views24h.total,
        views7d: views7d.total,
        views30d: views30d.total,
        totalClones: clones.total,
        clones24h: clones24h.total,
        clones7d: clones7d.total,
        clones30d: clones30d.total,
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

      // Fetch live npm download data for all packages in parallel
      const liveResults = await Promise.all(
        packages.map(pkg => fetchNpmLiveDownloads(pkg.name))
      );

      npmStats = packages.map((pkg, i) => {
        // All-time downloads from SQLite (cumulative, still accurate)
        const allTime = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ?
        `).get(pkg.id);

        const live = liveResults[i];

        if (live) {
          // Use live npm API data for time-windowed metrics
          // Approximate prev7 as lastMonth minus lastWeek divided by ~3 remaining weeks
          const prev7Approx = Math.max(0, Math.round((live.lastMonth - live.lastWeek) / 3));
          return {
            name: pkg.name,
            version: pkg.version,
            allTimeDownloads: allTime.total,
            last24hDownloads: live.lastDay,
            last30Downloads: live.lastMonth,
            last7Downloads: live.lastWeek,
            prev7Downloads: prev7Approx,
          };
        }

        // Fallback to SQLite if npm API call failed
        const last24h = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-1 day')
        `).get(pkg.id);

        const last30 = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-30 days')
        `).get(pkg.id);

        const last7 = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-7 days')
        `).get(pkg.id);

        const prev7 = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-14 days') AND date < date('now', '-7 days')
        `).get(pkg.id);

        return {
          name: pkg.name,
          version: pkg.version,
          allTimeDownloads: allTime.total,
          last24hDownloads: last24h.total,
          last30Downloads: last30.total,
          last7Downloads: last7.total,
          prev7Downloads: prev7.total,
        };
      });
    }

    // --- PyPI Metrics ---
    const pypiTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pypi_packages'"
    ).get();

    let pypiStats = [];
    if (pypiTableExists) {
      const pypiPackages = db.prepare('SELECT * FROM pypi_packages ORDER BY name').all();

      // Fetch live PyPI downloads in parallel
      const pypiLive = await Promise.all(
        pypiPackages.map(pkg => fetchPypiLiveDownloads(pkg.name))
      );

      pypiStats = pypiPackages.map((pkg, i) => {
        const allTime = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM pypi_downloads WHERE package_id = ?
        `).get(pkg.id);

        const live = pypiLive[i];

        return {
          name: pkg.name,
          version: pkg.version,
          allTimeDownloads: allTime.total,
          last24hDownloads: live ? live.lastDay : 0,
          last30Downloads: live ? live.lastMonth : 0,
          last7Downloads: live ? live.lastWeek : 0,
          prev7Downloads: live ? Math.round((live.lastMonth - live.lastWeek) / 3) : 0,
        };
      });
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
      'HackMyAgent': {
        repos: ['hackmyagent'],
        packages: ['hackmyagent', 'hackmyagent-core'],
        pypiPackages: [],
        description: 'Security scanner for AI agents',
      },
      'AIM': {
        repos: ['agent-identity-management'],
        packages: ['@opena2a/aim-core'],
        pypiPackages: ['aim-sdk'],
        dockerImages: ['opena2a/aim-server', 'opena2a/aim-dashboard'],
        description: 'Agent Identity Management',
      },
      'OASB': {
        repos: ['oasb'],
        packages: ['@opena2a/oasb'],
        pypiPackages: [],
        description: 'Open Agent Security Benchmark',
      },
      'Secretless AI': {
        repos: ['secretless-ai'],
        packages: ['secretless-ai'],
        pypiPackages: [],
        description: 'Keep secrets out of AI tools',
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
    };

    const products = Object.entries(productMap).map(([name, config]) => {
      const matchedRepos = repoStats.filter(r => config.repos.some(rn => r.repo === rn));
      const matchedPackages = npmStats.filter(p => config.packages.includes(p.name));
      const matchedPypi = pypiStats.filter(p => (config.pypiPackages || []).includes(p.name));
      const matchedDocker = dockerStats.filter(d => (config.dockerImages || []).includes(d.fullName));

      const githubClones = matchedRepos.reduce((s, r) => s + r.totalClones, 0);
      const npmDownloads = matchedPackages.reduce((s, p) => s + p.allTimeDownloads, 0);
      const pypiDownloads = matchedPypi.reduce((s, p) => s + p.allTimeDownloads, 0);
      const dockerPulls = matchedDocker.reduce((s, d) => s + d.totalPulls, 0);

      return {
        name,
        description: config.description,
        github: {
          views: matchedRepos.reduce((s, r) => s + r.totalViews, 0),
          views24h: matchedRepos.reduce((s, r) => s + r.views24h, 0),
          views7d: matchedRepos.reduce((s, r) => s + r.views7d, 0),
          views30d: matchedRepos.reduce((s, r) => s + r.views30d, 0),
          clones: githubClones,
          clones24h: matchedRepos.reduce((s, r) => s + r.clones24h, 0),
          clones7d: matchedRepos.reduce((s, r) => s + r.clones7d, 0),
          clones30d: matchedRepos.reduce((s, r) => s + r.clones30d, 0),
          stars: matchedRepos.reduce((s, r) => s + r.stars, 0),
          forks: matchedRepos.reduce((s, r) => s + r.forks, 0),
          recentUniqueVisitors: matchedRepos.reduce((s, r) => s + r.recentUniqueVisitors, 0),
        },
        npm: {
          allTimeDownloads: npmDownloads,
          last24hDownloads: matchedPackages.reduce((s, p) => s + p.last24hDownloads, 0),
          last30Downloads: matchedPackages.reduce((s, p) => s + p.last30Downloads, 0),
          last7Downloads: matchedPackages.reduce((s, p) => s + p.last7Downloads, 0),
          prev7Downloads: matchedPackages.reduce((s, p) => s + p.prev7Downloads, 0),
          packageCount: matchedPackages.length,
        },
        pypi: {
          allTimeDownloads: pypiDownloads,
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
        // Combined adoption: clones + npm downloads + pypi downloads + docker pulls
        totalAdoption: githubClones + npmDownloads + pypiDownloads + dockerPulls,
      };
    });

    // --- Aggregate Totals ---
    const totalDockerPulls = dockerStats.reduce((s, d) => s + d.totalPulls, 0);
    const totalPypiDownloads = pypiStats.reduce((s, p) => s + p.allTimeDownloads, 0);
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
      },
      pypi: {
        packages: pypiStats.length,
        allTimeDownloads: totalPypiDownloads,
        last24hDownloads: pypiStats.reduce((s, p) => s + p.last24hDownloads, 0),
        last30Downloads: pypiStats.reduce((s, p) => s + p.last30Downloads, 0),
        last7Downloads: pypiStats.reduce((s, p) => s + p.last7Downloads, 0),
        prev7Downloads: pypiStats.reduce((s, p) => s + p.prev7Downloads, 0),
      },
      docker: {
        images: dockerStats.length,
        totalPulls: totalDockerPulls,
      },
      combined: {
        totalAdoption: repoStats.reduce((s, r) => s + r.totalClones, 0) +
                       npmStats.reduce((s, p) => s + p.allTimeDownloads, 0) +
                       totalPypiDownloads +
                       totalDockerPulls,
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
      topCountries,
    });
  } catch (error) {
    console.error('Error fetching overview:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  } finally {
    db.close();
  }
}
