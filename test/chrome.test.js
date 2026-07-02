const { test } = require('node:test');
const assert = require('node:assert');
const { parseListing } = require('../scripts/collect-chrome-stats');

// A trimmed, realistic slice of the Chrome Web Store listing markup.
const listing = (usersFrag, extras = '') => `
<!doctype html><html><head>
<title>AI Browser Guard - Chrome Web Store</title>
</head><body>
<a href="/category/extensions/tools">Developer Tools</a>${usersFrag}</div>
${extras}
<script>{\\"name\\":\\"AI Browser Guard\\",\\"version\\":\\"0.4.2\\"}</script>
</body></html>`;

test('parses an exact small user count', () => {
  const r = parseListing(listing('<div>2 users'));
  assert.equal(r.users, 2);
  assert.equal(r.name, 'AI Browser Guard');
  assert.equal(r.version, '0.4.2');
});

test('parses a rounded, comma+plus user count as its floor', () => {
  assert.equal(parseListing(listing('<div>1,000+ users')).users, 1000);
  assert.equal(parseListing(listing('<div>10,000+ users')).users, 10000);
});

test('handles singular "1 user"', () => {
  assert.equal(parseListing(listing('<div>1 user')).users, 1);
});

test('returns null users when the count is absent (never fabricates)', () => {
  const r = parseListing('<html><head><title>X - Chrome Web Store</title></head><body>no count</body></html>');
  assert.equal(r.users, null);
});

test('rating is null when there are no ratings', () => {
  // Page full of decoy per-star "0 out of 5" nodes but no aggregate rating count.
  const r = parseListing(listing('<div>2 users', '<div>0 out of 5 stars.</div>'));
  assert.equal(r.rating, null);
  assert.equal(r.ratingCount, null);
});

test('extracts rating count when present', () => {
  const r = parseListing(listing('<div>500+ users', '<span>42 ratings</span>'));
  assert.equal(r.users, 500);
  assert.equal(r.ratingCount, 42);
});
