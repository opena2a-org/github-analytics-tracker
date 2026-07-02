import { useState, useEffect, useMemo } from 'react';
import Head from 'next/head';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart, PieChart, Pie, Cell,
} from 'recharts';
import {
  GitFork, Star, Eye, GitPullRequest, Users, Download, Heart,
  Package, TrendingUp, TrendingDown, Container, Activity,
  Github, Box, Brain, Menu, Search, ArrowUp, ArrowDown, FileText, Chrome,
} from 'lucide-react';

/* ============================================================
   Source identity — one place defines color + icon per source
   ============================================================ */
const SOURCES = {
  overview:    { label: 'Overview',    icon: Activity,  color: 'var(--accent)' },
  github:      { label: 'GitHub',      icon: Github,    color: 'var(--c-github)' },
  standards:   { label: 'Standards',   icon: FileText,  color: 'var(--c-standards)' },
  npm:         { label: 'npm',         icon: Box,       color: 'var(--c-npm)' },
  pypi:        { label: 'PyPI',        icon: Package,   color: 'var(--c-pypi)' },
  docker:      { label: 'Docker',      icon: Container, color: 'var(--c-docker)' },
  huggingface: { label: 'HuggingFace', icon: Brain,     color: 'var(--c-hf)' },
  chrome:      { label: 'Chrome',      icon: Chrome,    color: '#4285F4' },
};
const TAB_ORDER = ['overview', 'github', 'standards', 'npm', 'pypi', 'docker', 'huggingface', 'chrome'];

/* Detail-tab time ranges (drive the `days` query param) */
const TIME_RANGES = [
  { label: '7d', value: '7' }, { label: '30d', value: '30' },
  { label: '90d', value: '90' }, { label: '1yr', value: '365' },
  { label: 'All', value: 'all' },
];
/* Overview adoption periods (match what the data supports) */
const PERIODS = [
  { label: '24h', value: '24h' }, { label: '7d', value: '7d' },
  { label: '30d', value: '30d' }, { label: 'All', value: 'all' },
  { label: 'Custom', value: 'custom' },
];
const PERIOD_LABEL = { '24h': 'last 24h', '7d': 'last 7d', '30d': 'last 30d', all: 'all time', custom: 'custom range' };

const GRANULARITIES = [
  { label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' }, { label: 'Monthly', value: 'monthly' },
];

/* Hex palette for recharts (CSS vars can't be read by SVG fills) */
const C = {
  accent: '#2dd4bf', github: '#6e9bff', npm: '#ff7a7a', pypi: '#f5b53c',
  docker: '#4cb8f5', hf: '#ffce4d', chrome: '#4285F4', violet: '#a78bfa', pink: '#f472b6', green: '#34d399',
  standards: '#34d399',
  grid: 'rgba(255,255,255,0.055)', axis: '#5f6c82',
  fill: (hex, a = 0.16) => hexA(hex, a),
};
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const ax = { fontSize: 11, tick: { fill: C.axis } };
const axDate = { ...ax, tickFormatter: fmtDate };
const tt = {
  contentStyle: { background: '#171c29', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 9, fontSize: 12, color: '#eef2f8' },
  itemStyle: { color: '#9aa7bd' },
};
const BREAKDOWN_COLORS = ['#6e9bff', '#2dd4bf', '#f5b53c', '#ff7a7a', '#a78bfa', '#4cb8f5', '#ffce4d', '#f472b6', '#34d399', '#fb923c'];

/* ============================================================
   Formatting helpers
   ============================================================ */
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtNum(n) {
  if (n == null) return '0';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}
function fmtFull(n) { return (n || 0).toLocaleString(); }
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}
/* Percentage change, or null when it can't be computed honestly */
function pctChange(curr, prev) {
  if (prev == null || curr == null || prev === 0) return null;
  return parseFloat((((curr - prev) / prev) * 100).toFixed(1));
}

function toWeekKey(s) {
  const d = new Date(s + 'T00:00:00Z'); const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day + (day === 0 ? -6 : 1));
  return d.toISOString().split('T')[0];
}
function weeklyDownloads(rows) {
  if (!rows?.length) return [];
  const w = {};
  rows.forEach(d => { const k = toWeekKey(d.date); (w[k] = w[k] || { week: k, downloads: 0 }).downloads += d.downloads || 0; });
  return Object.values(w).sort((a, b) => a.week.localeCompare(b.week));
}

/* Period picker for product rows (shared by table + KPI aggregation) */
function periodPick(o, allKey, k30, k7, k24, period, kCustom) {
  if (!o) return 0;
  switch (period) {
    case '24h': return o[k24] || 0;
    case '7d': return o[k7] || 0;
    case '30d': return o[k30] || 0;
    case 'custom': return o[kCustom] || 0;
    default: return o[allKey] || 0;
  }
}
/* Star growth for the selected period. Stars are cumulative, so this is the
   count gained within the window (not a percentage). */
