const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const http = require('node:http');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');

/*
 * A first-party telemetry count under ten, zero included, is withheld.
 *
 * Followed through every place a count is kept or shown: the collector stores
 * it as NULL (never the column's old DEFAULT 0), the store step clears every
 * count under ten already stored, /api/telemetry keeps the row and serves null,
 * and the dashboard reads "fewer than 10" where the number would be: never 0,
 * never by dropping the row, never sorted as if it held a value, and never
 * taken into a figure the page computes.
 *
 * Every fixture is synthetic. data/analytics.db is only ever copied, never
 * written. Every server listens on 127.0.0.1.
 */

const ROOT = join(__dirname, '..');
const LABEL = 'fewer than 10';
const NOTE = 'Figures under ten are withheld, zero included.';

// The telemetry tables as the store had them before counts became nullable:
// every count NOT NULL DEFAULT 0.
const NOT_NULL_SCHEMA = `
  CREATE TABLE telemetry_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, generated_at TEXT, provenance TEXT,
    retention_days INTEGER NOT NULL DEFAULT 0, wau_window_days INTEGER NOT NULL DEFAULT 0,
    mau_window_days INTEGER NOT NULL DEFAULT 0, total_installs INTEGER NOT NULL DEFAULT 0,
    wau INTEGER NOT NULL DEFAULT 0, mau INTEGER NOT NULL DEFAULT 0,
    engaged_mau INTEGER NOT NULL DEFAULT 0, engaged_min_days INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(date));
  CREATE TABLE telemetry_tool_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, tool TEXT NOT NULL,
    total_installs INTEGER NOT NULL DEFAULT 0, wau INTEGER NOT NULL DEFAULT 0,
    mau INTEGER NOT NULL DEFAULT 0, engaged_mau INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(date, tool));
  CREATE INDEX idx_telemetry_tool_date ON telemetry_tool_snapshots(date);
  CREATE TABLE telemetry_version_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, tool TEXT NOT NULL,
    version TEXT NOT NULL, installs INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(date, tool, version));
  CREATE INDEX idx_telemetry_version_date ON telemetry_version_snapshots(date);
  CREATE TABLE telemetry_country_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, country_code TEXT NOT NULL,
    installs INTEGER NOT NULL DEFAULT 0,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(date, country_code));
  CREATE INDEX idx_telemetry_country_date ON telemetry_country_snapshots(date);
`;

// The same tables with nullable counts, as a floored store holds them.
const NULLABLE_SCHEMA = NOT_NULL_SCHEMA.replace(
  /\b(total_installs|wau|mau|engaged_mau|installs) INTEGER NOT NULL DEFAULT 0/g, '$1 INTEGER'
);

const COUNT_COLUMNS = {
  telemetry_snapshots: ['total_installs', 'wau', 'mau', 'engaged_mau'],
  telemetry_tool_snapshots: ['total_installs', 'wau', 'mau', 'engaged_mau'],
  telemetry_version_snapshots: ['installs'],
  telemetry_country_snapshots: ['installs'],
};

// Rows still holding a count from 0 to 9: per tool, per version and fleet.
// Each must be 0 once the store is floored (a withheld count is NULL, which
// no BETWEEN counts).
const UNDER_TEN_CHECKS = [
  'SELECT count(*) FROM telemetry_tool_snapshots WHERE total_installs BETWEEN 0 AND 9 OR wau BETWEEN 0 AND 9 OR mau BETWEEN 0 AND 9 OR engaged_mau BETWEEN 0 AND 9',
  'SELECT count(*) FROM telemetry_version_snapshots WHERE installs BETWEEN 0 AND 9',
  'SELECT count(*) FROM telemetry_snapshots WHERE wau BETWEEN 0 AND 9 OR mau BETWEEN 0 AND 9 OR engaged_mau BETWEEN 0 AND 9',
];

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `telem-withheld-${prefix}-`));
}

function storeAt(file, schema, seed = () => {}) {
  const db = new Database(file);
  try {
    db.exec(schema);
    seed(db);
  } finally {
    db.close();
  }
  return file;
}

