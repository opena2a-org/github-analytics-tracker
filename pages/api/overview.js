const Database = require('better-sqlite3');
const path = require('path');

/**
 * Overview API: Returns combined GitHub + npm metrics suitable for
 * investor presentations, dashboards, and growth tracking.
 *
 * Groups related packages and repos into "products" for unified metrics.
 */
export default function handler(req, res) {
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

      const clones = db.prepare(`
        SELECT COALESCE(SUM(count), 0) as total
        FROM traffic_clones WHERE repo_id = ?
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
        totalClones: clones.total,
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
      npmStats = packages.map(pkg => {
        const allTime = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ?
        `).get(pkg.id);

        const last30 = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-30 days')
        `).get(pkg.id);

        const last7 = db.prepare(`
          SELECT COALESCE(SUM(downloads), 0) as total
          FROM npm_downloads WHERE package_id = ? AND date >= date('now', '-7 days')
        `).get(pkg.id);

        return {
          name: pkg.name,
          version: pkg.version,
          allTimeDownloads: allTime.total,
          last30Downloads: last30.total,
          last7Downloads: last7.total,
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
        dockerImages: ['opena2a/dvaa'],
        description: 'Vulnerable AI agent platform for security testing',
      },
      'HackMyAgent': {
        repos: ['hackmyagent'],
        packages: ['hackmyagent', 'hackmyagent-core'],
        description: 'Security scanner for AI agents',
      },
      'AIM': {
        repos: ['agent-identity-management'],
        packages: ['@opena2a/aim-core'],
        description: 'Agent Identity Management',
      },
      'OASB': {
        repos: ['oasb'],
        packages: ['@opena2a/oasb'],
        description: 'Open Agent Security Benchmark',
      },
      'Secretless AI': {
        repos: ['secretless-ai'],
        packages: ['secretless-ai'],
        description: 'Keep secrets out of AI tools',
      },
      'CryptoServe': {
        repos: ['cryptoserve'],
        packages: ['cryptoserve'],
        description: 'Cryptographic scanning and PQC analysis',
      },
      'ARP': {
        repos: ['arp'],
        packages: ['@opena2a/arp'],
        description: 'Agent Runtime Protection',
      },
      'OpenClaw Plugins': {
        repos: ['openclaw'],
        packages: ['@opena2a/plugin-core', '@opena2a/credvault-openclaw', '@opena2a/signcrypt-openclaw', '@opena2a/skillguard-openclaw', '@opena2a/semantic-engine'],
        description: 'Security plugins for OpenClaw bots',
      },
    };

    const products = Object.entries(productMap).map(([name, config]) => {
      const matchedRepos = repoStats.filter(r => config.repos.some(rn => r.repo === rn));
      const matchedPackages = npmStats.filter(p => config.packages.includes(p.name));
      const matchedDocker = dockerStats.filter(d => (config.dockerImages || []).includes(d.fullName));

      const githubClones = matchedRepos.reduce((s, r) => s + r.totalClones, 0);
      const npmDownloads = matchedPackages.reduce((s, p) => s + p.allTimeDownloads, 0);
      const dockerPulls = matchedDocker.reduce((s, d) => s + d.totalPulls, 0);

      return {
        name,
        description: config.description,
        github: {
          views: matchedRepos.reduce((s, r) => s + r.totalViews, 0),
          clones: githubClones,
          stars: matchedRepos.reduce((s, r) => s + r.stars, 0),
          forks: matchedRepos.reduce((s, r) => s + r.forks, 0),
          recentUniqueVisitors: matchedRepos.reduce((s, r) => s + r.recentUniqueVisitors, 0),
        },
        npm: {
          allTimeDownloads: npmDownloads,
          last30Downloads: matchedPackages.reduce((s, p) => s + p.last30Downloads, 0),
          last7Downloads: matchedPackages.reduce((s, p) => s + p.last7Downloads, 0),
          packageCount: matchedPackages.length,
        },
        docker: {
          totalPulls: dockerPulls,
          imageCount: matchedDocker.length,
        },
        // Combined adoption: clones + npm downloads + docker pulls
        totalAdoption: githubClones + npmDownloads + dockerPulls,
      };
    });

    // --- Aggregate Totals ---
    const totalDockerPulls = dockerStats.reduce((s, d) => s + d.totalPulls, 0);
    const totals = {
      github: {
        repos: repos.length,
        totalViews: repoStats.reduce((s, r) => s + r.totalViews, 0),
        totalClones: repoStats.reduce((s, r) => s + r.totalClones, 0),
        totalStars: repoStats.reduce((s, r) => s + r.stars, 0),
        totalForks: repoStats.reduce((s, r) => s + r.forks, 0),
      },
      npm: {
        packages: npmStats.length,
        allTimeDownloads: npmStats.reduce((s, p) => s + p.allTimeDownloads, 0),
        last30Downloads: npmStats.reduce((s, p) => s + p.last30Downloads, 0),
        last7Downloads: npmStats.reduce((s, p) => s + p.last7Downloads, 0),
      },
      docker: {
        images: dockerStats.length,
        totalPulls: totalDockerPulls,
      },
      combined: {
        totalAdoption: repoStats.reduce((s, r) => s + r.totalClones, 0) +
                       npmStats.reduce((s, p) => s + p.allTimeDownloads, 0) +
                       totalDockerPulls,
        totalPageViews: repoStats.reduce((s, r) => s + r.totalViews, 0),
      },
    };

    // --- Growth Trends ---
    // Get weekly npm download trends (last 12 weeks)
    let weeklyTrend = [];
    if (npmTableExists) {
      weeklyTrend = db.prepare(`
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

    res.status(200).json({
      lastUpdated: new Date().toISOString(),
      totals,
      products: products.sort((a, b) => b.totalAdoption - a.totalAdoption),
      weeklyTrend,
      repositories: repoStats,
      npmPackages: npmStats,
      dockerImages: dockerStats,
    });
  } catch (error) {
    console.error('Error fetching overview:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  } finally {
    db.close();
  }
}
