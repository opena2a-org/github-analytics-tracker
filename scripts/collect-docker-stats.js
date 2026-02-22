const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

// Docker images to track (namespace/name format)
const DOCKER_IMAGES = (process.env.DOCKER_IMAGES || '').split(',').map(i => i.trim()).filter(Boolean);

if (DOCKER_IMAGES.length === 0) {
  console.error('Error: DOCKER_IMAGES environment variable is required');
  console.error('  DOCKER_IMAGES=opena2a/dvaa,opena2a/other-image');
  process.exit(1);
}

const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
const db = new Database(dbPath);

const today = new Date().toISOString().split('T')[0];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'github-analytics-tracker' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getOrCreateImage(namespace, name) {
  const fullName = `${namespace}/${name}`;
  let record = db.prepare('SELECT * FROM docker_images WHERE namespace = ? AND name = ?').get(namespace, name);
  if (!record) {
    const result = db.prepare(
      'INSERT INTO docker_images (namespace, name, full_name) VALUES (?, ?, ?)'
    ).run(namespace, name, fullName);
    record = { id: result.lastInsertRowid, namespace, name, full_name: fullName };
    console.log('  Added new Docker image: %s', fullName);
  }
  return record;
}

async function collectImageStats(fullName) {
  const [namespace, name] = fullName.split('/');
  console.log('\nCollecting Docker stats for %s...', fullName);

  try {
    const data = await httpGet(`https://hub.docker.com/v2/repositories/${namespace}/${name}/`);

    const imageRecord = getOrCreateImage(namespace, name);

    // Update description if available
    if (data.description) {
      db.prepare('UPDATE docker_images SET description = ? WHERE id = ?')
        .run(data.description, imageRecord.id);
    }

    // Store daily pull count snapshot
    db.prepare(`
      INSERT INTO docker_pulls (image_id, date, pull_count, star_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(image_id, date) DO UPDATE SET
        pull_count = excluded.pull_count,
        star_count = excluded.star_count,
        collected_at = CURRENT_TIMESTAMP
    `).run(imageRecord.id, today, data.pull_count || 0, data.star_count || 0);

    console.log('  Pulls: %d | Stars: %d', data.pull_count || 0, data.star_count || 0);

    // Generate badge JSON
    const badgeData = {
      schemaVersion: 1,
      label: "docker pulls",
      message: (data.pull_count || 0).toLocaleString(),
      color: "blue",
      namedLogo: "docker",
      style: "social"
    };

    const safeImageName = fullName.replace('/', '_');
    const badgePath = path.join(__dirname, '..', 'data', `docker-badge-${safeImageName}.json`);
    fs.writeFileSync(badgePath, JSON.stringify(badgeData, null, 2));

  } catch (error) {
    console.error('  Failed: %s', error.message);
  }
}

async function main() {
  console.log('Docker Hub Analytics Collector');
  console.log('Date: %s', today);
  console.log('Tracking %d image(s)\n', DOCKER_IMAGES.length);

  for (const image of DOCKER_IMAGES) {
    await collectImageStats(image);
  }

  console.log('\nDocker collection complete!');
  db.close();
}

main().catch(error => {
  console.error('Fatal error: %s', error.message);
  process.exit(1);
});