function readOnly(file, fn) {
  const db = new Database(file, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const underTenCounts = (file) => readOnly(file, db => UNDER_TEN_CHECKS.map(sql => db.prepare(sql).pluck().get()));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function spawnNode(args, { env = {}, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// The real collector against a stub feed on 127.0.0.1 and a scratch store.
// It runs in the store's directory, so the only .env it can load is none.
function collect(feed, dbFile) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(feed));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const dir = join(dbFile, '..');
        resolve(await spawnNode([join(ROOT, 'scripts', 'collect-telemetry-stats.js')], {
          cwd: dir,
          env: {
            REGISTRY_URL: `http://127.0.0.1:${server.address().port}`,
            TELEMETRY_DB_PATH: dbFile,
            TELEMETRY_BADGE_PATH: join(dir, 'telemetry-badge.json'),
            TELEMETRY_FEED_TIMEOUT_MS: '5000',
            GITHUB_ACTIONS: '',
          },
        }));
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

function floorStore(dbFile, summary = 'none') {
  return spawnNode([join(ROOT, 'scripts', 'floor-telemetry-counts.js'), `--db=${dbFile}`, `--summary=${summary}`], {
    cwd: join(dbFile, '..'),
  });
}

// /api/telemetry, loaded as Next.js serves it (its ES module default export
// rewritten to a CommonJS one), answering from <dir>/data/analytics.db.
async function serveTelemetry(dir) {
  const file = join(ROOT, 'pages', 'api', 'telemetry.js');
  const source = readFileSync(file, 'utf8');
  const exportLine = 'export default async function handler(';
  assert.ok(source.includes(exportLine), 'the route is a default-exported async function');
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(join(ROOT, 'pages', 'api'));
  mod._compile(source.replace(exportLine, 'module.exports = async function handler('), file);
  const res = {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await mod.exports({ query: {} }, res);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(res.statusCode, 200, `the route answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
  return res.body;
}

// pages/index.js compiled by the compiler `next build` uses, with the named
// components exported for the test, so the real dashboard markup is checked.
async function dashboard(...names) {
  const swc = require('next/dist/build/swc');
  await swc.loadBindings();
  const file = join(ROOT, 'pages', 'index.js');
  const source = `${readFileSync(file, 'utf8')}\nexport { ${names.join(', ')} };\n`;
  const { code } = await swc.transform(source, {
    filename: file,
    jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2020' },
    module: { type: 'commonjs' },
  });
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(join(ROOT, 'pages'));
  mod._compile(code, file);
  return mod.exports;
}

function render(component, props) {
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  return renderToStaticMarkup(createElement(component, props));
}

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();

// The tool table's body rows, each as its cells' text.
function tableRows(html) {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  assert.ok(body, 'the tool table renders');
  return [...body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => text(c[1])));
}

// Each KPI card's label, value and whether a change figure is rendered.
function kpis(html) {
  return html.split('<div class="kpi">').slice(1).map(card => ({
    label: text(/<div class="kpi-label">([\s\S]*?)<\/div>/.exec(card)[1]),
    value: text(/<div class="kpi-val">([\s\S]*?)<\/div>/.exec(card)[1]),
    sub: text((/<div class="kpi-sub">([\s\S]*?)<\/div>/.exec(card) || ['', ''])[1]),
    delta: /class="delta /.test(card),
  }));
}

function snapshot(over = {}) {
  return {
    asOf: '2026-11-02', generatedAt: '', provenance: '', retentionDays: 90, wauWindowDays: 7, mauWindowDays: 30,
    totalInstalls: 400, wau: 120, mau: 340, engagedMau: 60, engagedMinDays: 2,
    wauGrowth7d: null, mauGrowth30d: null, engagedGrowth30d: null,
    ...over,
  };
}

const withheldTool = (tool, versions = [{ version: '1.0.0', installs: null }]) => (
  { tool, product: tool, totalInstalls: null, wau: null, mau: null, engagedMau: null, versions }
);

test('normalizeAdoptionFeed keeps a tool row whose figures are withheld and floors every count under ten to null', () => {
  const { normalizeAdoptionFeed } = require(join(ROOT, 'lib', 'telemetry.js'));
  const n = normalizeAdoptionFeed({
    totalInstalls: 0, wau: 9, mau: 10, engagedMau: null,
    tools: [
      { tool: 'tool-a', totalInstalls: null, wau: null, mau: null, engagedMau: null, versions: [{ version: '1.0.0', installs: null }] },
      { tool: 'tool-b', totalInstalls: 0, wau: 1, mau: 9, engagedMau: 0, versions: [{ version: '2.0.0', installs: 3 }] },
      { tool: 'tool-c', totalInstalls: 12, wau: 10, mau: 11, engagedMau: 10, versions: [{ version: '3.0.0', installs: 10 }] },
      { tool: 'tool-x', totalInstalls: 'many', wau: 10, mau: 10, engagedMau: 10 }, // not a figure: dropped
    ],
    byCountry: [{ countryCode: 'AA', installs: 4 }, { countryCode: 'BB', installs: 25 }],
  });
  assert.deepStrictEqual(
    [n.totalInstalls, n.wau, n.mau, n.engagedMau], [null, null, 10, null],
    'fleet: 0 and 9 and a withheld figure are null, 10 is kept'
  );
  assert.deepStrictEqual(n.tools.map(t => t.tool), ['tool-a', 'tool-b', 'tool-c'], 'the withheld row is kept, the untrusted one dropped');
  assert.deepStrictEqual(n.tools.map(t => [t.totalInstalls, t.wau, t.mau, t.engagedMau]), [
    [null, null, null, null],
    [null, null, null, null],
    [12, 10, 11, 10],
  ]);
  assert.deepStrictEqual(n.tools.map(t => t.versions), [
    [{ version: '1.0.0', installs: null }],
    [{ version: '2.0.0', installs: null }],
    [{ version: '3.0.0', installs: 10 }],
  ]);
  assert.deepStrictEqual(n.byCountry, [{ countryCode: 'AA', installs: null }, { countryCode: 'BB', installs: 25 }]);
});

test('normalizeAdoptionFeed accepts a fleet whose totals are all withheld, and still rejects one that omits them', () => {
  const { normalizeAdoptionFeed } = require(join(ROOT, 'lib', 'telemetry.js'));
  const n = normalizeAdoptionFeed({ totalInstalls: null, wau: null, mau: null, engagedMau: null, tools: [] });
  assert.deepStrictEqual([n.totalInstalls, n.wau, n.mau, n.engagedMau], [null, null, null, null]);
  assert.throws(() => normalizeAdoptionFeed({ wau: null, mau: null }), /fleet totals/, 'a missing total is not a withheld one');
  assert.throws(() => normalizeAdoptionFeed({ totalInstalls: 50, wau: 20, mau: 30, engagedMau: 'x' }), /engagedMau/);
});

test('a feed whose per-tool totalInstalls, wau, mau and engagedMau are null keeps the row through the store, the API and the dashboard, each cell reading "fewer than 10", never 0', async () => {
  const dir = tmp('chain');
  try {
    mkdirSync(join(dir, 'data'));
    const dbFile = storeAt(join(dir, 'data', 'analytics.db'), NOT_NULL_SCHEMA);
    const run = await collect({
      generatedAt: '2026-11-02T00:00:00Z', provenance: 'synthetic feed', retentionDays: 90, wauWindowDays: 7,
      mauWindowDays: 30, totalInstalls: 400, wau: 120, mau: 340, engagedMau: 60, engagedMinDays: 2,
      tools: [
        { tool: 'tool-a', totalInstalls: null, wau: null, mau: null, engagedMau: null, versions: [{ version: '1.0.0', installs: null }] },
        { tool: 'tool-b', totalInstalls: 300, wau: 110, mau: 300, engagedMau: 55, versions: [{ version: '2.0.0', installs: 250 }] },
      ],
      byCountry: [],
    }, dbFile);
    assert.equal(run.status, 0, `the collection is stored; output:\n${run.stdout}\n${run.stderr}`);

    const body = await serveTelemetry(dir);
    const a = body.tools.find(t => t.tool === 'tool-a');
    assert.ok(a, `the API keeps the row whose figures are withheld; served: ${JSON.stringify(body.tools.map(t => t.tool))}`);
    for (const field of ['totalInstalls', 'wau', 'mau', 'engagedMau']) {
      assert.strictEqual(a[field], null, `${field} is served as null, never 0`);
    }
    assert.deepStrictEqual(a.versions, [{ version: '1.0.0', installs: null }]);

    const { TelemetrySection } = await dashboard('TelemetrySection');
    const row = tableRows(render(TelemetrySection, { data: body })).find(cells => cells[0].startsWith('tool-a'));
    assert.ok(row, 'the dashboard keeps the row');
    assert.deepStrictEqual(row.slice(1), [LABEL, LABEL, LABEL, LABEL, `each version ${LABEL}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dashboard reads "fewer than 10" in every withheld cell, never 0, and states the rule once', async () => {
  const { TelemetrySection } = await dashboard('TelemetrySection');
  const html = render(TelemetrySection, {
    data: {
      snapshot: snapshot({ totalInstalls: null, wau: null, mau: null, engagedMau: null, provenance: 'Synthetic provenance.' }),
      tools: [
        { tool: 'tool-b', product: 'Tool B', totalInstalls: 300, wau: 110, mau: 300, engagedMau: 55, versions: [{ version: '2.0.0', installs: 250 }] },
        withheldTool('tool-a'),
      ],
      byCountry: [{ countryCode: 'BB', installs: 25 }, { countryCode: 'AA', installs: null }],
    },
  });
  const cards = kpis(html);
  assert.deepStrictEqual(cards.map(c => [c.label, c.value]), [
    ['Engaged monthly users', LABEL],
    ['Reported MAU', LABEL],
    ['Reported WAU', LABEL],
  ]);
  const rows = tableRows(html);
  assert.deepStrictEqual(rows, [
    ['Tool Btool-b', '300', '55', '300', '110', '2.0.0 · 250'],
    ['tool-a', LABEL, LABEL, LABEL, LABEL, `each version ${LABEL}`],
  ]);
  for (const cell of rows.flat()) assert.doesNotMatch(cell, /^0$|· 0$/, `no withheld cell reads 0: ${cell}`);
  const chipRow = /<div style="margin-top:14px;display:flex[^"]*">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(chipRow, 'the country chips render');
  const chips = chipRow[1].split('<span class="chip"').slice(1).map(p => text(p.slice(p.indexOf('>') + 1)));
  assert.deepStrictEqual(chips, ['BB · 25', `AA · ${LABEL}`]);
  assert.ok(text(html).includes(`Synthetic provenance. ${NOTE}`), 'the provenance carries the withheld note');
  assert.equal(text(html).split(NOTE).length - 1, 1, 'the note is stated once');
});

test('the overview KPI reads "fewer than 10" for a withheld engaged or reported count, never 0', async () => {
  const { ActiveCliUsersKpi } = await dashboard('ActiveCliUsersKpi');
  const [card] = kpis(render(ActiveCliUsersKpi, { snapshot: snapshot({ engagedMau: null, mau: null, engagedGrowth30d: 5 }) }));
  assert.deepStrictEqual(card, {
    label: 'Active CLI Users', value: LABEL, sub: `engaged monthly · ${LABEL} reported`, delta: false,
  });
  const [measured] = kpis(render(ActiveCliUsersKpi, { snapshot: snapshot({ engagedMau: 60, mau: 340, engagedGrowth30d: 12 }) }));
  assert.deepStrictEqual([measured.value, measured.sub, measured.delta], ['60', 'engaged monthly · 340 reported', true]);
});

test('a figure the dashboard computes leaves a withheld cell out: no change against a withheld side, no withheld version named as the top one', async () => {
  const { TelemetrySection } = await dashboard('TelemetrySection');
  const html = render(TelemetrySection, {
    data: {
      // engaged 12 now, 7 a month ago (withheld): no change can be computed.
      // MAU 330 now, 300 a month ago: both measured, so the change shows.
      // WAU withheld now: no change either.
      snapshot: snapshot({ engagedMau: 12, engagedGrowth30d: 5, mau: 330, mauGrowth30d: 30, wau: null, wauGrowth7d: 4 }),
      tools: [{
        tool: 'tool-c', product: 'tool-c', totalInstalls: 80, wau: 20, mau: 60, engagedMau: 15,
        // A withheld version listed first is never taken as the top one.
        versions: [{ version: '2.0.0', installs: null }, { version: '1.1.0', installs: 15 }, { version: '1.0.0', installs: 40 }],
      }],
      byCountry: [],
    },
  });
  assert.deepStrictEqual(kpis(html).map(c => [c.label, c.delta]), [
    ['Engaged monthly users', false],
    ['Reported MAU', true],
    ['Reported WAU', false],
  ]);
  assert.match(html, /\+10%/, 'the measured change is computed from measured values only');
  assert.deepStrictEqual(tableRows(html)[0][5], '1.0.0 · 40');
});

test('/api/telemetry serves only floored counts, keeps every row, and orders a withheld row after the measured ones by name, never by the count it hides', async () => {
  const dir = tmp('api');
  try {
    mkdirSync(join(dir, 'data'));
    // A store holding NULLs and, as an older store did, raw counts under ten.
    storeAt(join(dir, 'data', 'analytics.db'), NULLABLE_SCHEMA, (db) => {
      db.prepare('INSERT INTO telemetry_snapshots (date, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?)')
        .run('2026-11-02', 0, 9, 120, null);
      const tool = db.prepare('INSERT INTO telemetry_tool_snapshots (date, tool, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?, ?)');
      tool.run('2026-11-02', 'tool-c', 0, 20, 50, 12);
      tool.run('2026-11-02', 'tool-a', null, null, null, null);
      tool.run('2026-11-02', 'tool-b', 0, 3, 7, 1);
      tool.run('2026-11-02', 'tool-d', 0, 1, 3, 0);
      const version = db.prepare('INSERT INTO telemetry_version_snapshots (date, tool, version, installs) VALUES (?, ?, ?, ?)');
      version.run('2026-11-02', 'tool-c', '1.0.0', 30);
      version.run('2026-11-02', 'tool-c', '1.1.0', 8);
      version.run('2026-11-02', 'tool-c', '0.9.0', 4);
      version.run('2026-11-02', 'tool-c', '0.8.0', null);
      const country = db.prepare('INSERT INTO telemetry_country_snapshots (date, country_code, installs) VALUES (?, ?, ?)');
      country.run('2026-11-02', 'BB', 6);
      country.run('2026-11-02', 'AA', 2);
      country.run('2026-11-02', 'CC', 11);
    });
    const body = await serveTelemetry(dir);
    const s = body.snapshot;
    assert.deepStrictEqual([s.totalInstalls, s.wau, s.mau, s.engagedMau], [null, null, 120, null]);
    assert.deepStrictEqual(body.tools.map(t => [t.tool, t.totalInstalls, t.wau, t.mau, t.engagedMau]), [
      ['tool-c', null, 20, 50, 12],
      ['tool-a', null, null, null, null],
      ['tool-b', null, null, null, null],
      ['tool-d', null, null, null, null],
    ]);
    assert.deepStrictEqual(body.tools[0].versions, [
      { version: '1.0.0', installs: 30 },
      { version: '0.8.0', installs: null },
      { version: '0.9.0', installs: null },
      { version: '1.1.0', installs: null },
    ]);
    assert.deepStrictEqual(body.byCountry, [
      { countryCode: 'CC', installs: 11 },
      { countryCode: 'AA', installs: null },
      { countryCode: 'BB', installs: null },
    ]);
    assert.deepStrictEqual(body.withheld, { below: 10, label: LABEL });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the collector stores NULL for a withheld figure and for a count from 0 to 9, stores 10 or more as is, and keeps every row', async () => {
  const dir = tmp('collect');
  try {
    const dbFile = storeAt(join(dir, 'analytics.db'), NOT_NULL_SCHEMA);
    const run = await collect({
      retentionDays: 90, wauWindowDays: 7, mauWindowDays: 30, engagedMinDays: 2,
      totalInstalls: 0, wau: 9, mau: 10, engagedMau: null,
      tools: [
        {
          tool: 'tool-a', totalInstalls: null, wau: 1, mau: 9, engagedMau: 0,
          versions: [{ version: '1.0.0', installs: null }, { version: '0.9.0', installs: 3 }, { version: '0.8.0', installs: 10 }],
        },
        { tool: 'tool-b', totalInstalls: 12, wau: 10, mau: 11, engagedMau: 10, versions: [] },
      ],
      byCountry: [{ countryCode: 'AA', installs: 4 }, { countryCode: 'BB', installs: 10 }],
    }, dbFile);
    assert.equal(run.status, 0, `output:\n${run.stdout}\n${run.stderr}`);
    readOnly(dbFile, (db) => {
      assert.deepStrictEqual(db.prepare('SELECT total_installs, wau, mau, engaged_mau FROM telemetry_snapshots').all(), [
        { total_installs: null, wau: null, mau: 10, engaged_mau: null },
      ]);
      assert.deepStrictEqual(
        db.prepare('SELECT tool, total_installs, wau, mau, engaged_mau FROM telemetry_tool_snapshots ORDER BY tool').all(), [
          { tool: 'tool-a', total_installs: null, wau: null, mau: null, engaged_mau: null },
          { tool: 'tool-b', total_installs: 12, wau: 10, mau: 11, engaged_mau: 10 },
        ]
      );
      assert.deepStrictEqual(db.prepare('SELECT version, installs FROM telemetry_version_snapshots ORDER BY version').all(), [
        { version: '0.8.0', installs: 10 },
        { version: '0.9.0', installs: null },
        { version: '1.0.0', installs: null },
      ]);
      assert.deepStrictEqual(db.prepare('SELECT country_code, installs FROM telemetry_country_snapshots ORDER BY country_code').all(), [
        { country_code: 'AA', installs: null },
        { country_code: 'BB', installs: 10 },
      ]);
      for (const [table, cols] of Object.entries(COUNT_COLUMNS)) {
        for (const c of db.prepare(`PRAGMA table_info(${table})`).all().filter(c => cols.includes(c.name))) {
          assert.deepStrictEqual([c.notnull, c.dflt_value], [0, null], `${table}.${c.name} is nullable with no default`);
        }
      }
    });
    assert.match(
      run.stdout,
      new RegExp(`Installs: ${LABEL} \\| WAU: ${LABEL} \\| MAU: 10 \\| engaged\\(MAU\\): ${LABEL} \\| tools: 2 \\| countries: 2`),
      'the public log line carries floored figures only'
    );
    assert.equal(JSON.parse(readFileSync(join(dir, 'telemetry-badge.json'), 'utf8')).message, '10');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store step sets every stored count from 0 to 9 to withheld, zero included, keeps every row and every count of 10 or more, and changes nothing on a second run', async () => {
  const dir = tmp('floor');
  try {
    const dbFile = storeAt(join(dir, 'analytics.db'), NOT_NULL_SCHEMA, (db) => {
      const fleet = db.prepare('INSERT INTO telemetry_snapshots (date, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?)');
      fleet.run('2026-10-01', 0, 3, 120, 9);
      fleet.run('2026-10-02', 0, 15, 130, 40);
      const tool = db.prepare('INSERT INTO telemetry_tool_snapshots (date, tool, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?, ?)');
      tool.run('2026-10-01', 'tool-a', 0, 1, 9, 0);
      tool.run('2026-10-01', 'tool-b', 0, 25, 60, 12);
      tool.run('2026-10-02', 'tool-a', 0, 10, 11, 2);
      const version = db.prepare('INSERT INTO telemetry_version_snapshots (date, tool, version, installs) VALUES (?, ?, ?, ?)');
      version.run('2026-10-01', 'tool-a', '1.0.0', 4);
      version.run('2026-10-01', 'tool-b', '2.0.0', 33);
      version.run('2026-10-02', 'tool-a', '1.0.0', 0);
      const country = db.prepare('INSERT INTO telemetry_country_snapshots (date, country_code, installs) VALUES (?, ?, ?)');
      country.run('2026-10-01', 'AA', 5);
      country.run('2026-10-01', 'BB', 18);
    });
    assert.deepStrictEqual(underTenCounts(dbFile), [3, 2, 1], 'the fixture holds counts under ten');

    const first = await floorStore(dbFile);
    assert.equal(first.status, 0, `output:\n${first.stdout}\n${first.stderr}`);
    assert.deepStrictEqual(underTenCounts(dbFile), [0, 0, 0], 'per tool, per version and fleet: no count from 0 to 9 is left');
    readOnly(dbFile, (db) => {
      assert.deepStrictEqual(db.prepare('SELECT date, total_installs, wau, mau, engaged_mau FROM telemetry_snapshots ORDER BY date').all(), [
        { date: '2026-10-01', total_installs: null, wau: null, mau: 120, engaged_mau: null },
        { date: '2026-10-02', total_installs: null, wau: 15, mau: 130, engaged_mau: 40 },
      ]);
      assert.deepStrictEqual(db.prepare('SELECT date, tool, total_installs, wau, mau, engaged_mau FROM telemetry_tool_snapshots ORDER BY date, tool').all(), [
        { date: '2026-10-01', tool: 'tool-a', total_installs: null, wau: null, mau: null, engaged_mau: null },
        { date: '2026-10-01', tool: 'tool-b', total_installs: null, wau: 25, mau: 60, engaged_mau: 12 },
        { date: '2026-10-02', tool: 'tool-a', total_installs: null, wau: 10, mau: 11, engaged_mau: null },
      ]);
      assert.deepStrictEqual(db.prepare('SELECT date, tool, version, installs FROM telemetry_version_snapshots ORDER BY date, tool').all(), [
        { date: '2026-10-01', tool: 'tool-a', version: '1.0.0', installs: null },
        { date: '2026-10-01', tool: 'tool-b', version: '2.0.0', installs: 33 },
        { date: '2026-10-02', tool: 'tool-a', version: '1.0.0', installs: null },
      ]);
      assert.deepStrictEqual(db.prepare('SELECT country_code, installs FROM telemetry_country_snapshots ORDER BY country_code').all(), [
        { country_code: 'AA', installs: null },
        { country_code: 'BB', installs: 18 },
      ]);
      for (const [table, cols] of Object.entries(COUNT_COLUMNS)) {
        for (const c of db.prepare(`PRAGMA table_info(${table})`).all().filter(c => cols.includes(c.name))) {
          assert.deepStrictEqual([c.notnull, c.dflt_value], [0, null], `${table}.${c.name} is nullable with no default`);
        }
      }
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_telemetry_%' ORDER BY name").pluck().all();
      assert.deepStrictEqual(indexes, ['idx_telemetry_country_date', 'idx_telemetry_tool_date', 'idx_telemetry_version_date']);
    });

    const before = sha256(dbFile);
    const second = await floorStore(dbFile);
    assert.equal(second.status, 0, `output:\n${second.stdout}\n${second.stderr}`);
    assert.equal(sha256(dbFile), before, 'a second run leaves the file byte for byte as it was');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store step refuses a table it could only rebuild by dropping a column, and leaves the store byte for byte as it was', async () => {
  const dir = tmp('refuse');
  try {
    const dbFile = storeAt(
      join(dir, 'analytics.db'),
      NOT_NULL_SCHEMA.replace('collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(date, tool)', 'note TEXT, collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(date, tool)'),
      (db) => {
        db.prepare('INSERT INTO telemetry_snapshots (date, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?)').run('2026-10-01', 0, 3, 120, 9);
        db.prepare('INSERT INTO telemetry_tool_snapshots (date, tool, wau, note) VALUES (?, ?, ?, ?)').run('2026-10-01', 'tool-a', 4, 'kept');
      }
    );
    const before = sha256(dbFile);
    const run = await floorStore(dbFile);
    assert.equal(run.status, 1, `output:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /telemetry_tool_snapshots has columns the floored schema does not carry: note/);
    assert.equal(sha256(dbFile), before, 'no table was rebuilt and no count was changed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on a copy of the committed store, the store step leaves no count from 0 to 9 per tool, per version or fleet, and keeps every row and every count of 10 or more', async () => {
  const dir = tmp('committed');
  try {
    const dbFile = join(dir, 'analytics.db');
    copyFileSync(join(ROOT, 'data', 'analytics.db'), dbFile);
    const shape = (file) => readOnly(file, db => Object.entries(COUNT_COLUMNS).map(([table, cols]) => [
      table,
      db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),
      ...cols.map(c => db.prepare(`SELECT count(*) FROM ${table} WHERE ${c} >= 10`).pluck().get()),
    ]));
    const before = shape(dbFile);
    const run = await floorStore(dbFile);
    assert.equal(run.status, 0, `output:\n${run.stdout}\n${run.stderr}`);
    assert.deepStrictEqual(underTenCounts(dbFile), [0, 0, 0]);
    assert.deepStrictEqual(shape(dbFile), before, 'row counts and counts of 10 or more are unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store step rewrites the summary telemetry block from the floored store and leaves every other key as it was', async () => {
  const dir = tmp('summary');
  try {
    const dbFile = storeAt(join(dir, 'analytics.db'), NOT_NULL_SCHEMA, (db) => {
      db.prepare('INSERT INTO telemetry_snapshots (date, provenance, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?, ?)')
        .run('2026-11-02', 'synthetic', 0, 4, 120, 30);
      db.prepare('INSERT INTO telemetry_tool_snapshots (date, tool, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?, ?)')
        .run('2026-11-02', 'tool-a', 0, 2, 5, 1);
    });
    const summaryFile = join(dir, 'summary.json');
    const summary = {
      lastUpdated: '2026-11-02T06:10:00.000Z',
      total: {
        npm: 1234,
        telemetry: { asOf: '2026-11-02', totalInstalls: 0, wau: 4, mau: 120, engagedMau: 30, tools: 1, countries: 0, provenance: 'synthetic' },
        chromeUsers: 50,
      },
      series: { downloads: { value: 99 } },
    };
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    const run = await floorStore(dbFile, summaryFile);
    assert.equal(run.status, 0, `output:\n${run.stdout}\n${run.stderr}`);
    const out = JSON.parse(readFileSync(summaryFile, 'utf8'));
    assert.deepStrictEqual(out.total.telemetry, {
      asOf: '2026-11-02', totalInstalls: null, wau: null, mau: 120, engagedMau: 30,
      withheld: { below: 10, label: LABEL }, tools: 1, countries: 0, provenance: 'synthetic',
    });
    assert.deepStrictEqual({ ...out, total: { ...out.total, telemetry: null } }, { ...summary, total: { ...summary.total, telemetry: null } });
    assert.deepStrictEqual(Object.keys(out.total), Object.keys(summary.total), 'key order is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the summary builder publishes a telemetry count under ten, and a withheld one, as null, never as 0', () => {
  const { buildSummary } = require(join(ROOT, 'lib', 'summary.js'));
  const src = new Database(join(ROOT, 'data', 'analytics.db'), { readonly: true });
  const db = new Database(src.serialize());
  src.close();
  const dataDir = tmp('build');
  try {
    // A fleet table with nullable counts holding synthetic rows.
    db.exec('DROP TABLE telemetry_snapshots');
    db.exec(NULLABLE_SCHEMA.split(';')[0]);
    db.prepare('INSERT INTO telemetry_snapshots (date, provenance, total_installs, wau, mau, engaged_mau) VALUES (?, ?, ?, ?, ?, ?)')
      .run('2999-01-02', 'synthetic', null, 3, 120, null);
    const t = buildSummary(db, { dataDir, env: {} }).total.telemetry;
    assert.deepStrictEqual([t.asOf, t.totalInstalls, t.wau, t.mau, t.engagedMau], ['2999-01-02', null, null, 120, null]);
    assert.deepStrictEqual(t.withheld, { below: 10, label: LABEL });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