function starGrowthPick(g, period) {
  switch (period) {
    case '24h': return g?.starsGrowth24h;
    case '7d': return g?.starsGrowth7d;
    case '30d': return g?.starsGrowth30d;
    case 'custom': return g?.starsGrowthCustom;
    default: return g?.starsGrowthAll;
  }
}
/* HuggingFace only reports all-time + rolling 30d, nothing finer */
function hfPeriod(hf, period) {
  if (!hf) return null;
  if (period === 'all') return hf.downloadsAllTime || 0;
  if (period === '30d') return hf.downloads30d || 0;
  return null; // 24h / 7d / custom -> not measured at this granularity
}
function rowAdoption(p, period) {
  const clones = periodPick(p.github, 'clones', 'clones30d', 'clones7d', 'clones24h', period, 'customClones');
  const npm = periodPick(p.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
  const pypi = periodPick(p.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
  const docker = period === 'all' ? (p.docker?.totalPulls || 0) : 0;
  const hf = hfPeriod(p.hf, period) || 0;
  return clones + npm + pypi + docker + hf;
}

/* ============================================================
   Primitive UI
   ============================================================ */
function Delta({ value, size = 'sm' }) {
  if (value == null || !isFinite(value)) return null;
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const Icon = value > 0 ? TrendingUp : value < 0 ? TrendingDown : null;
  return (
    <span className={`delta ${cls}`}>
      {Icon && <Icon size={12} />}{value > 0 ? '+' : ''}{value}%
    </span>
  );
}
function MiniDelta({ curr, prev }) {
  const v = pctChange(curr, prev);
  if (v == null || v === 0) return null;
  return <span className={`delta-mini ${v > 0 ? 'up' : 'down'}`}>{v > 0 ? '+' : ''}{v}%</span>;
}
/* Absolute count gained in the period (e.g. +5). Stars are cumulative, so a
   percentage would be noise; show the raw growth instead. */
function StarGrowth({ value }) {
  if (value == null || value === 0) return null;
  return <span className={`delta-mini ${value > 0 ? 'up' : 'down'}`}>{value > 0 ? '+' : ''}{fmtFull(value)}</span>;
}

function Kpi({ icon, color, label, value, sub, delta }) {
  return (
    <div className="kpi">
      <div className="kpi-top">
        <div className="kpi-ico" style={{ background: hexA(color, 0.12), color }}>{icon}</div>
        {delta != null && <Delta value={delta} />}
      </div>
      <div className="kpi-label">{label}</div>
      <div className="kpi-val">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function Panel({ title, sub, tools, children, pad = true }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          {sub && <div className="panel-sub">{sub}</div>}
        </div>
        {tools && <div className="panel-tools">{tools}</div>}
      </div>
      {pad ? <div className="panel-body">{children}</div> : children}
    </div>
  );
}

function Chart({ title, sub, tools, height = 300, children }) {
  return (
    <div className="chart">
      <div className="chart-head">
        <div>
          <div className="chart-title">{title}</div>
          {sub && <div className="chart-sub">{sub}</div>}
        </div>
        {tools}
      </div>
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  );
}

function Segmented({ items, value, onChange }) {
  return (
    <div className="segmented">
      {items.map(it => (
        <button key={it.value} className={`seg-btn ${value === it.value ? 'active' : ''}`} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Filter({ value, onChange, placeholder }) {
  return (
    <div className="filter">
      <Search size={14} className="ico" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || 'Search...'} />
    </div>
  );
}

function SecLabel({ children }) {
  return <div className="sec-label"><h2>{children}</h2><div className="rule" /></div>;
}
function Loading() { return <div className="loading"><div className="spinner" /><p>Loading analytics…</p></div>; }
function Empty({ message, command }) {
  return <div className="empty"><Activity size={32} color="#3c4659" /><p>{message}</p>{command && <code>{command}</code>}</div>;
}

/* ============================================================
   DataTable — sortable, with optional row selection + footer
   columns: { key, label, align?, sortable?, render?(row), sortValue?(row) }
   ============================================================ */
function DataTable({ columns, rows, getKey, onRowClick, selectedKey, initialSort, footer }) {
  const [sort, setSort] = useState(initialSort || { key: columns[0].key, dir: 'asc' });

  const sorted = useMemo(() => {
    const col = columns.find(c => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue || (r => r[col.key]);
    return [...rows].sort((a, b) => {
      const av = get(a), bv = get(b);
      if (typeof av === 'number' && typeof bv === 'number') return sort.dir === 'asc' ? av - bv : bv - av;
      return sort.dir === 'asc' ? String(av ?? '').localeCompare(String(bv ?? '')) : String(bv ?? '').localeCompare(String(av ?? ''));
    });
  }, [rows, sort, columns]);

  const toggle = key => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });

  return (
    <div className="scroll">
      <table className="tbl">
        <thead>
          <tr>
            {columns.map(col => {
              const sortable = col.sortable !== false;
              const isSorted = sort.key === col.key;
              return (
                <th key={col.key}
                  className={`${col.align === 'right' ? 'r' : ''} ${sortable ? 'sortable' : ''} ${isSorted ? 'sorted' : ''}`}
                  onClick={sortable ? () => toggle(col.key) : undefined}>
                  {col.label}
                  {sortable && <span className="sort-ind">{isSorted ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => {
            const key = getKey(row);
            return (
              <tr key={key}
                className={`${onRowClick ? 'clickable' : ''} ${selectedKey === key ? 'selected' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map(col => (
                  <td key={col.key} className={col.align === 'right' ? 'num' + (col.lead ? ' lead' : '') : ''}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer && <tfoot><tr>{footer}</tr></tfoot>}
      </table>
    </div>
  );
}

function BreakdownChart({ title, sub, data, nameKey, valueKey, maxItems = 12, color, valueLabel = 'Downloads' }) {
  if (!data?.length) return null;
  const top = [...data].sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0)).slice(0, maxItems);
  return (
    <Chart title={title} sub={sub} height={Math.max(200, top.length * 34)}>
      <BarChart data={top} layout="vertical" margin={{ left: 70 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
        <XAxis type="number" {...ax} tickFormatter={fmtNum} />
        <YAxis type="category" dataKey={nameKey} {...ax} width={90} />
        <Tooltip {...tt} formatter={v => [fmtFull(v), valueLabel]} />
        <Bar dataKey={valueKey} name={valueLabel} radius={[0, 4, 4, 0]}>
          {top.map((e, i) => <Cell key={i} fill={color || BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length]} />)}
        </Bar>
      </BarChart>
    </Chart>
  );
}

/* ============================================================
   Root
   ============================================================ */
export default function Dashboard() {
  const [tab, setTab] = useState('overview');
  const [range, setRange] = useState('30');       // detail tabs
  const [period, setPeriod] = useState('30d');    // overview adoption
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [repos, setRepos] = useState([]);
  const [selRepo, setSelRepo] = useState(null);
  const [ghData, setGhData] = useState(null); const [ghLoading, setGhLoading] = useState(false);

  const [npmPkgs, setNpmPkgs] = useState([]); const [selNpm, setSelNpm] = useState(null);
  const [npmData, setNpmData] = useState(null); const [npmLoading, setNpmLoading] = useState(false);

  const [pypiPkgs, setPypiPkgs] = useState([]); const [selPypi, setSelPypi] = useState(null);
  const [pypiData, setPypiData] = useState(null); const [pypiLoading, setPypiLoading] = useState(false);

  const [images, setImages] = useState([]); const [selImg, setSelImg] = useState(null);
  const [dockerData, setDockerData] = useState(null); const [dockerLoading, setDockerLoading] = useState(false);

  const [hfModels, setHfModels] = useState([]); const [selHf, setSelHf] = useState(null);
  const [hfData, setHfData] = useState(null); const [hfLoading, setHfLoading] = useState(false);

  const [chromeExts, setChromeExts] = useState([]); const [selChrome, setSelChrome] = useState(null);
  const [chromeData, setChromeData] = useState(null); const [chromeLoading, setChromeLoading] = useState(false);

  const [overview, setOverview] = useState(null); const [ovLoading, setOvLoading] = useState(true);
  const [trends, setTrends] = useState(null);
  const [granularity, setGranularity] = useState('weekly');

  useEffect(() => {
    fetch('/api/repos').then(r => r.ok ? r.json() : []).then(d => {
      if (Array.isArray(d)) { setRepos(d); if (d.length) setSelRepo(d[0].id); }
    }).catch(() => {});
    fetch('/api/npm-stats').then(r => r.ok ? r.json() : {}).then(d => { setNpmPkgs(d.packages || []); if (d.packages?.length) setSelNpm(d.packages[0].id); }).catch(() => {});
    fetch('/api/pypi-stats').then(r => r.ok ? r.json() : {}).then(d => { setPypiPkgs(d.packages || []); if (d.packages?.length) setSelPypi(d.packages[0].id); }).catch(() => {});
    fetch('/api/docker-stats').then(r => r.ok ? r.json() : {}).then(d => { setImages(d.images || []); if (d.images?.length) setSelImg(d.images[0].id); }).catch(() => {});
    fetch('/api/huggingface-stats').then(r => r.ok ? r.json() : {}).then(d => { setHfModels(d.models || []); if (d.models?.length) setSelHf(d.models[0].id); }).catch(() => {});
    fetch('/api/chrome-stats').then(r => r.ok ? r.json() : {}).then(d => { setChromeExts(d.extensions || []); if (d.extensions?.length) setSelChrome(d.extensions[0].id); }).catch(() => {});
    fetch('/api/overview?days=all').then(r => r.ok ? r.json() : null).then(d => { if (d?.totals) setOverview(d); }).catch(() => {}).finally(() => setOvLoading(false));
  }, []);

  useEffect(() => {
    fetch(`/api/trends?granularity=${granularity}&days=all`).then(r => r.ok ? r.json() : null).then(d => { if (d) setTrends(d); }).catch(() => {});
  }, [granularity]);

  const detail = (url, setData, setLoading) => { setLoading(true); fetch(url).then(r => r.ok ? r.json() : null).then(d => { if (d) setData(d); }).catch(() => {}).finally(() => setLoading(false)); };
  useEffect(() => { if (selRepo) detail(`/api/stats?repo_id=${selRepo}&days=${range}`, setGhData, setGhLoading); }, [selRepo, range]);
  useEffect(() => { if (selNpm) detail(`/api/npm-stats?package_id=${selNpm}&days=${range}`, setNpmData, setNpmLoading); }, [selNpm, range]);
  useEffect(() => { if (selPypi) detail(`/api/pypi-stats?package_id=${selPypi}&days=${range}`, setPypiData, setPypiLoading); }, [selPypi, range]);
  useEffect(() => { if (selImg) detail(`/api/docker-stats?image_id=${selImg}&days=${range}`, setDockerData, setDockerLoading); }, [selImg, range]);
  useEffect(() => { if (selHf) detail(`/api/huggingface-stats?model_id=${selHf}&days=${range}`, setHfData, setHfLoading); }, [selHf, range]);
  useEffect(() => { if (selChrome) detail(`/api/chrome-stats?extension_id=${selChrome}&days=${range}`, setChromeData, setChromeLoading); }, [selChrome, range]);

  const ghCombined = () => {
    if (!ghData) return [];
    const m = {};
    (ghData.views || []).forEach(v => { m[v.date] = { date: v.date, views: v.count, viewsUnique: v.uniques }; });
    (ghData.clones || []).forEach(c => { (m[c.date] = m[c.date] || { date: c.date }).clones = c.count; m[c.date].clonesUnique = c.uniques; });
    return Object.values(m).sort((a, b) => a.date.localeCompare(b.date));
  };
  const ghWeekly = () => {
    const c = ghCombined(); if (!c.length) return [];
    const w = {};
    c.forEach(d => { const k = toWeekKey(d.date); (w[k] = w[k] || { week: k, views: 0, clones: 0 }); w[k].views += d.views || 0; w[k].clones += d.clones || 0; });
    return Object.values(w).sort((a, b) => a.week.localeCompare(b.week));
  };

  const counts = {
    github: overview?.totals?.github?.repos, standards: overview?.totals?.standards?.repos,
    npm: overview?.totals?.npm?.packages,
    pypi: overview?.totals?.pypi?.packages, docker: overview?.totals?.docker?.images,
    huggingface: overview?.totals?.hf?.models,
    chrome: overview?.totals?.chrome?.extensions,
  };
  const meta = SOURCES[tab];

  return (
    <>
      <Head>
        <title>OpenA2A · Ecosystem Analytics</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </Head>

      <div className="app">
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="brand">
            <div className="brand-mark">
              <span className="brand-glyph"><Activity size={17} /></span>
              <h1>Open<span>A2A</span></h1>
            </div>
            <p>Ecosystem Analytics</p>
          </div>
          <nav className="nav">
            {TAB_ORDER.map(id => {
              const s = SOURCES[id]; const Icon = s.icon;
              return (
                <button key={id} className={`nav-link ${tab === id ? 'active' : ''}`} onClick={() => { setTab(id); setSidebarOpen(false); }}>
                  <span className="nav-ico" style={{ color: s.color }}><Icon size={16} /></span>
                  {s.label}
                  {counts[id] != null && <span className="nav-count">{counts[id]}</span>}
                </button>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <span className="dot">●</span> {overview?.lastUpdated ? `Updated ${fmtDate(overview.lastUpdated.split('T')[0])}` : 'Loading…'}
          </div>
        </aside>

        <div className={`overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />

        <div className="main">
          <div className="mobilebar">
            <button className="burger" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
            <h2>{meta.label}</h2>
          </div>

          <div className="topbar">
            <div className="topbar-l">
              <span className="crumb">Analytics</span>
              <span className="page-title">{meta.label}</span>
            </div>
            <div className="topbar-r">
              {tab === 'overview'
                ? <Segmented items={PERIODS} value={period} onChange={setPeriod} />
                : tab === 'standards'
                ? <Segmented items={PERIODS.filter(p => p.value !== 'custom')} value={period === 'custom' ? '30d' : period} onChange={setPeriod} />
                : <Segmented items={TIME_RANGES} value={range} onChange={setRange} />}
            </div>
          </div>

          <div className="content stack">
            {tab === 'overview' && <OverviewTab overview={overview} loading={ovLoading} trends={trends} granularity={granularity} setGranularity={setGranularity} period={period} />}
            {tab === 'github' && <GitHubTab repos={repos} selRepo={selRepo} setSelRepo={setSelRepo} data={ghData} loading={ghLoading} combined={ghCombined} weekly={ghWeekly} />}
            {tab === 'standards' && <StandardsTab overview={overview} loading={ovLoading} period={period === 'custom' ? '30d' : period} />}
            {tab === 'npm' && <PackageTab eco="npm" color={C.npm} packages={npmPkgs} sel={selNpm} setSel={setSelNpm} data={npmData} loading={npmLoading} weekly={() => weeklyDownloads(npmData?.downloads)} versionDownloads={npmData?.versionDownloads} />}
            {tab === 'pypi' && <PackageTab eco="PyPI" color={C.pypi} packages={pypiPkgs} sel={selPypi} setSel={setSelPypi} data={pypiData} loading={pypiLoading} weekly={() => weeklyDownloads(pypiData?.downloads)} pythonVersions={pypiData?.pythonVersions} systemStats={pypiData?.systemStats} countryDownloads={pypiData?.countryDownloads} />}
            {tab === 'docker' && <DockerTab images={images} sel={selImg} setSel={setSelImg} data={dockerData} loading={dockerLoading} />}
            {tab === 'huggingface' && <HuggingFaceTab models={hfModels} sel={selHf} setSel={setSelHf} data={hfData} loading={hfLoading} />}
            {tab === 'chrome' && <ChromeTab extensions={chromeExts} sel={selChrome} setSel={setSelChrome} data={chromeData} loading={chromeLoading} />}
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Overview
   ============================================================ */
function OverviewTab({ overview, loading, trends, granularity, setGranularity, period }) {
  const [filter, setFilter] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const ago14 = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const [cStart, setCStart] = useState(ago14);
  const [cEnd, setCEnd] = useState(today);
  const [custom, setCustom] = useState(null);
  const [cLoading, setCLoading] = useState(false);
  const [cKey, setCKey] = useState('');

  // First-party CLI telemetry (active users) — coarse, public. Fetched here so
  // the overview can surface real usage alongside downloads. Fine-grained detail
  // lives behind a password inside <TelemetrySection>.
  const [tel, setTel] = useState(null);
  useEffect(() => {
    fetch('/api/telemetry').then(r => r.ok ? r.json() : null).then(d => { if (d?.available) setTel(d); }).catch(() => {});
  }, []);

  const applyCustom = () => {
    if (!cStart || !cEnd) return;
    const key = `${cStart}_${cEnd}`;
    if (key === cKey && custom) return;
    setCLoading(true);
    fetch(`/api/overview?start=${cStart}&end=${cEnd}`).then(r => r.ok ? r.json() : null).then(d => { if (d?.products) { setCustom(d); setCKey(key); } }).catch(() => {}).finally(() => setCLoading(false));
  };

  if (loading) return <Loading />;
  if (!overview) return <Empty message="No data collected yet." command="npm run collect-all" />;

  const active = (period === 'custom' && custom) ? custom : overview;
  const { totals, products = [] } = active;

  // WoW / MoM from honest, complete, anchored windows (npm + PyPI installs).
  // We deliberately avoid the trends-series growth here: its most recent bucket
  // is usually a partial week/month, which produced phantom negative swings.
  const curr7 = (totals.npm?.last7Downloads || 0) + (totals.pypi?.last7Downloads || 0);
  const prev7 = (totals.npm?.prev7Downloads || 0) + (totals.pypi?.prev7Downloads || 0);
  const curr30 = (totals.npm?.last30Downloads || 0) + (totals.pypi?.last30Downloads || 0);
  const prev30 = (totals.npm?.prev30Downloads || 0) + (totals.pypi?.prev30Downloads || 0);
  const wowDownloads = pctChange(curr7, prev7);
  const momDownloads = pctChange(curr30, prev30);

  const filtered = filter
    ? products.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()) || (p.description || '').toLowerCase().includes(filter.toLowerCase()))
    : products;

  // Period-aware KPI totals, summed from products so KPIs always match the table
  const pt = filtered.reduce((t, p) => {
    t.views += periodPick(p.github, 'views', 'views30d', 'views7d', 'views24h', period, 'customViews');
    t.npm += periodPick(p.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
    t.pypi += periodPick(p.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
    return t;
  }, { views: 0, npm: 0, pypi: 0 });

  const periodWord = PERIOD_LABEL[period];
  const docPeriod = period === 'all'; // docker/hf only meaningful all-time
  const cumulative = trends?.series?.length > 1 ? (() => { let c = 0; return trends.series.map(s => ({ date: s.periodStart, cumulative: (c += s.totalDownloads || 0) })); })() : [];

  const channelData = [
    { name: 'npm', value: totals.npm?.allTimeDownloads || 0, color: C.npm },
    { name: 'Git Clones', value: totals.github?.totalClones || 0, color: C.github },
    { name: 'PyPI', value: totals.pypi?.allTimeDownloads || 0, color: C.pypi },
    { name: 'Docker', value: totals.docker?.totalPulls || 0, color: C.docker },
    { name: 'HF Models', value: totals.hf?.downloadsAllTime || 0, color: C.hf },
  ].filter(d => d.value > 0);
  const channelTotal = channelData.reduce((s, d) => s + d.value, 0);

  return (
    <>
      <div className="hero">
        <div className="hero-eyebrow">Total ecosystem adoption</div>
        <div className="hero-main">
          <div className="hero-figure">{fmtFull(totals.combined.totalAdoption)}</div>
          <div className="hero-deltas">
            {wowDownloads != null && <div className="hero-delta"><span>Installs WoW</span><Delta value={wowDownloads} /></div>}
            {momDownloads != null && <div className="hero-delta"><span>Installs MoM</span><Delta value={momDownloads} /></div>}
          </div>
        </div>
        <div className="hero-sub">
          Git clones + package installs + image pulls + model downloads across {totals.github.repos} repositories,
          {' '}{(totals.npm?.packages || 0) + (totals.pypi?.packages || 0)} packages, {totals.docker?.images || 0} images and {totals.hf?.models || 0} models.
        </div>
      </div>

      {period === 'custom' && (
        <div className="panel">
          <div className="panel-head">
            <div><div className="panel-title">Custom range</div><div className="panel-sub">Pick a window for views, clones and package installs.</div></div>
            <div className="panel-tools daterange">
              <input type="date" className="date-input" value={cStart} max={cEnd || today} onChange={e => setCStart(e.target.value)} />
              <span style={{ color: 'var(--ink-4)', fontSize: '.72rem' }}>to</span>
              <input type="date" className="date-input" value={cEnd} min={cStart} max={today} onChange={e => setCEnd(e.target.value)} />
              <button className="btn" onClick={applyCustom} disabled={cLoading}>{cLoading ? 'Loading…' : 'Apply'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="cards">
        <Kpi icon={<Eye size={17} />} color={C.github} label={`Page Views`} value={fmtFull(pt.views)} sub={periodWord} />
        <Kpi icon={<Star size={17} />} color={C.pypi} label="GitHub Stars" value={fmtFull(totals.github.totalStars)} sub="current total" />
        <Kpi icon={<Download size={17} />} color={C.npm} label="npm Installs" value={fmtFull(pt.npm)} sub={`${periodWord} · ${totals.npm.packages} pkgs`} />
        <Kpi icon={<Package size={17} />} color={C.pypi} label="PyPI Installs" value={fmtFull(pt.pypi)} sub={`${periodWord} · ${totals.pypi?.packages || 0} pkgs`} />
        <Kpi icon={<Container size={17} />} color={C.docker} label="Docker Pulls" value={fmtFull(totals.docker?.totalPulls || 0)} sub={`all time · ${totals.docker?.images || 0} images`} />
        <Kpi icon={<Brain size={17} />} color={C.hf} label="HF Downloads" value={fmtFull(totals.hf?.downloadsAllTime || 0)} sub={`all time · ${totals.hf?.downloads30d || 0} in 30d`} />
        {totals.chrome?.extensions > 0 && (
          <Kpi icon={<Chrome size={17} />} color={C.chrome} label="Chrome Users" value={fmtFull(totals.chrome?.users || 0)} sub={`weekly active · ${totals.chrome?.extensions} ext`} />
        )}
        {tel?.snapshot && (
          <Kpi icon={<Users size={17} />} color={C.green} label="Active CLI Users"
            value={fmtFull(tel.snapshot.engagedMau)}
            sub={`engaged monthly · ${fmtFull(tel.snapshot.mau)} reported`}
            delta={tel.snapshot.engagedGrowth30d ? pctChange(tel.snapshot.engagedMau, tel.snapshot.engagedMau - tel.snapshot.engagedGrowth30d) : null} />
        )}
      </div>

      <Panel
        title="Tool Adoption"
        sub="Adoption = clones + npm + PyPI + Docker pulls + HF downloads. Views, stars, and Chrome users are shown for context, not summed. Docker and HF report cumulative totals only, so they show only under the All-time window. Chrome is Google's rounded weekly-active-user count, not installs."
        tools={<Filter value={filter} onChange={setFilter} placeholder="Filter tools…" />}
        pad={false}>
        {(period === 'custom' && !custom)
          ? <div className="empty" style={{ border: 'none' }}><p>{cLoading ? 'Loading custom range…' : 'Pick a date range above and click Apply.'}</p></div>
          : <AdoptionTable products={filtered} period={period} />}
      </Panel>

      <SecLabel>Distribution</SecLabel>
      <div className="duo">
        {channelData.length > 0 && (
          <Chart title="Channel Mix" sub="All-time adoption by install channel">
            <PieChart>
              <Pie data={channelData} cx="50%" cy="50%" innerRadius={68} outerRadius={108} dataKey="value" nameKey="name" paddingAngle={3} strokeWidth={0}>
                {channelData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip {...tt} formatter={v => [`${fmtFull(v)} (${(v / channelTotal * 100).toFixed(1)}%)`, '']} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </Chart>
        )}
        {cumulative.length > 1 && (
          <Chart title="Cumulative Adoption" sub="Running total of installs over time">
            <AreaChart data={cumulative}>
              <defs><linearGradient id="cum" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.accent} stopOpacity={0.28} /><stop offset="100%" stopColor={C.accent} stopOpacity={0.02} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="date" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
              <Tooltip {...tt} labelFormatter={fmtDate} formatter={v => [fmtFull(v), 'Total Installs']} />
              <Area type="monotone" dataKey="cumulative" stroke={C.accent} fill="url(#cum)" strokeWidth={2.5} dot={false} />
            </AreaChart>
          </Chart>
        )}
      </div>

      <SecLabel>Trends</SecLabel>
      <div className="sec-label" style={{ marginTop: -8 }}>
        <Segmented items={GRANULARITIES} value={granularity} onChange={setGranularity} />
        <div className="rule" />
      </div>

      {trends?.series?.length > 1 && (
        <div className="duo">
          <Chart title="Install Trend" sub="npm + PyPI + Docker + HuggingFace">
            <ComposedChart data={trends.series}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="periodStart" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
              <Tooltip {...tt} labelFormatter={fmtDate} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="npmDownloads" stackId="d" stroke={C.npm} fill={C.fill(C.npm)} name="npm" />
              <Area type="monotone" dataKey="pypiDownloads" stackId="d" stroke={C.pypi} fill={C.fill(C.pypi)} name="PyPI" />
              <Area type="monotone" dataKey="dockerPulls" stackId="d" stroke={C.docker} fill={C.fill(C.docker)} name="Docker" />
              <Area type="monotone" dataKey="hfDownloads" stackId="d" stroke={C.hf} fill={C.fill(C.hf)} name="HuggingFace" />
              <Line type="monotone" dataKey="totalDownloads" stroke={C.accent} strokeWidth={2} dot={false} name="Total" />
            </ComposedChart>
          </Chart>
          <Chart title="GitHub Traffic Trend" sub="Views + clones across all repos">
            <ComposedChart data={trends.series}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="periodStart" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
              <Tooltip {...tt} labelFormatter={fmtDate} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="views" stroke={C.github} fill={C.fill(C.github)} name="Views" />
              <Line type="monotone" dataKey="clones" stroke={C.violet} strokeWidth={2} dot={false} name="Clones" />
            </ComposedChart>
          </Chart>
        </div>
      )}

      {trends?.starTimeline?.length > 1 && (
        <Chart title="Star Growth" sub="Total stars across all repositories" height={240}>
          <AreaChart data={trends.starTimeline}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="date" {...axDate} /><YAxis {...ax} />
            <Tooltip {...tt} labelFormatter={fmtDate} />
            <Area type="monotone" dataKey="totalStars" stroke={C.pypi} fill={C.fill(C.pypi)} name="Total Stars" />
          </AreaChart>
        </Chart>
      )}

      <SecLabel>By source</SecLabel>
      <div className="quad">
        <Eco name="GitHub" color={C.github} icon={<Github size={15} color={C.github} />} rows={[
          ['Repositories', totals.github.repos], ['Page views', totals.github.totalViews],
          ['Git clones', totals.github.totalClones], ['Stars', totals.github.totalStars],
          ['Forks', totals.github.totalForks], ['Contributors', totals.github.totalContributors || 0],
        ]} />
        <Eco name="npm" color={C.npm} icon={<Box size={15} color={C.npm} />} rows={[
          ['Packages', totals.npm.packages], ['All-time installs', totals.npm.allTimeDownloads],
          ['Last 30d', totals.npm.last30Downloads], ['Last 7d', totals.npm.last7Downloads],
        ]} />
        <Eco name="PyPI" color={C.pypi} icon={<Package size={15} color={C.pypi} />} rows={[
          ['Packages', totals.pypi?.packages || 0], ['All-time installs', totals.pypi?.allTimeDownloads || 0],
          ['Last 30d', totals.pypi?.last30Downloads || 0], ['Last 7d', totals.pypi?.last7Downloads || 0],
        ]} />
        <Eco name="HuggingFace" color={C.hf} icon={<Brain size={15} color={C.hf} />} rows={[
          ['Models', totals.hf?.models || 0], ['All-time downloads', totals.hf?.downloadsAllTime || 0],
          ['Last 30d', totals.hf?.downloads30d || 0], ['Likes', totals.hf?.likes || 0],
        ]} />
        {totals.chrome?.extensions > 0 && (
          <Eco name="Chrome Web Store" color={C.chrome} icon={<Chrome size={15} color={C.chrome} />} rows={[
            ['Extensions', totals.chrome?.extensions || 0], ['Weekly users', totals.chrome?.users || 0],
            ['30d growth', totals.chrome?.usersGrowth30d || 0],
          ]} />
        )}
      </div>

      {tel?.snapshot && <TelemetrySection data={tel} />}
    </>
  );
}

/* ============================================================
   First-party CLI telemetry (active users)
   ============================================================ */
function TelemetrySection({ data }) {
  const s = data.snapshot;
  const tools = data.tools || [];
  const byCountry = data.byCountry || [];

  // Gated fine-grained detail. Nothing loads until a password is submitted; the
  // request carries it in a header and the server verifies against
  // ANALYTICS_TRACKER_PASSWORD, then fetches the Registry's internal feed.
  const [pw, setPw] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);

  const loadDetail = () => {
    if (!pw) return;
    setDetailLoading(true); setDetailErr(''); setDetail(null);
    fetch('/api/telemetry-detail', { headers: { 'x-analytics-tracker-password': pw } })
      .then(async r => {
        if (r.status === 401) throw new Error('Incorrect password.');
        if (r.status === 404) throw new Error('Detailed telemetry is not enabled on this deployment.');
        if (r.status === 503) throw new Error('Detailed telemetry is not configured (Registry token missing).');
        if (!r.ok) throw new Error('Could not load detailed telemetry.');
        return r.json();
      })
      .then(setDetail)
      .catch(e => setDetailErr(e.message))
      .finally(() => setDetailLoading(false));
  };

  return (
    <>
      <SecLabel>First-party CLI usage</SecLabel>
      <Panel
        title="Active users, measured first-party"
        sub={`Distinct installs of the CLIs, reported by the tools themselves — active users, not downloads (a download is not a user), so they are shown separately and never summed into adoption. "Engaged" is the honest headline: installs active on ≥${s.engagedMinDays || 2} distinct days with real usage — a sybil-dampened floor that a burst of fabricated installs can't inflate. "Reported" WAU/MAU come from anonymous, unauthenticated telemetry and are best-effort/forgeable. As of ${s.asOf}.`}>
        <div className="cards" style={{ marginBottom: 16 }}>
          <Kpi icon={<Users size={17} />} color={C.green} label="Engaged monthly users" value={fmtFull(s.engagedMau)} sub={`≥${s.engagedMinDays || 2}-day footprint · sybil-dampened floor`} delta={s.engagedGrowth30d ? pctChange(s.engagedMau, s.engagedMau - s.engagedGrowth30d) : null} />
          <Kpi icon={<Activity size={17} />} color={C.accent} label="Reported MAU" value={fmtFull(s.mau)} sub={`${s.mauWindowDays || 30}-day distinct · best-effort`} delta={s.mauGrowth30d ? pctChange(s.mau, s.mau - s.mauGrowth30d) : null} />
          <Kpi icon={<Download size={17} />} color={C.npm} label="Reported WAU" value={fmtFull(s.wau)} sub={`${s.wauWindowDays || 7}-day distinct · best-effort`} delta={s.wauGrowth7d ? pctChange(s.wau, s.wau - s.wauGrowth7d) : null} />
        </div>

        {tools.length > 0 && (
          <table className="table">
            <thead><tr><th>Tool</th><th className="num">Installs</th><th className="num">Engaged</th><th className="num">MAU</th><th className="num">WAU</th><th>Top version</th></tr></thead>
            <tbody>
              {tools.map(t => (
                <tr key={t.tool}>
                  <td><div className="cell-name">{t.product}</div>{t.product !== t.tool && <div className="cell-desc">{t.tool}</div>}</td>
                  <td className="num">{fmtFull(t.totalInstalls)}</td>
                  <td className="num">{fmtFull(t.engagedMau)}</td>
                  <td className="num">{fmtFull(t.mau)}</td>
                  <td className="num">{fmtFull(t.wau)}</td>
                  <td>{t.versions?.[0] ? <span className="muted">{t.versions[0].version} · {fmtFull(t.versions[0].installs)}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {byCountry.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {byCountry.slice(0, 12).map(c => (
              <span key={c.countryCode} className="chip" style={{ fontSize: '.72rem' }}>
                <i style={{ background: C.green }} />{c.countryCode} · {fmtFull(c.installs)}
              </span>
            ))}
          </div>
        )}

        {/* Honest provenance, carried from the feed — these are self-reported over
            anonymous telemetry, a best-effort signal, not a sybil-verified count. */}
        <div className="panel-sub" style={{ marginTop: 14, fontStyle: 'italic' }}>
          {s.provenance || 'Self-reported by the CLIs over anonymous telemetry — a best-effort adoption signal, not a sybil-verified count.'}
        </div>
      </Panel>

      <Panel title="Detailed usage" sub="Command engagement, reliability and by-day activity. Password-protected — these fine-grained metrics are never committed to the public dashboard.">
        <div className="daterange" style={{ marginBottom: 12 }}>
          <input type="password" className="date-input" placeholder="Analytics tracker password" value={pw}
            onChange={e => setPw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') loadDetail(); }} />
          <button className="btn" onClick={loadDetail} disabled={detailLoading || !pw}>{detailLoading ? 'Loading…' : 'Unlock'}</button>
        </div>
        {detailErr && <div className="empty" style={{ border: 'none' }}><p>{detailErr}</p></div>}
        {detail && <TelemetryDetail detail={detail} />}
      </Panel>
    </>
  );
}

function TelemetryDetail({ detail }) {
  const cmds = (detail.byCommand || []).slice(0, 15);
  const totalCmd = (detail.commandSuccess || 0) + (detail.commandFailure || 0);
  const successRate = totalCmd > 0 ? ((detail.commandSuccess / totalCmd) * 100).toFixed(1) : null;
  return (
    <>
      <div className="cards" style={{ marginBottom: 16 }}>
        <Kpi icon={<Activity size={17} />} color={C.accent} label="Events" value={fmtFull(detail.totalEvents)} sub={detail.from && detail.to ? `${detail.from} → ${detail.to}` : 'window'} />
        <Kpi icon={<Users size={17} />} color={C.green} label="Unique installs" value={fmtFull(detail.uniqueInstalls)} sub="in window" />
        {successRate != null && <Kpi icon={<TrendingUp size={17} />} color={C.hf} label="Command success" value={`${successRate}%`} sub={`${fmtFull(detail.commandSuccess)} ok · ${fmtFull(detail.commandFailure)} failed`} />}
      </div>
      {cmds.length > 0 && (
        <table className="table">
          <thead><tr><th>Command</th><th className="num">Events</th><th className="num">Success</th><th className="num">Failure</th></tr></thead>
          <tbody>
            {cmds.map((c, i) => (
              <tr key={`${c.tool}/${c.name}/${i}`}>
                <td><div className="cell-name">{c.name}</div><div className="cell-desc">{c.tool}</div></td>
                <td className="num">{fmtFull(c.eventCount)}</td>
                <td className="num">{fmtFull(c.successes)}</td>
                <td className="num">{fmtFull(c.failures)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Eco({ name, color, icon, rows }) {
  return (
    <div className="eco">
      <div className="eco-head"><span className="chip"><i style={{ background: color }} />{name}</span><span className="ico">{icon}</span></div>
      {rows.map(([k, v]) => <div className="eco-row" key={k}><span className="k">{k}</span><span className="v">{fmtFull(v)}</span></div>)}
    </div>
  );
}

function AdoptionTable({ products, period }) {
  const cols = [
    { key: 'name', label: 'Tool', sortValue: r => r.name, render: r => (<div><div className="cell-name">{r.name}</div><div className="cell-desc">{r.description}</div></div>) },
    { key: 'views', label: 'Views', align: 'right', sortValue: r => periodPick(r.github, 'views', 'views30d', 'views7d', 'views24h', period, 'customViews'), render: r => fmtFull(periodPick(r.github, 'views', 'views30d', 'views7d', 'views24h', period, 'customViews')) },
    { key: 'clones', label: 'Clones', align: 'right', sortValue: r => periodPick(r.github, 'clones', 'clones30d', 'clones7d', 'clones24h', period, 'customClones'), render: r => fmtFull(periodPick(r.github, 'clones', 'clones30d', 'clones7d', 'clones24h', period, 'customClones')) },
    {
      key: 'npm', label: 'npm', align: 'right', sortValue: r => periodPick(r.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads'),
      render: r => (<>{fmtFull(periodPick(r.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads'))}{(period === '30d' || period === '7d') && <MiniDelta curr={r.npm?.last7Downloads} prev={r.npm?.prev7Downloads} />}</>),
    },
    {
      key: 'pypi', label: 'PyPI', align: 'right', sortValue: r => periodPick(r.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads'),
      render: r => (<>{fmtFull(periodPick(r.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads'))}{(period === '30d' || period === '7d') && <MiniDelta curr={r.pypi?.last7Downloads} prev={r.pypi?.prev7Downloads} />}</>),
    },
    { key: 'docker', label: 'Docker', align: 'right', sortValue: r => period === 'all' ? (r.docker?.totalPulls || 0) : -1, render: r => period === 'all' ? fmtFull(r.docker?.totalPulls || 0) : <span className="muted">—</span> },
    { key: 'hf', label: 'HF', align: 'right', sortValue: r => hfPeriod(r.hf, period) ?? -1, render: r => { const v = hfPeriod(r.hf, period); return v == null ? <span className="muted">—</span> : fmtFull(v); } },
    // Chrome Web Store weekly-active users — a snapshot shown for context (like
    // Stars), never folded into Adoption.
    { key: 'chrome', label: 'Chrome', align: 'right', sortValue: r => r.chrome?.extensionCount ? (r.chrome?.users || 0) : -1, render: r => r.chrome?.extensionCount ? (<>{fmtFull(r.chrome?.users || 0)}<StarGrowth value={period === '30d' ? (r.chrome?.usersGrowth30d || 0) : period === '7d' ? (r.chrome?.usersGrowth7d || 0) : 0} /></>) : <span className="muted">—</span> },
    { key: 'stars', label: 'Stars', align: 'right', sortValue: r => r.github?.stars || 0, render: r => (<>{fmtFull(r.github?.stars || 0)}<StarGrowth value={starGrowthPick(r.github, period)} /></>) },
    { key: 'adoption', label: 'Adoption', align: 'right', lead: true, sortValue: r => rowAdoption(r, period), render: r => fmtFull(rowAdoption(r, period)) },
  ];
  const t = products.reduce((a, p) => {
    a.views += periodPick(p.github, 'views', 'views30d', 'views7d', 'views24h', period, 'customViews');
    a.clones += periodPick(p.github, 'clones', 'clones30d', 'clones7d', 'clones24h', period, 'customClones');
    a.npm += periodPick(p.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
    a.pypi += periodPick(p.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', period, 'customDownloads');
    a.docker += period === 'all' ? (p.docker?.totalPulls || 0) : 0;
    a.hf += hfPeriod(p.hf, period) || 0;
    a.chrome += p.chrome?.users || 0;
    a.stars += p.github?.stars || 0;
    a.starsGrowth += starGrowthPick(p.github, period) || 0;
    a.adoption += rowAdoption(p, period);
    return a;
  }, { views: 0, clones: 0, npm: 0, pypi: 0, docker: 0, hf: 0, chrome: 0, stars: 0, starsGrowth: 0, adoption: 0 });
  const footer = [
    <td key="t">Total</td>,
    <td key="v" className="num">{fmtFull(t.views)}</td>,
    <td key="c" className="num">{fmtFull(t.clones)}</td>,
    <td key="n" className="num">{fmtFull(t.npm)}</td>,
    <td key="p" className="num">{fmtFull(t.pypi)}</td>,
    <td key="d" className="num">{period === 'all' ? fmtFull(t.docker) : '—'}</td>,
    <td key="h" className="num">{(period === 'all' || period === '30d') ? fmtFull(t.hf) : '—'}</td>,
    <td key="ch" className="num">{fmtFull(t.chrome)}</td>,
    <td key="s" className="num">{fmtFull(t.stars)}<StarGrowth value={t.starsGrowth} /></td>,
    <td key="a" className="num lead">{fmtFull(t.adoption)}</td>,
  ];
  return <DataTable columns={cols} rows={products} getKey={r => r.name} initialSort={{ key: 'adoption', dir: 'desc' }} footer={footer} />;
}

/* ============================================================
   Standards — specs, protocols & conformance suites
   These are specifications, not installable packages, so adoption
   is read as stars / views / clones, not downloads.
   ============================================================ */
function StandardsTab({ overview, loading, period }) {
  const [filter, setFilter] = useState('');
  if (loading) return <Loading />;
  const standards = overview?.standards || [];
  if (!standards.length) return <Empty message="No standards tracked yet." command="GITHUB_ORG=opena2a-standards npm run collect" />;

  const periodWord = PERIOD_LABEL[period];
  const totals = overview?.totals?.standards || {};
  const pickViews = g => periodPick(g, 'views', 'views30d', 'views7d', 'views24h', period, 'customViews');
  const pickClones = g => periodPick(g, 'clones', 'clones30d', 'clones7d', 'clones24h', period, 'customClones');

  const agg = standards.reduce((a, f) => {
    a.views += pickViews(f.github);
    a.clones += pickClones(f.github);
    a.stars += f.github?.stars || 0;
    a.starsGrowth += starGrowthPick(f.github, period) || 0;
    return a;
  }, { views: 0, clones: 0, stars: 0, starsGrowth: 0 });

  const starCell = g => (<>{fmtFull(g?.stars || 0)}<StarGrowth value={starGrowthPick(g, period)} /></>);
  const famCols = [
    { key: 'name', label: 'Family', sortValue: r => r.name, render: r => (<div><div className="cell-name">{r.name}</div><div className="cell-desc">{r.description}</div></div>) },
    { key: 'repoCount', label: 'Specs', align: 'right', sortValue: r => r.repoCount, render: r => fmtFull(r.repoCount) },
    { key: 'stars', label: 'Stars', align: 'right', sortValue: r => r.github?.stars || 0, render: r => starCell(r.github) },
    { key: 'views', label: 'Views', align: 'right', sortValue: r => pickViews(r.github), render: r => fmtFull(pickViews(r.github)) },
    { key: 'clones', label: 'Clones', align: 'right', lead: true, sortValue: r => pickClones(r.github), render: r => fmtFull(pickClones(r.github)) },
  ];
  const famFooter = [
    <td key="t">Total</td>,
    <td key="r" className="num">{fmtFull(totals.repos || 0)}</td>,
    <td key="s" className="num">{fmtFull(agg.stars)}<StarGrowth value={agg.starsGrowth} /></td>,
    <td key="v" className="num">{fmtFull(agg.views)}</td>,
    <td key="c" className="num lead">{fmtFull(agg.clones)}</td>,
  ];

  const allRepos = standards.flatMap(f => f.repos.map(r => ({ ...r, family: f.name })));
  const shown = filter
    ? allRepos.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()) || r.family.toLowerCase().includes(filter.toLowerCase()))
    : allRepos;
  const repoCols = [
    { key: 'name', label: 'Repository', sortValue: r => r.name, render: r => (<div><div className="cell-name">{r.name}</div><div className="cell-desc">{r.family}</div></div>) },
    { key: 'stars', label: 'Stars', align: 'right', sortValue: r => r.github?.stars || 0, render: r => starCell(r.github) },
    { key: 'views', label: 'Views', align: 'right', sortValue: r => pickViews(r.github), render: r => fmtFull(pickViews(r.github)) },
    { key: 'clones', label: 'Clones', align: 'right', lead: true, sortValue: r => pickClones(r.github), render: r => fmtFull(pickClones(r.github)) },
  ];

  return (
    <>
      <div className="cards">
        <Kpi icon={<FileText size={17} />} color={C.standards} label="Specifications" value={fmtFull(totals.repos || 0)} sub={`${standards.length} families`} />
        <Kpi icon={<Star size={17} />} color={C.pypi} label="Stars" value={fmtFull(agg.stars)} sub={agg.starsGrowth > 0 ? `+${fmtFull(agg.starsGrowth)} ${periodWord}` : 'current total'} />
        <Kpi icon={<Eye size={17} />} color={C.github} label="Views" value={fmtFull(agg.views)} sub={periodWord} />
        <Kpi icon={<GitPullRequest size={17} />} color={C.accent} label="Clones" value={fmtFull(agg.clones)} sub={periodWord} />
      </div>

      <Panel title="Standards by family" sub="Specs and protocols grouped by family. Adoption here is stars, views and clones — these are specifications, not installable packages." pad={false}>
        <DataTable columns={famCols} rows={standards} getKey={r => r.name} initialSort={{ key: 'stars', dir: 'desc' }} footer={famFooter} />
      </Panel>

      <Panel title="All specifications" sub="Every tracked repo in the opena2a-standards org. Sort any column." tools={<Filter value={filter} onChange={setFilter} placeholder="Filter specs…" />} pad={false}>
        <DataTable columns={repoCols} rows={shown} getKey={r => r.name} initialSort={{ key: 'stars', dir: 'desc' }} />
      </Panel>
    </>
  );
}

/* ============================================================
   GitHub
   ============================================================ */
function GitHubTab({ repos, selRepo, setSelRepo, data, loading, combined, weekly }) {
  const [filter, setFilter] = useState('');
  const rows = filter ? repos.filter(r => (r.full_name || '').toLowerCase().includes(filter.toLowerCase())) : repos;
  const cols = [
    { key: 'full_name', label: 'Repository', sortValue: r => r.full_name, render: r => <span className="cell-name">{r.full_name}</span> },
    { key: 'totalViews', label: 'Views', align: 'right', render: r => fmtFull(r.totalViews) },
    { key: 'totalClones', label: 'Clones', align: 'right', render: r => fmtFull(r.totalClones) },
    { key: 'stars', label: 'Stars', align: 'right', render: r => fmtFull(r.stars) },
    { key: 'forks', label: 'Forks', align: 'right', lead: true, render: r => fmtFull(r.forks) },
  ];
  return (
    <>
      <Panel title="Repositories" sub="Click a repository to see its traffic history. Sort any column." tools={<Filter value={filter} onChange={setFilter} placeholder="Filter repositories…" />} pad={false}>
        <DataTable columns={cols} rows={rows} getKey={r => r.id} onRowClick={r => setSelRepo(r.id)} selectedKey={selRepo} initialSort={{ key: 'totalViews', dir: 'desc' }} />
      </Panel>

      {loading ? <Loading /> : data ? (
        <>
          <SecLabel>{repos.find(r => r.id === selRepo)?.full_name || 'Detail'}</SecLabel>
          <div className="cards">
            <Kpi icon={<Eye size={17} />} color={C.github} label="Total Views" value={fmtFull(data.summary.totalViews)} sub="all time" />
            <Kpi icon={<GitPullRequest size={17} />} color={C.accent} label="Total Clones" value={fmtFull(data.summary.totalClones)} sub="all time" />
            <Kpi icon={<Users size={17} />} color={C.docker} label="Unique Visitors" value={fmtFull(data.summary.recentUniqueVisitors)} sub="last 14d (API)" />
            <Kpi icon={<Star size={17} />} color={C.pypi} label="Stars" value={fmtFull(data.summary.latestStars)} sub={data.summary.starsGrowth > 0 ? `+${data.summary.starsGrowth} this period` : 'current'} />
            <Kpi icon={<GitFork size={17} />} color={C.violet} label="Forks" value={fmtFull(data.summary.latestForks)} sub={data.summary.forksGrowth > 0 ? `+${data.summary.forksGrowth} this period` : 'current'} />
          </div>

          <Chart title="Daily Traffic" height={340}>
            <ComposedChart data={combined()}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="date" {...axDate} /><YAxis {...ax} />
              <Tooltip {...tt} labelFormatter={fmtDate} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="views" stroke={C.github} fill={C.fill(C.github)} name="Views" />
              <Area type="monotone" dataKey="viewsUnique" stroke={C.accent} fill={C.fill(C.accent, 0.1)} name="Unique Visitors" />
              <Line type="monotone" dataKey="clones" stroke={C.violet} strokeWidth={2} dot={false} name="Clones" />
              <Line type="monotone" dataKey="clonesUnique" stroke={C.pink} strokeWidth={2} dot={false} name="Unique Cloners" />
            </ComposedChart>
          </Chart>

          {weekly().length > 1 && (
            <Chart title="Weekly Summary">
              <BarChart data={weekly()}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="week" {...axDate} /><YAxis {...ax} />
                <Tooltip {...tt} labelFormatter={v => `Week of ${fmtDate(v)}`} /><Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="views" fill={C.github} name="Views" radius={[4, 4, 0, 0]} />
                <Bar dataKey="clones" fill={C.violet} name="Clones" radius={[4, 4, 0, 0]} />
              </BarChart>
            </Chart>
          )}

          {data.referrers?.length > 0 && (
            <BreakdownChart title="Top Referrers" sub="Traffic sources (last 14 days)" data={data.referrers} nameKey="referrer" valueKey="count" maxItems={10} color={C.github} valueLabel="Views" />
          )}
          {data.paths?.length > 0 && (
            <BreakdownChart title="Popular Content" sub="Most visited pages (last 14 days)" data={data.paths} nameKey="path" valueKey="count" maxItems={10} color={C.violet} valueLabel="Views" />
          )}
          {data.contributors?.length > 0 && (
            <BreakdownChart title="Top Contributors" sub="Total commits per contributor" data={data.contributors} nameKey="login" valueKey="contributions" maxItems={15} color={C.accent} valueLabel="Commits" />
          )}
          {data.releases?.length > 0 && (
            <Panel title="Release Downloads" pad={false}>
              <DataTable
                columns={[
                  { key: 'tag_name', label: 'Tag', render: r => <span className="cell-name">{r.tag_name}</span> },
                  { key: 'release_name', label: 'Release' },
                  { key: 'published_at', label: 'Published', sortValue: r => r.published_at || '', render: r => r.published_at ? fmtDate(r.published_at.split('T')[0]) : '—' },
                  { key: 'total_downloads', label: 'Downloads', align: 'right', lead: true, render: r => fmtFull(r.total_downloads) },
                ]}
                rows={data.releases} getKey={r => r.tag_name} initialSort={{ key: 'total_downloads', dir: 'desc' }} />
            </Panel>
          )}
        </>
      ) : <Empty message="No GitHub data yet." command="npm run collect" />}
    </>
  );
}

/* ============================================================
   npm + PyPI (shared)
   ============================================================ */
const COUNTRY_NAMES = { US: 'United States', DE: 'Germany', CN: 'China', GB: 'United Kingdom', FR: 'France', IN: 'India', JP: 'Japan', KR: 'South Korea', BR: 'Brazil', CA: 'Canada', AU: 'Australia', NL: 'Netherlands', RU: 'Russia', SE: 'Sweden', SG: 'Singapore', PL: 'Poland', ES: 'Spain', IT: 'Italy', CH: 'Switzerland', HK: 'Hong Kong' };

function PackageTab({ eco, color, packages, sel, setSel, data, loading, weekly, versionDownloads, pythonVersions, systemStats, countryDownloads }) {
  const [filter, setFilter] = useState('');
  const rows = filter ? packages.filter(p => p.name.toLowerCase().includes(filter.toLowerCase())) : packages;
  const t = packages.reduce((a, p) => { a.d7 += p.last7Downloads || 0; a.d30 += p.last30Downloads || 0; a.all += p.allTimeDownloads || 0; return a; }, { d7: 0, d30: 0, all: 0 });

  const cols = [
    { key: 'name', label: 'Package', sortValue: r => r.name, render: r => <span className="cell-name">{r.name}</span> },
    { key: 'version', label: 'Version', sortable: false, render: r => <span className="tag">{r.version || '—'}</span> },
    { key: 'last7Downloads', label: '7d', align: 'right', render: r => fmtFull(r.last7Downloads) },
    { key: 'last30Downloads', label: '30d', align: 'right', render: r => fmtFull(r.last30Downloads) },
    { key: 'allTimeDownloads', label: 'All Time', align: 'right', lead: true, render: r => fmtFull(r.allTimeDownloads) },
  ];
  const footer = [
    <td key="t">Total</td>, <td key="v" />,
    <td key="7" className="num">{fmtFull(t.d7)}</td>,
    <td key="30" className="num">{fmtFull(t.d30)}</td>,
    <td key="a" className="num lead">{fmtFull(t.all)}</td>,
  ];

  return (
    <>
      {packages.length > 0 && (
        <Panel title={`${eco} Packages`} sub="Click a package for its download history. Sort any column." tools={<Filter value={filter} onChange={setFilter} placeholder={`Filter ${eco} packages…`} />} pad={false}>
          <DataTable columns={cols} rows={rows} getKey={r => r.id} onRowClick={r => setSel(r.id)} selectedKey={sel} initialSort={{ key: 'allTimeDownloads', dir: 'desc' }} footer={footer} />
        </Panel>
      )}

      {loading ? <Loading /> : data ? (
        <>
          <SecLabel>{data.package?.name || 'Detail'}</SecLabel>
          <div className="cards">
            <Kpi icon={<Download size={17} />} color={color} label="Period Downloads" value={fmtFull(data.summary?.periodDownloads)} sub="selected range" />
            <Kpi icon={<Package size={17} />} color={color} label="All-Time Downloads" value={fmtFull(data.summary?.allTimeDownloads)} sub="since tracking began" />
            <Kpi icon={<Star size={17} />} color={C.pypi} label="Version" value={data.package?.version || '—'} sub={data.package?.name || ''} />
          </div>

          {data.downloads?.length > 0 && (
            <Chart title="Daily Downloads" height={340}>
              <AreaChart data={data.downloads}>
                <defs><linearGradient id={`dl-${eco}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.3} /><stop offset="100%" stopColor={color} stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="date" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
                <Tooltip {...tt} labelFormatter={fmtDate} formatter={v => [fmtFull(v), 'Downloads']} />
                <Area type="monotone" dataKey="downloads" stroke={color} fill={`url(#dl-${eco})`} strokeWidth={2} name="Downloads" />
              </AreaChart>
            </Chart>
          )}

          {weekly().length > 1 && (
            <Chart title="Weekly Downloads">
              <BarChart data={weekly()}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="week" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
                <Tooltip {...tt} labelFormatter={v => `Week of ${fmtDate(v)}`} formatter={v => [fmtFull(v), 'Downloads']} />
                <Bar dataKey="downloads" fill={color} name="Downloads" radius={[4, 4, 0, 0]} />
              </BarChart>
            </Chart>
          )}

          <div className="duo">
            {versionDownloads?.length > 0 && <BreakdownChart title="Downloads by Version" sub="Last week, per version" data={versionDownloads} nameKey="version" valueKey="downloads" maxItems={12} />}
            {pythonVersions?.length > 0 && <BreakdownChart title="By Python Version" sub="Recent data (mirrors excluded)" data={pythonVersions} nameKey="python_version" valueKey="downloads" maxItems={10} />}
            {systemStats?.length > 0 && <BreakdownChart title="By Operating System" sub="Recent data (mirrors excluded)" data={systemStats} nameKey="os_name" valueKey="downloads" maxItems={8} />}
          </div>

          {countryDownloads?.length > 0 && (
            <BreakdownChart title="Downloads by Country" sub="Last 30 days (BigQuery public dataset)" color={C.pypi} maxItems={20} nameKey="country" valueKey="downloads"
              data={countryDownloads.map(d => ({ country: COUNTRY_NAMES[d.countryCode] || d.countryCode, downloads: d.downloads }))} />
          )}
        </>
      ) : packages.length === 0 ? <Empty message={`No ${eco} data yet.`} command={`npm run collect-${eco.toLowerCase()}`} /> : null}
    </>
  );
}

/* ============================================================
   Docker
   ============================================================ */
function DockerTab({ images, sel, setSel, data, loading }) {
  const [filter, setFilter] = useState('');
  const rows = filter ? images.filter(i => (i.full_name || '').toLowerCase().includes(filter.toLowerCase())) : images;
  const cols = [
    { key: 'full_name', label: 'Image', sortValue: r => r.full_name, render: r => <span className="cell-name">{r.full_name}</span> },
    { key: 'totalPulls', label: 'Total Pulls', align: 'right', lead: true, render: r => fmtFull(r.totalPulls) },
    { key: 'stars', label: 'Stars', align: 'right', render: r => fmtFull(r.stars) },
  ];
  return (
    <>
      {images.length > 0 && (
        <Panel title="Docker Images" sub="Click an image for its pull history." tools={<Filter value={filter} onChange={setFilter} placeholder="Filter images…" />} pad={false}>
          <DataTable columns={cols} rows={rows} getKey={r => r.id} onRowClick={r => setSel(r.id)} selectedKey={sel} initialSort={{ key: 'totalPulls', dir: 'desc' }} />
        </Panel>
      )}
      {loading ? <Loading /> : data ? (
        <>
          <SecLabel>{data.image?.full_name || 'Detail'}</SecLabel>
          <div className="cards">
            <Kpi icon={<Container size={17} />} color={C.docker} label="Total Pulls" value={fmtFull(data.summary?.totalPulls)} sub="all time" />
            <Kpi icon={<TrendingUp size={17} />} color={C.accent} label="Pull Growth" value={`+${fmtFull(data.summary?.pullGrowth)}`} sub="during tracked period" />
            <Kpi icon={<Star size={17} />} color={C.pypi} label="Docker Hub Stars" value={fmtFull(data.summary?.stars)} sub={data.image?.full_name || ''} />
          </div>
          {data.pulls?.length > 1 && (
            <Chart title="Cumulative Pulls" height={340}>
              <AreaChart data={data.pulls}>
                <defs><linearGradient id="dpull" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.docker} stopOpacity={0.3} /><stop offset="100%" stopColor={C.docker} stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="date" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
                <Tooltip {...tt} labelFormatter={fmtDate} formatter={v => [fmtFull(v), 'Total Pulls']} />
                <Area type="monotone" dataKey="totalPulls" stroke={C.docker} fill="url(#dpull)" strokeWidth={2} name="Total Pulls" />
              </AreaChart>
            </Chart>
          )}
          {data.pulls?.length > 2 && (
            <Chart title="Daily Pulls">
              <BarChart data={data.pulls.slice(1)}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="date" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
                <Tooltip {...tt} labelFormatter={fmtDate} formatter={v => [fmtFull(v), 'Pulls']} />
                <Bar dataKey="dailyPulls" fill={C.docker} name="Pulls" radius={[4, 4, 0, 0]} />
              </BarChart>
            </Chart>
          )}
          {data.tags?.length > 0 && (
            <Panel title="Image Tags" pad={false}>
              <DataTable
                columns={[
                  { key: 'tag', label: 'Tag', render: r => <span className="cell-name">{r.tag}</span> },
                  { key: 'full_size', label: 'Size', align: 'right', render: r => fmtBytes(r.full_size) },
                  { key: 'last_updated', label: 'Last Updated', sortValue: r => r.last_updated || '', render: r => r.last_updated ? fmtDate(r.last_updated.split('T')[0]) : '—' },
                ]}
                rows={data.tags} getKey={r => r.tag} initialSort={{ key: 'last_updated', dir: 'desc' }} />
            </Panel>
          )}
        </>
      ) : images.length === 0 ? <Empty message="No Docker data yet." command="npm run collect-docker" /> : null}
    </>
  );
}

/* ============================================================
   HuggingFace
   ============================================================ */
function HuggingFaceTab({ models, sel, setSel, data, loading }) {
  const [filter, setFilter] = useState('');
  const rows = filter ? models.filter(m => m.name.toLowerCase().includes(filter.toLowerCase())) : models;
  const t = models.reduce((a, m) => { a.all += m.downloadsAllTime || 0; a.d30 += m.downloads30d || 0; a.likes += m.likes || 0; return a; }, { all: 0, d30: 0, likes: 0 });
  const cols = [
    { key: 'name', label: 'Model', sortValue: r => r.name, render: r => (<div><div className="cell-name">{r.name}</div>{r.pipeline_tag && <div className="cell-desc">{r.pipeline_tag}</div>}</div>) },
    { key: 'downloads30d', label: '30d', align: 'right', render: r => fmtFull(r.downloads30d) },
    { key: 'downloadsAllTime', label: 'All Time', align: 'right', lead: true, render: r => fmtFull(r.downloadsAllTime) },
    { key: 'likes', label: 'Likes', align: 'right', render: r => fmtFull(r.likes) },
  ];
  const footer = [
    <td key="t">Total</td>,
    <td key="30" className="num">{fmtFull(t.d30)}</td>,
    <td key="a" className="num lead">{fmtFull(t.all)}</td>,
    <td key="l" className="num">{fmtFull(t.likes)}</td>,
  ];
  return (
    <>
      {models.length > 0 ? (
        <Panel title="HuggingFace Models" sub="Auto-discovered from the OpenA2A org. HF reports cumulative all-time downloads and a rolling 30-day figure; the daily series below builds as snapshots accumulate." tools={<Filter value={filter} onChange={setFilter} placeholder="Filter models…" />} pad={false}>
          <DataTable columns={cols} rows={rows} getKey={r => r.id} onRowClick={r => setSel(r.id)} selectedKey={sel} initialSort={{ key: 'downloadsAllTime', dir: 'desc' }} footer={footer} />
        </Panel>
      ) : <Empty message="No HuggingFace data yet." command="HF_AUTHOR=opena2a npm run collect-hf" />}

      {loading ? <Loading /> : data ? (
        <>
          <SecLabel>{data.model?.model_id || 'Detail'}</SecLabel>
          <div className="cards">
            <Kpi icon={<Download size={17} />} color={C.hf} label="All-Time Downloads" value={fmtFull(data.summary?.downloadsAllTime)} sub="cumulative" />
            <Kpi icon={<TrendingUp size={17} />} color={C.accent} label="Last 30 Days" value={fmtFull(data.summary?.downloads30d)} sub="rolling (HF API)" />
            <Kpi icon={<Heart size={17} />} color={C.npm} label="Likes" value={fmtFull(data.summary?.likes)} sub={data.model?.pipeline_tag || ''} />
          </div>
          {data.series?.length > 1 ? (
            <Chart title="Cumulative Downloads" sub="Built from daily snapshots of HF's all-time counter" height={320}>
              <AreaChart data={data.series}>
                <defs><linearGradient id="hf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.hf} stopOpacity={0.3} /><stop offset="100%" stopColor={C.hf} stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="date" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
                <Tooltip {...tt} labelFormatter={fmtDate} formatter={v => [fmtFull(v), 'Downloads']} />
                <Area type="monotone" dataKey="downloadsAllTime" stroke={C.hf} fill="url(#hf)" strokeWidth={2} name="All-Time Downloads" />
              </AreaChart>
            </Chart>
          ) : (
            <Empty message="The download trend chart fills in as daily snapshots accumulate — check back after a few days of collection." />
          )}
        </>
      ) : null}
    </>
  );
}

/* ============================================================
   Chrome Web Store
   ============================================================ */
function ChromeTab({ extensions, sel, setSel, data, loading }) {
  const [filter, setFilter] = useState('');
  const rows = filter ? extensions.filter(e => (e.name || e.extension_id || '').toLowerCase().includes(filter.toLowerCase())) : extensions;
  const cols = [
    { key: 'name', label: 'Extension', sortValue: r => r.name || r.extension_id, render: r => (<div><div className="cell-name">{r.name || r.extension_id}</div>{r.version && <div className="cell-desc">v{r.version}</div>}</div>) },
    { key: 'users', label: 'Weekly Users', align: 'right', lead: true, render: r => fmtFull(r.users) },
    { key: 'rating', label: 'Rating', align: 'right', render: r => r.rating != null ? `${r.rating.toFixed(1)} (${fmtFull(r.ratingCount || 0)})` : <span className="muted">—</span> },
  ];
  return (
    <>
      {extensions.length > 0 ? (
        <Panel title="Chrome Web Store Extensions" sub="Google exposes no install/download API — the only public number is the listing's rounded weekly-active-user count (a snapshot, like GitHub stars), scraped daily. It is not a cumulative install total. The trend below builds as snapshots accumulate." tools={<Filter value={filter} onChange={setFilter} placeholder="Filter extensions…" />} pad={false}>
          <DataTable columns={cols} rows={rows} getKey={r => r.id} onRowClick={r => setSel(r.id)} selectedKey={sel} initialSort={{ key: 'users', dir: 'desc' }} />
        </Panel>
      ) : <Empty message="No Chrome Web Store data yet." command="CHROME_EXTENSIONS=<extensionId> npm run collect-chrome" />}

      {loading ? <Loading /> : data ? (
        <>
          <SecLabel>{data.extension?.name || data.extension?.extension_id || 'Detail'}</SecLabel>
          <div className="cards">
            <Kpi icon={<Users size={17} />} color={C.chrome} label="Weekly Users" value={fmtFull(data.summary?.users)} sub="rounded, weekly active" />
            <Kpi icon={<TrendingUp size={17} />} color={C.accent} label="Growth" value={`${data.summary?.usersGrowth >= 0 ? '+' : ''}${fmtFull(data.summary?.usersGrowth)}`} sub="during tracked period" />
            <Kpi icon={<Star size={17} />} color={C.pypi} label="Rating" value={data.summary?.rating != null ? data.summary.rating.toFixed(1) : '—'} sub={data.summary?.ratingCount != null ? `${fmtFull(data.summary.ratingCount)} ratings` : 'no ratings yet'} />
          </div>
          {data.history?.length > 1 ? (
            <Chart title="Weekly Users" sub="Snapshot of the store's weekly-active-user count, one point per collection day" height={320}>
              <AreaChart data={data.history}>
                <defs><linearGradient id="chr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.chrome} stopOpacity={0.3} /><stop offset="100%" stopColor={C.chrome} stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="date" {...axDate} /><YAxis {...ax} tickFormatter={fmtNum} />
                <Tooltip {...tt} labelFormatter={fmtDate} formatter={v => [fmtFull(v), 'Weekly Users']} />
                <Area type="monotone" dataKey="users" stroke={C.chrome} fill="url(#chr)" strokeWidth={2} name="Weekly Users" />
              </AreaChart>
            </Chart>
          ) : (
            <Empty message="The weekly-users trend fills in as daily snapshots accumulate — check back after a few days of collection." />
          )}
        </>
      ) : null}
    </>
  );
}
