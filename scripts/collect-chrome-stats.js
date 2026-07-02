const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

// Chrome Web Store extensions to track.
// Format: <extensionId> or <extensionId>:<slug>, comma-separated.
// The 32-char extension id is the stable key; the slug (e.g. "ai-browser-guard")
// is only used to build a clean canonical URL and is auto-filled from the
// listing redirect when omitted.
//   CHROME_EXTENSIONS=ojphpdmabflmcjhglfogmkdgchkncikf
const CHROME_EXTENSIONS = (process.env.CHROME_EXTENSIONS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(entry => {
    const [id, slug] = entry.split(':').map(s => s.trim());
    return { id, slug: slug || null };
  });

/**
 * Parse the public Chrome Web Store listing HTML for the metrics Google exposes
 * on the page. Only the user count is a first-class number; rating/ratingCount/
 * version are best-effort and left null when they cannot be read unambiguously
 * (we never publish a guessed number — see Data Integrity rules).
 *
 * IMPORTANT: `users` is Google's rounded WEEKLY-ACTIVE-USER count, not a
 * cumulative install/download total. It is a snapshot, like GitHub stars.
 *
 * Exported for unit testing against a fixture.
 */
function parseListing(html) {
  // "2 users", "1,000+ users", "10,000+ users". Take the first match adjacent
  // to the category link; commas stripped, trailing "+" dropped (rounded floor).
  let users = null;
  const uMatch = html.match(/([\d,]+)\s*\+?\s*users?\b/i);
  if (uMatch) {
    const n = parseInt(uMatch[1].replace(/,/g, ''), 10);
    if (Number.isFinite(n)) users = n;
  }

  // Extension name from the page <title> ("Name - Chrome Web Store").
  let name = null;
  const tMatch = html.match(/<title>([^<]+?)\s*-\s*Chrome Web Store<\/title>/i);
  if (tMatch) name = tMatch[1].trim();

  // Rating count: "N ratings" / "N rating". Nullable.
  let ratingCount = null;
  const rcMatch = html.match(/([\d,]+)\s*ratings?\b/i);
  if (rcMatch) {
    const n = parseInt(rcMatch[1].replace(/,/g, ''), 10);
    if (Number.isFinite(n)) ratingCount = n;
  }

  // Average rating is only trustworthy when there is at least one rating; the
  // per-star markup is full of decoy "0 out of 5"/"5 out of 5" nodes, so we only
  // read the aggregate when ratingCount > 0 and a single clear value is present.
  let rating = null;
  if (ratingCount && ratingCount > 0) {
    const avgMatch = html.match(/([\d.]+)\s*out of 5\s*stars?\.?<\/[^>]*>\s*<[^>]*>\s*[\d,]+\s*ratings?/i)
      || html.match(/aria-label="([\d.]+) out of 5/i);
    if (avgMatch) {
      const v = parseFloat(avgMatch[1]);
      if (Number.isFinite(v) && v >= 0 && v <= 5) rating = v;
    }
  }

  // Version appears in an embedded JSON blob (escaped quotes). Best-effort.
  let version = null;
  const vMatch = html.match(/\\?"version\\?":\s*\\?"([\d][\d.]*)\\?"/);
  if (vMatch) version = vMatch[1];

  return { users, name, rating, ratingCount, version };
}

// Only construct DB/HTTP machinery when run as a script, so tests can require
// parseListing() without opening the database or hitting the network.
function httpGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        httpGetText(next, headers).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve({ body: data, finalUrl: url });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getOrCreateExtension(db, extensionId, name, slug) {
  let record = db.prepare('SELECT * FROM chrome_extensions WHERE extension_id = ?').get(extensionId);
  if (!record) {
    const result = db.prepare(
      'INSERT INTO chrome_extensions (extension_id, name, slug) VALUES (?, ?, ?)'
    ).run(extensionId, name || null, slug || null);
    record = { id: result.lastInsertRowid, extension_id: extensionId, name, slug };
    console.log('  Added new Chrome extension: %s', name || extensionId);
  } else {
    db.prepare(
      'UPDATE chrome_extensions SET name = COALESCE(?, name), slug = COALESCE(?, slug) WHERE id = ?'
    ).run(name || null, slug || null, record.id);
  }
  return record;
}

async function collectExtension(db, today, { id, slug }) {
  console.log('\nCollecting Chrome Web Store stats for %s...', id);
  try {
    const url = `https://chromewebstore.google.com/detail/${id}`;
    const { body, finalUrl } = await httpGetText(url);
    const parsed = parseListing(body);

    // Recover the slug from the redirect URL (.../detail/<slug>/<id>).
    let resolvedSlug = slug;
    const slugMatch = finalUrl.match(/\/detail\/([^/]+)\/[a-p]{32}/);
    if (slugMatch) resolvedSlug = slugMatch[1];

    const ext = getOrCreateExtension(db, id, parsed.name, resolvedSlug);
    if (parsed.version) {
      db.prepare('UPDATE chrome_extensions SET version = ? WHERE id = ?').run(parsed.version, ext.id);
    }

    if (parsed.users === null) {
      console.log('  Users: could not parse listing (page layout may have changed) — skipping snapshot');
      return;
    }

    db.prepare(`
      INSERT INTO chrome_stats (extension_id, date, users, rating, rating_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(extension_id, date) DO UPDATE SET
        users = excluded.users,
        rating = excluded.rating,
        rating_count = excluded.rating_count,
        collected_at = CURRENT_TIMESTAMP
    `).run(ext.id, today, parsed.users, parsed.rating, parsed.ratingCount);

    console.log('  Users: %d (weekly active, rounded) | Rating: %s (%s ratings) | v%s',
      parsed.users,
      parsed.rating ?? 'n/a',
      parsed.ratingCount ?? 'n/a',
      parsed.version || '?');

    // shields.io endpoint badge JSON (users).
    const safe = (resolvedSlug || id).replace(/[^a-z0-9._-]/gi, '_');
    fs.writeFileSync(
      path.join(__dirname, '..', 'data', `chrome-badge-${safe}.json`),
      JSON.stringify({
        schemaVersion: 1,
        label: 'chrome users',
        message: parsed.users.toLocaleString(),
        color: '4285F4',
        namedLogo: 'googlechrome',
        style: 'social',
      }, null, 2)
    );
    fs.writeFileSync(
      path.join(__dirname, '..', 'data', `chrome-stats-${safe}.json`),
      JSON.stringify({
        lastUpdated: new Date().toISOString(),
        extensionId: id,
        name: parsed.name,
        version: parsed.version,
        stats: {
          users: parsed.users,
          rating: parsed.rating,
          ratingCount: parsed.ratingCount,
          note: 'users = Google rounded weekly-active-user count, not cumulative installs',
        },
      }, null, 2)
    );
  } catch (error) {
    console.error('  Failed: %s', error.message);
  }
}

async function main() {
  if (CHROME_EXTENSIONS.length === 0) {
    console.error('Error: CHROME_EXTENSIONS environment variable is required');
    console.error('  CHROME_EXTENSIONS=ojphpdmabflmcjhglfogmkdgchkncikf  (comma-separated extension ids)');
    process.exit(1);
  }

  const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');
  const db = new Database(dbPath);
  const today = new Date().toISOString().split('T')[0];

  console.log('Chrome Web Store Analytics Collector');
  console.log('Date: %s', today);
  console.log('Tracking %d extension(s)\n', CHROME_EXTENSIONS.length);

  for (const ext of CHROME_EXTENSIONS) {
    await collectExtension(db, today, ext);
  }

  console.log('\nChrome collection complete!');
  db.close();
}

module.exports = { parseListing };

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error: %s', error.message);
    process.exit(1);
  });
}
