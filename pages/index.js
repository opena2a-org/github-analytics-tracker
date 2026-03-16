import { useState, useEffect } from 'react';
import Head from 'next/head';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart, PieChart, Pie, Cell,
} from 'recharts';
import {
  GitFork, Star, Eye, GitPullRequest, Calendar, Users, Download,
  Package, TrendingUp, TrendingDown, BarChart3, Container,
  Github, Box, Layers, Tag, Monitor, Code, FileDown, Search,
} from 'lucide-react';

/* ============================================
   Constants
   ============================================ */
const TIME_RANGES = [
  { label: '24h', value: '1' },
  { label: '7d', value: '7' },
  { label: '14d', value: '14' },
  { label: '30d', value: '30' },
  { label: '90d', value: '90' },
  { label: '6mo', value: '180' },
  { label: '1yr', value: '365' },
  { label: 'All', value: 'all' },
];

const TABS = [
  { id: 'overview', label: 'Overview', color: '#00d4aa' },
  { id: 'github', label: 'GitHub', color: '#4c9aff' },
  { id: 'npm', label: 'npm', color: '#ff6b6b' },
  { id: 'pypi', label: 'PyPI', color: '#f59e0b' },
  { id: 'docker', label: 'Docker', color: '#38bdf8' },
];

/* Chart theme constants for dark backgrounds */
const C = {
  grid: 'rgba(255,255,255,0.06)',
  axisLabel: '#56657a',
  blue: '#4c9aff', blueFill: 'rgba(76,154,255,0.15)',
  teal: '#00d4aa', tealFill: 'rgba(0,212,170,0.12)',
  purple: '#a78bfa', purpleFill: 'rgba(167,139,250,0.12)',
  pink: '#f472b6',
  red: '#ff6b6b', redFill: 'rgba(255,107,107,0.15)',
  amber: '#f59e0b', amberFill: 'rgba(245,158,11,0.15)',
  sky: '#38bdf8', skyFill: 'rgba(56,189,248,0.15)',
  dark: '#1a2035',
  green: '#22c55e', greenFill: 'rgba(34,197,94,0.15)',
  orange: '#fb923c', orangeFill: 'rgba(251,146,60,0.15)',
  cyan: '#06b6d4', cyanFill: 'rgba(6,182,212,0.15)',
  rose: '#f43f5e', roseFill: 'rgba(244,63,94,0.15)',
};

const axProps = { fontSize: 11, tick: { fill: C.axisLabel } };
const xDateProps = { ...axProps, tickFormatter: formatDateLabel };
const ttProps = {
  contentStyle: {
    background: '#232c42', border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '8px', fontSize: '12px', color: '#e8edf5',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },
  itemStyle: { color: '#8896ab' },
};

/* ============================================
   Helpers
   ============================================ */
function formatDateLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function formatNumber(n) {
  if (n == null) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}
function formatFullNumber(n) {
  return (n || 0).toLocaleString();
}

const BREAKDOWN_COLORS = [
  '#4c9aff', '#00d4aa', '#f59e0b', '#ff6b6b', '#a78bfa',
  '#38bdf8', '#f472b6', '#22c55e', '#fb923c', '#06b6d4',
  '#e879f9', '#fbbf24', '#34d399', '#818cf8', '#f87171',
];

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

/* ============================================
   Shared UI Components
   ============================================ */
function GrowthBadge({ value }) {
  if (value == null) return null;
  const num = parseFloat(value);
  const up = num >= 0;
  return (
    <span className={`growth ${up ? 'up' : 'down'}`}>
      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {up ? '+' : ''}{value}%
    </span>
  );
}

function MetricCard({ icon, iconBg, label, value, sub, growth }) {
  return (
    <div className="metric-card">
      <div className="metric-icon" style={{ background: iconBg }}>{icon}</div>
      <div className="metric-label">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
        <div className="metric-value">{value}</div>
        {growth != null && <GrowthBadge value={growth} />}
      </div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

function EcoCard({ name, color, icon, rows }) {
  return (
    <div className="eco-card">
      <div className="eco-header">
        <span className="eco-dot" style={{ background: color }} />
        <span className="eco-name">{name}</span>
        {icon}
      </div>
      {rows.map(r => (
        <div className="eco-row" key={r.label}>
          <span className="eco-row-label">{r.label}</span>
          <span className="eco-row-value">{formatFullNumber(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function ChartWrap({ title, sub, children }) {
  return (
    <div className="chart-card">
      <div className="chart-head">
        <div className="chart-title">{title}</div>
        {sub && <div className="chart-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Selector({ label, value, onChange, items, nameKey = 'name', idKey = 'id' }) {
  const [filter, setFilter] = useState('');
  const filtered = filter
    ? items.filter(it => {
        const text = (it.full_name || it[nameKey] || '').toLowerCase();
        return text.includes(filter.toLowerCase());
      })
    : items;
  return (
    <div className="section-card">
      <div className="section-body">
        <div className="field-group">
          <label className="field-label">{label}</label>
          {items.length > 3 && (
            <SearchInput value={filter} onChange={setFilter} placeholder={`Filter ${label.toLowerCase()}...`} />
          )}
          <select className="select-field" value={value || ''} onChange={e => onChange(Number(e.target.value))}>
            {filtered.map(it => <option key={it[idKey]} value={it[idKey]}>{it.full_name || it[nameKey]}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

function BreakdownChart({ title, sub, data, nameKey, valueKey, maxItems = 10, color }) {
  if (!data || data.length === 0) return null;
  const sorted = [...data].sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0));
  const top = sorted.slice(0, maxItems);

  return (
    <ChartWrap title={title} sub={sub}>
      <ResponsiveContainer width="100%" height={Math.max(200, top.length * 36)}>
        <BarChart data={top} layout="vertical" margin={{ left: 80 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis type="number" {...axProps} />
          <YAxis type="category" dataKey={nameKey} {...axProps} width={80} />
          <Tooltip {...ttProps} />
          <Bar dataKey={valueKey} name="Downloads" radius={[0, 4, 4, 0]}>
            {top.map((entry, idx) => (
              <Cell key={idx} fill={color || BREAKDOWN_COLORS[idx % BREAKDOWN_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartWrap>
  );
}

function BreakdownTable({ title, columns, data }) {
  if (!data || data.length === 0) return null;
  return (
    <div className="section-card">
      <div className="section-header"><div className="section-title">{title}</div></div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col.key} className={col.align === 'right' ? 'r' : ''}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i}>
                {columns.map(col => (
                  <td key={col.key} className={col.align === 'right' ? 'num' : ''}>
                    {col.format ? col.format(row[col.key], row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Loading() {
  return <div className="loading"><div className="spinner" /><p>Loading analytics...</p></div>;
}

function Empty({ message, command }) {
  return (
    <div className="empty">
      <Calendar size={36} color="#56657a" />
      <p>{message}</p>
      <code>{command}</code>
    </div>
  );
}

function SearchInput({ value, onChange, placeholder = 'Search...' }) {
  return (
    <div className="search-wrap">
      <Search size={14} className="search-icon" />
      <input
        type="text"
        className="search-input"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

const GRANULARITIES = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
];

function GranularitySelector({ value, onChange }) {
  return (
    <div className="granularity-bar">
      {GRANULARITIES.map(g => (
        <button key={g.value}
          className={`granularity-btn ${value === g.value ? 'active' : ''}`}
          onClick={() => onChange(g.value)}>
          {g.label}
        </button>
      ))}
    </div>
  );
}

/* ============================================
   Weekly aggregation helpers
   ============================================ */
function toWeekKey(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  const day = date.getUTCDay();
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
  const ws = new Date(date);
  ws.setUTCDate(diff);
  return ws.toISOString().split('T')[0];
}

function getWeeklyDownloadData(downloads) {
  if (!downloads || downloads.length === 0) return [];
  const weeks = {};
  downloads.forEach(d => {
    const wk = toWeekKey(d.date);
    if (!weeks[wk]) weeks[wk] = { week: wk, downloads: 0 };
    weeks[wk].downloads += d.downloads || 0;
  });
  return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week));
}

/* ============================================
   Dashboard Root
   ============================================ */
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [timeRange, setTimeRange] = useState('30');

  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [githubData, setGithubData] = useState(null);
  const [githubLoading, setGithubLoading] = useState(false);

  const [npmPackages, setNpmPackages] = useState([]);
  const [selectedNpmPackage, setSelectedNpmPackage] = useState(null);
  const [npmData, setNpmData] = useState(null);
  const [npmLoading, setNpmLoading] = useState(false);

  const [pypiPackages, setPypiPackages] = useState([]);
  const [selectedPypiPackage, setSelectedPypiPackage] = useState(null);
  const [pypiData, setPypiData] = useState(null);
  const [pypiLoading, setPypiLoading] = useState(false);

  const [dockerImages, setDockerImages] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [dockerData, setDockerData] = useState(null);
  const [dockerLoading, setDockerLoading] = useState(false);

  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [trends, setTrends] = useState(null);
  const [trendsGranularity, setTrendsGranularity] = useState('weekly');

  /* --- Fetch on mount --- */
  useEffect(() => {
    fetch('/api/repos').then(r => r.ok ? r.json() : []).then(d => {
      if (Array.isArray(d)) { setRepos(d); if (d.length) setSelectedRepo(d[0].id); }
    }).catch(() => {});
    fetch('/api/npm-stats').then(r => r.ok ? r.json() : {}).then(d => {
      setNpmPackages(d.packages || []);
      if (d.packages?.length) setSelectedNpmPackage(d.packages[0].id);
    }).catch(() => {});
    fetch('/api/pypi-stats').then(r => r.ok ? r.json() : {}).then(d => {
      setPypiPackages(d.packages || []);
      if (d.packages?.length) setSelectedPypiPackage(d.packages[0].id);
    }).catch(() => {});
    fetch('/api/docker-stats').then(r => r.ok ? r.json() : {}).then(d => {
      setDockerImages(d.images || []);
      if (d.images?.length) setSelectedImage(d.images[0].id);
    }).catch(() => {});
    fetch('/api/overview?days=all').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.totals) setOverview(d);
    }).catch(() => {}).finally(() => setOverviewLoading(false));
  }, []);

  /* --- Fetch trends when granularity or time range changes --- */
  useEffect(() => {
    const trendsDays = timeRange === 'all' ? 'all' : timeRange;
    fetch(`/api/trends?granularity=${trendsGranularity}&days=${trendsDays}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setTrends(d); })
      .catch(() => {});
  }, [trendsGranularity, timeRange]);

  /* --- Fetch detail data when selection/range changes --- */
  useEffect(() => { if (selectedRepo) fetchDetail(`/api/stats?repo_id=${selectedRepo}&days=${timeRange}`, setGithubData, setGithubLoading); }, [selectedRepo, timeRange]);
  useEffect(() => { if (selectedNpmPackage) fetchDetail(`/api/npm-stats?package_id=${selectedNpmPackage}&days=${timeRange}`, setNpmData, setNpmLoading); }, [selectedNpmPackage, timeRange]);
  useEffect(() => { if (selectedPypiPackage) fetchDetail(`/api/pypi-stats?package_id=${selectedPypiPackage}&days=${timeRange}`, setPypiData, setPypiLoading); }, [selectedPypiPackage, timeRange]);
  useEffect(() => { if (selectedImage) fetchDetail(`/api/docker-stats?image_id=${selectedImage}&days=${timeRange}`, setDockerData, setDockerLoading); }, [selectedImage, timeRange]);

  function fetchDetail(url, setData, setLoading) {
    setLoading(true);
    fetch(url).then(r => r.ok ? r.json() : null).then(d => { if (d) setData(d); }).catch(() => {}).finally(() => setLoading(false));
  }

  /* --- GitHub combined data --- */
  const getCombinedGithubData = () => {
    if (!githubData) return [];
    const m = {};
    (githubData.views || []).forEach(v => { m[v.date] = { date: v.date, views: v.count, viewsUnique: v.uniques }; });
    (githubData.clones || []).forEach(c => { if (!m[c.date]) m[c.date] = { date: c.date }; m[c.date].clones = c.count; m[c.date].clonesUnique = c.uniques; });
    return Object.values(m).sort((a, b) => a.date.localeCompare(b.date));
  };
  const getWeeklyGithubData = () => {
    const combined = getCombinedGithubData();
    if (!combined.length) return [];
    const w = {};
    combined.forEach(d => { const wk = toWeekKey(d.date); if (!w[wk]) w[wk] = { week: wk, views: 0, clones: 0 }; w[wk].views += d.views || 0; w[wk].clones += d.clones || 0; });
    return Object.values(w).sort((a, b) => a.week.localeCompare(b.week));
  };

  const activeLabel = TABS.find(t => t.id === activeTab)?.label || '';

  return (
    <>
      <Head>
        <title>OpenA2A Analytics</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="dashboard">
        {/* --- Sidebar --- */}
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-brand">
            <h1>Analytics</h1>
            <p>OpenA2A</p>
          </div>
          <nav className="sidebar-nav">
            {TABS.map(tab => (
              <button key={tab.id} className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => { setActiveTab(tab.id); setSidebarOpen(false); }}>
                <span className="nav-dot" style={{ background: tab.color }} />
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            {overview?.lastUpdated ? `Updated ${formatDateLabel(overview.lastUpdated.split('T')[0])}` : ''}
          </div>
        </aside>

        {/* --- Mobile overlay --- */}
        <div className={`overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />

        {/* --- Main area --- */}
        <div className="main-area">
          {/* Mobile top bar */}
          <div className="mobile-bar">
            <button className="burger" onClick={() => setSidebarOpen(true)}><Layers size={20} /></button>
            <h2>{activeLabel}</h2>
          </div>

          {/* Sticky topbar */}
          <div className="topbar">
            <span className="topbar-title">{activeLabel}</span>
            <div className="time-bar">
              {TIME_RANGES.map(tr => (
                <button key={tr.value} className={`time-btn ${timeRange === tr.value ? 'active' : ''}`}
                  onClick={() => setTimeRange(tr.value)}>
                  {tr.label}
                </button>
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="content">
            {activeTab === 'overview' && <OverviewTab overview={overview} loading={overviewLoading}
              trends={trends} trendsGranularity={trendsGranularity} setTrendsGranularity={setTrendsGranularity} />}
            {activeTab === 'github' && (
              <GitHubTab repos={repos} selectedRepo={selectedRepo} setSelectedRepo={setSelectedRepo}
                data={githubData} loading={githubLoading}
                getCombinedData={getCombinedGithubData} getWeeklyData={getWeeklyGithubData} />
            )}
            {activeTab === 'npm' && (
              <PackageTab ecosystem="npm" color={C.red} fillColor={C.redFill} barColor={C.red}
                packages={npmPackages} selectedPackage={selectedNpmPackage}
                setSelectedPackage={setSelectedNpmPackage}
                pkgData={npmData} loading={npmLoading}
                getWeeklyData={() => getWeeklyDownloadData(npmData?.downloads)}
                versionDownloads={npmData?.versionDownloads} />
            )}
            {activeTab === 'pypi' && (
              <PackageTab ecosystem="PyPI" color={C.amber} fillColor={C.amberFill} barColor={C.amber}
                packages={pypiPackages} selectedPackage={selectedPypiPackage}
                setSelectedPackage={setSelectedPypiPackage}
                pkgData={pypiData} loading={pypiLoading}
                getWeeklyData={() => getWeeklyDownloadData(pypiData?.downloads)}
                pythonVersions={pypiData?.pythonVersions}
                systemStats={pypiData?.systemStats}
                countryDownloads={pypiData?.countryDownloads} />
            )}
            {activeTab === 'docker' && (
              <DockerTab images={dockerImages} selectedImage={selectedImage}
                setSelectedImage={setSelectedImage} dockerData={dockerData} loading={dockerLoading} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================
   Overview Tab
   ============================================ */
const ADOPTION_PERIODS = [
  { label: 'All Time', value: 'all' },
  { label: '30 Days', value: '30d' },
  { label: '7 Days', value: '7d' },
  { label: '24 Hours', value: '24h' },
];

/** Helper: pick the correct metric value based on selected adoption period */
function pickPeriodValue(obj, allKey, d30Key, d7Key, d24hKey, period) {
  switch (period) {
    case '24h': return obj?.[d24hKey] || 0;
    case '7d': return obj?.[d7Key] || 0;
    case '30d': return obj?.[d30Key] || 0;
    default: return obj?.[allKey] || 0;
  }
}

/** WoW change indicator: compares current 7d vs previous 7d */
function WowIndicator({ current, previous }) {
  if (!previous || previous === 0) return null;
  const pct = ((current - previous) / previous * 100).toFixed(0);
  const num = Number(pct);
  if (num === 0) return null;
  const color = num > 0 ? '#22c55e' : '#ff6b6b';
  const arrow = num > 0 ? '+' : '';
  return (
    <span style={{ fontSize: '10px', color, marginLeft: '4px', fontWeight: 600 }}>
      {arrow}{pct}%
    </span>
  );
}

function OverviewTab({ overview, loading, trends, trendsGranularity, setTrendsGranularity }) {
  const [productFilter, setProductFilter] = useState('');
  const [adoptionPeriod, setAdoptionPeriod] = useState('30d');

  if (loading) return <Loading />;
  if (!overview) return <Empty message="No data available yet." command="npm run collect-all" />;
  const { totals, products = [], weeklyTrend = [] } = overview;

  const wow = trends?.growth?.wow;
  const mom = trends?.growth?.mom;

  const filteredProducts = productFilter
    ? products.filter(p =>
        p.name.toLowerCase().includes(productFilter.toLowerCase()) ||
        (p.description || '').toLowerCase().includes(productFilter.toLowerCase()))
    : products;

  return (
    <>
      {/* Hero + growth row */}
      <div className="hero-card">
        <div className="hero-label">Total Adoption</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px', flexWrap: 'wrap' }}>
          <div className="hero-value">{formatFullNumber(totals.combined.totalAdoption)}</div>
          {wow && (
            <div className="growth-row">
              <div className="growth-item">
                <span className="growth-item-label">WoW</span>
                <GrowthBadge value={wow.downloads} />
              </div>
              {mom && (
                <div className="growth-item">
                  <span className="growth-item-label">MoM</span>
                  <GrowthBadge value={mom.downloads} />
                </div>
              )}
            </div>
          )}
        </div>
        <div className="hero-sub">Clones + npm + PyPI + Docker pulls -- across all products</div>
      </div>

      {/* KPI row */}
      <div className="grid grid-5">
        <MetricCard icon={<Eye size={18} color={C.blue} />} iconBg="rgba(76,154,255,0.10)"
          label="Page Views" value={formatFullNumber(totals.combined.totalPageViews)}
          sub={`${totals.github.repos} repositories`}
          growth={wow?.views} />
        <MetricCard icon={<Star size={18} color={C.amber} />} iconBg="rgba(245,158,11,0.10)"
          label="GitHub Stars" value={formatFullNumber(totals.github.totalStars)} sub="Community endorsements" />
        <MetricCard icon={<Download size={18} color={C.red} />} iconBg="rgba(255,107,107,0.10)"
          label="npm (30d)" value={formatFullNumber(totals.npm.last30Downloads)}
          sub={`${totals.npm.packages} packages`} />
        <MetricCard icon={<Package size={18} color={C.amber} />} iconBg="rgba(245,158,11,0.10)"
          label="PyPI (30d)" value={formatFullNumber(totals.pypi?.last30Downloads || 0)}
          sub={`${totals.pypi?.packages || 0} packages`} />
        <MetricCard icon={<Container size={18} color={C.sky} />} iconBg="rgba(56,189,248,0.10)"
          label="Docker Pulls" value={formatFullNumber(totals.docker?.totalPulls || 0)}
          sub={`${totals.docker?.images || 0} images`} />
      </div>

      {/* Granularity selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Trend Granularity</span>
        <GranularitySelector value={trendsGranularity} onChange={setTrendsGranularity} />
      </div>

      {/* Trend charts */}
      {trends?.series?.length > 1 && (
        <div className="grid grid-2-lg">
          <ChartWrap title="Combined Adoption Trend" sub="npm + PyPI + Docker across all products">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={trends.series}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="periodStart" {...xDateProps} />
                <YAxis {...axProps} />
                <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Area type="monotone" dataKey="npmDownloads" stroke={C.red} fill={C.redFill} name="npm" stackId="dl" />
                <Area type="monotone" dataKey="pypiDownloads" stroke={C.amber} fill={C.amberFill} name="PyPI" stackId="dl" />
                <Area type="monotone" dataKey="dockerPulls" stroke={C.sky} fill={C.skyFill} name="Docker" stackId="dl" />
                <Line type="monotone" dataKey="totalDownloads" stroke={C.teal} strokeWidth={2} dot={false} name="Total" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartWrap>

          <ChartWrap title="GitHub Traffic Trend" sub="Views + clones across all repos">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={trends.series}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="periodStart" {...xDateProps} />
                <YAxis {...axProps} />
                <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Area type="monotone" dataKey="views" stroke={C.blue} fill={C.blueFill} name="Views" />
                <Line type="monotone" dataKey="clones" stroke={C.purple} strokeWidth={2} dot={false} name="Clones" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartWrap>
        </div>
      )}

      {/* Star growth chart */}
      {trends?.starTimeline?.length > 1 && (
        <ChartWrap title="Star Growth" sub="Total stars across all repositories over time">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={trends.starTimeline}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="date" {...xDateProps} />
              <YAxis {...axProps} />
              <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
              <Area type="monotone" dataKey="totalStars" stroke={C.amber} fill={C.amberFill} name="Total Stars" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartWrap>
      )}

      {/* Product table with search and time period selector */}
      <div className="section-card">
        <div className="section-header">
          <div className="section-title">Product Adoption</div>
          <div className="adoption-period-tabs">
            {ADOPTION_PERIODS.map(p => (
              <button
                key={p.value}
                className={`adoption-period-tab${adoptionPeriod === p.value ? ' active' : ''}`}
                onClick={() => setAdoptionPeriod(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '12px 16px 0' }}>
          <SearchInput value={productFilter} onChange={setProductFilter} placeholder="Filter products..." />
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="r">Views</th>
                <th className="r">Clones</th>
                <th className="r">npm</th>
                <th className="r">PyPI</th>
                <th className="r">Docker</th>
                <th className="r">Stars</th>
                <th className="r">Total</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map(p => {
                const views = pickPeriodValue(p.github, 'views', 'views30d', 'views7d', 'views24h', adoptionPeriod);
                const clones = pickPeriodValue(p.github, 'clones', 'clones30d', 'clones7d', 'clones24h', adoptionPeriod);
                const npm = pickPeriodValue(p.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', adoptionPeriod);
                const pypi = pickPeriodValue(p.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', adoptionPeriod);
                const docker = adoptionPeriod === 'all' ? (p.docker?.totalPulls || 0) : 0;
                const total = clones + npm + pypi + docker;
                return (
                  <tr key={p.name}>
                    <td><div className="product-name">{p.name}</div><div className="product-desc">{p.description}</div></td>
                    <td className="num">{formatFullNumber(views)}</td>
                    <td className="num">{formatFullNumber(clones)}</td>
                    <td className="num">
                      {formatFullNumber(npm)}
                      {(adoptionPeriod === '30d' || adoptionPeriod === '7d') && <WowIndicator current={p.npm?.last7Downloads || 0} previous={p.npm?.prev7Downloads || 0} />}
                    </td>
                    <td className="num">
                      {formatFullNumber(pypi)}
                      {(adoptionPeriod === '30d' || adoptionPeriod === '7d') && <WowIndicator current={p.pypi?.last7Downloads || 0} previous={p.pypi?.prev7Downloads || 0} />}
                    </td>
                    <td className="num">{adoptionPeriod === 'all' ? formatFullNumber(docker) : '--'}</td>
                    <td className="num">{p.github.stars || 0}</td>
                    <td className="num strong">{formatFullNumber(total)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{formatFullNumber(pickPeriodValue(totals.github, 'totalViews', 'views30d', 'views7d', 'views24h', adoptionPeriod))}</td>
                <td className="num">{formatFullNumber(pickPeriodValue(totals.github, 'totalClones', 'clones30d', 'clones7d', 'clones24h', adoptionPeriod))}</td>
                <td className="num">
                  {formatFullNumber(pickPeriodValue(totals.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', adoptionPeriod))}
                  {adoptionPeriod === '30d' && <WowIndicator current={totals.npm?.last7Downloads || 0} previous={totals.npm?.prev7Downloads || 0} />}
                </td>
                <td className="num">
                  {formatFullNumber(pickPeriodValue(totals.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', adoptionPeriod))}
                  {adoptionPeriod === '30d' && <WowIndicator current={totals.pypi?.last7Downloads || 0} previous={totals.pypi?.prev7Downloads || 0} />}
                </td>
                <td className="num">{adoptionPeriod === 'all' ? formatFullNumber(totals.docker?.totalPulls || 0) : '--'}</td>
                <td className="num">{totals.github.totalStars || 0}</td>
                <td className="num strong">{formatFullNumber(
                  pickPeriodValue(totals.github, 'totalClones', 'clones30d', 'clones7d', 'clones24h', adoptionPeriod) +
                  pickPeriodValue(totals.npm, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', adoptionPeriod) +
                  pickPeriodValue(totals.pypi, 'allTimeDownloads', 'last30Downloads', 'last7Downloads', 'last24hDownloads', adoptionPeriod) +
                  (adoptionPeriod === 'all' ? (totals.docker?.totalPulls || 0) : 0)
                )}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-2-lg">
        {products.length > 0 && (
          <ChartWrap title="Adoption by Product">
            <ResponsiveContainer width="100%" height={Math.max(250, products.length * 50)}>
              <BarChart data={products} layout="vertical" margin={{ left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis type="number" {...axProps} />
                <YAxis type="category" dataKey="name" {...axProps} width={100} />
                <Tooltip {...ttProps} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Bar dataKey="github.clones" fill={C.blue} name="Git Clones" stackId="a" />
                <Bar dataKey="npm.allTimeDownloads" fill={C.red} name="npm" stackId="a" />
                <Bar dataKey="pypi.allTimeDownloads" fill={C.amber} name="PyPI" stackId="a" />
                <Bar dataKey="docker.totalPulls" fill={C.sky} name="Docker" stackId="a" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartWrap>
        )}
        {weeklyTrend.length > 1 && (
          <ChartWrap title="Weekly Download Trend" sub="npm + PyPI combined">
            <ResponsiveContainer width="100%" height={Math.max(250, products.length * 50)}>
              <ComposedChart data={weeklyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="week_start" {...xDateProps} />
                <YAxis {...axProps} />
                <Tooltip labelFormatter={v => `Week of ${formatDateLabel(v)}`} {...ttProps} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Bar dataKey="npm" fill="rgba(255,107,107,0.5)" name="npm" stackId="dl" />
                <Bar dataKey="pypi" fill="rgba(245,158,11,0.5)" name="PyPI" stackId="dl" radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="downloads" stroke={C.teal} strokeWidth={2} dot={false} name="Total" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartWrap>
        )}
      </div>

      {/* Ecosystem summary cards */}
      <div className="grid grid-4">
        <EcoCard name="GitHub" color={C.blue} icon={<Github size={14} color={C.blue} />} rows={[
          { label: 'Repositories', value: totals.github.repos },
          { label: 'Page views', value: totals.github.totalViews },
          { label: 'Git clones', value: totals.github.totalClones },
          { label: 'Stars', value: totals.github.totalStars },
          { label: 'Forks', value: totals.github.totalForks },
          { label: 'Contributors', value: totals.github.totalContributors || 0 },
          { label: 'Release downloads', value: totals.github.totalReleaseDownloads || 0 },
        ]} />
        <EcoCard name="npm" color={C.red} icon={<Box size={14} color={C.red} />} rows={[
          { label: 'Packages', value: totals.npm.packages },
          { label: 'All-time downloads', value: totals.npm.allTimeDownloads },
          { label: 'Last 30d', value: totals.npm.last30Downloads },
          { label: 'Last 7d', value: totals.npm.last7Downloads },
        ]} />
        <EcoCard name="PyPI" color={C.amber} icon={<Package size={14} color={C.amber} />} rows={[
          { label: 'Packages', value: totals.pypi?.packages || 0 },
          { label: 'All-time downloads', value: totals.pypi?.allTimeDownloads || 0 },
          { label: 'Last 30d', value: totals.pypi?.last30Downloads || 0 },
          { label: 'Last 7d', value: totals.pypi?.last7Downloads || 0 },
        ]} />
        <EcoCard name="Docker" color={C.sky} icon={<Container size={14} color={C.sky} />} rows={[
          { label: 'Images', value: totals.docker?.images || 0 },
          { label: 'Total pulls', value: totals.docker?.totalPulls || 0 },
        ]} />
      </div>
    </>
  );
}

/* ============================================
   GitHub Tab
   ============================================ */
function GitHubTab({ repos, selectedRepo, setSelectedRepo, data, loading, getCombinedData, getWeeklyData }) {
  return (
    <>
      <Selector label="Repository" value={selectedRepo} onChange={setSelectedRepo}
        items={repos} nameKey="full_name" />

      {loading ? <Loading /> : data ? (
        <>
          <div className="grid grid-5">
            <MetricCard icon={<Eye size={18} color={C.blue} />} iconBg="rgba(76,154,255,0.10)"
              label="Total Views" value={formatFullNumber(data.summary.totalViews)} sub="All time" />
            <MetricCard icon={<GitPullRequest size={18} color={C.teal} />} iconBg="rgba(0,212,170,0.10)"
              label="Total Clones" value={formatFullNumber(data.summary.totalClones)} sub="All time" />
            <MetricCard icon={<Users size={18} color={C.sky} />} iconBg="rgba(56,189,248,0.10)"
              label="Unique Visitors" value={formatFullNumber(data.summary.recentUniqueVisitors)} sub="Last 14d (API)" />
            <MetricCard icon={<Star size={18} color={C.amber} />} iconBg="rgba(245,158,11,0.10)"
              label="Stars" value={formatFullNumber(data.summary.latestStars)}
              sub={data.summary.starsGrowth > 0 ? `+${data.summary.starsGrowth} this period` : 'Current'} />
            <MetricCard icon={<GitFork size={18} color={C.purple} />} iconBg="rgba(167,139,250,0.10)"
              label="Forks" value={formatFullNumber(data.summary.latestForks)}
              sub={data.summary.forksGrowth > 0 ? `+${data.summary.forksGrowth} this period` : 'Current'} />
          </div>

          <ChartWrap title="Daily Traffic">
            <ResponsiveContainer width="100%" height={350}>
              <ComposedChart data={getCombinedData()}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="date" {...xDateProps} />
                <YAxis {...axProps} />
                <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Area type="monotone" dataKey="views" stroke={C.blue} fill={C.blueFill} name="Views" />
                <Area type="monotone" dataKey="viewsUnique" stroke={C.teal} fill={C.tealFill} name="Unique Visitors" />
                <Line type="monotone" dataKey="clones" stroke={C.purple} strokeWidth={2} dot={false} name="Clones" />
                <Line type="monotone" dataKey="clonesUnique" stroke={C.pink} strokeWidth={2} dot={false} name="Unique Cloners" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartWrap>

          {getWeeklyData().length > 1 && (
            <ChartWrap title="Weekly Summary">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={getWeeklyData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="week" {...xDateProps} />
                  <YAxis {...axProps} />
                  <Tooltip labelFormatter={v => `Week of ${formatDateLabel(v)}`} {...ttProps} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="views" fill={C.blue} name="Views" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="clones" fill={C.purple} name="Clones" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartWrap>
          )}

          <div className="grid grid-2-lg">
            <ChartWrap title="Views Over Time">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={data.views}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="date" {...xDateProps} />
                  <YAxis {...axProps} />
                  <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                  <Line type="monotone" dataKey="count" stroke={C.blue} strokeWidth={2} dot={{ r: 2, fill: C.blue }} name="Views" />
                  <Line type="monotone" dataKey="uniques" stroke={C.teal} strokeWidth={2} dot={{ r: 2, fill: C.teal }} name="Unique" />
                </LineChart>
              </ResponsiveContainer>
            </ChartWrap>
            <ChartWrap title="Clones Over Time">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={data.clones}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="date" {...xDateProps} />
                  <YAxis {...axProps} />
                  <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                  <Line type="monotone" dataKey="count" stroke={C.purple} strokeWidth={2} dot={{ r: 2, fill: C.purple }} name="Clones" />
                  <Line type="monotone" dataKey="uniques" stroke={C.pink} strokeWidth={2} dot={{ r: 2, fill: C.pink }} name="Unique" />
                </LineChart>
              </ResponsiveContainer>
            </ChartWrap>
          </div>

          {data.referrers?.length > 0 && (
            <ChartWrap title="Top Referrers" sub="Traffic sources (last 14 days)">
              <ResponsiveContainer width="100%" height={Math.max(200, data.referrers.length * 40)}>
                <BarChart data={data.referrers.slice(0, 10)} layout="vertical" margin={{ left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis type="number" {...axProps} />
                  <YAxis type="category" dataKey="referrer" {...axProps} width={80} />
                  <Tooltip {...ttProps} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="count" fill={C.blue} name="Views" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="uniques" fill={C.teal} name="Unique" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartWrap>
          )}

          {data.paths?.length > 0 && (
            <ChartWrap title="Popular Content" sub="Most visited pages (last 14 days)">
              <ResponsiveContainer width="100%" height={Math.max(200, data.paths.length * 40)}>
                <BarChart data={data.paths.slice(0, 10)} layout="vertical" margin={{ left: 120 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis type="number" {...axProps} />
                  <YAxis type="category" dataKey="path" {...axProps} width={120} />
                  <Tooltip {...ttProps} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="count" fill={C.purple} name="Views" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="uniques" fill="rgba(167,139,250,0.5)" name="Unique" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartWrap>
          )}

          {/* Contributors */}
          {data.contributors?.length > 0 && (
            <BreakdownChart
              title="Top Contributors"
              sub="Total commits per contributor"
              data={data.contributors}
              nameKey="login"
              valueKey="contributions"
              maxItems={15}
              color={C.teal}
            />
          )}

          {/* Release Downloads */}
          {data.releases?.length > 0 && (
            <BreakdownTable
              title="Release Downloads"
              columns={[
                { key: 'tag_name', label: 'Tag' },
                { key: 'release_name', label: 'Release' },
                { key: 'published_at', label: 'Published', format: v => v ? formatDateLabel(v.split('T')[0]) : '--' },
                { key: 'total_downloads', label: 'Downloads', align: 'right', format: v => formatFullNumber(v) },
              ]}
              data={data.releases}
            />
          )}
        </>
      ) : (
        <Empty message="No GitHub data available yet." command="npm run collect" />
      )}
    </>
  );
}

/* ============================================
   Unified Package Tab (npm + PyPI)
   ============================================ */
const COUNTRY_NAMES = {
  US: 'United States', DE: 'Germany', CN: 'China', GB: 'United Kingdom',
  FR: 'France', IN: 'India', JP: 'Japan', KR: 'South Korea',
  BR: 'Brazil', CA: 'Canada', AU: 'Australia', NL: 'Netherlands',
  RU: 'Russia', SE: 'Sweden', SG: 'Singapore', PL: 'Poland',
  ES: 'Spain', IT: 'Italy', CH: 'Switzerland', HK: 'Hong Kong',
};

function formatCountryName(code) {
  return COUNTRY_NAMES[code] || code;
}

function PackageTab({ ecosystem, color, fillColor, barColor, packages, selectedPackage, setSelectedPackage, pkgData, loading, getWeeklyData, versionDownloads, pythonVersions, systemStats, countryDownloads }) {
  const [pkgFilter, setPkgFilter] = useState('');
  const sorted = [...packages].sort((a, b) => b.allTimeDownloads - a.allTimeDownloads);
  const filteredPkgs = pkgFilter
    ? sorted.filter(p => p.name.toLowerCase().includes(pkgFilter.toLowerCase()))
    : sorted;
  const totals7 = packages.reduce((s, p) => s + (p.last7Downloads || 0), 0);
  const totals30 = packages.reduce((s, p) => s + (p.last30Downloads || 0), 0);
  const totalsAll = packages.reduce((s, p) => s + (p.allTimeDownloads || 0), 0);

  return (
    <>
      {/* Package overview table */}
      {packages.length > 0 && (
        <div className="section-card">
          <div className="section-header"><div className="section-title">All Packages</div></div>
          <div style={{ padding: '12px 16px 0' }}>
            <SearchInput value={pkgFilter} onChange={setPkgFilter} placeholder={`Filter ${ecosystem} packages...`} />
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th className="r">Version</th>
                  <th className="r">7d</th>
                  <th className="r">30d</th>
                  <th className="r">All Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredPkgs.map(pkg => (
                  <tr key={pkg.id} className={`clickable ${selectedPackage === pkg.id ? 'selected' : ''}`}
                    onClick={() => setSelectedPackage(pkg.id)}>
                    <td><span className="product-name">{pkg.name}</span></td>
                    <td className="num" style={{ opacity: 0.5 }}>{pkg.version}</td>
                    <td className="num">{formatFullNumber(pkg.last7Downloads)}</td>
                    <td className="num">{formatFullNumber(pkg.last30Downloads)}</td>
                    <td className="num strong">{formatFullNumber(pkg.allTimeDownloads)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td className="num">{formatFullNumber(totals7)}</td>
                  <td className="num">{formatFullNumber(totals30)}</td>
                  <td className="num strong">{formatFullNumber(totalsAll)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Selector */}
      {packages.length > 0 && (
        <Selector label="Package Detail" value={selectedPackage} onChange={setSelectedPackage} items={packages} />
      )}

      {loading ? <Loading /> : pkgData ? (
        <>
          <div className="grid grid-3">
            <MetricCard icon={<Download size={18} color={color} />} iconBg={fillColor}
              label="Period Downloads" value={formatFullNumber(pkgData.summary?.periodDownloads)} sub="Selected range" />
            <MetricCard icon={<Package size={18} color={color} />} iconBg={fillColor}
              label="All-Time Downloads" value={formatFullNumber(pkgData.summary?.allTimeDownloads)} sub="Since tracking began" />
            <MetricCard icon={<Star size={18} color={C.amber} />} iconBg="rgba(245,158,11,0.10)"
              label="Version" value={pkgData.package?.version || '--'} sub={pkgData.package?.name || ''} />
          </div>

          {pkgData.downloads?.length > 0 && (
            <ChartWrap title="Daily Downloads">
              <ResponsiveContainer width="100%" height={350}>
                <AreaChart data={pkgData.downloads}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="date" {...xDateProps} />
                  <YAxis {...axProps} />
                  <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                  <Area type="monotone" dataKey="downloads" stroke={color} fill={fillColor} name="Downloads" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartWrap>
          )}

          {getWeeklyData().length > 1 && (
            <ChartWrap title="Weekly Downloads">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={getWeeklyData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="week" {...xDateProps} />
                  <YAxis {...axProps} />
                  <Tooltip labelFormatter={v => `Week of ${formatDateLabel(v)}`} {...ttProps} />
                  <Bar dataKey="downloads" fill={barColor} name="Downloads" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartWrap>
          )}

          {/* Advanced metrics: version downloads, Python versions, OS breakdown */}
          <div className="grid grid-2-lg">
            {/* npm version downloads */}
            {versionDownloads?.length > 0 && (
              <BreakdownChart
                title="Downloads by Version"
                sub="Last week per-version breakdown"
                data={versionDownloads}
                nameKey="version"
                valueKey="downloads"
                maxItems={12}
              />
            )}

            {/* PyPI Python version breakdown */}
            {pythonVersions?.length > 0 && (
              <BreakdownChart
                title="Downloads by Python Version"
                sub="Aggregated from recent data (mirrors excluded)"
                data={pythonVersions}
                nameKey="python_version"
                valueKey="downloads"
                maxItems={10}
              />
            )}

            {/* PyPI OS breakdown */}
            {systemStats?.length > 0 && (
              <BreakdownChart
                title="Downloads by Operating System"
                sub="Aggregated from recent data (mirrors excluded)"
                data={systemStats}
                nameKey="os_name"
                valueKey="downloads"
                maxItems={8}
              />
            )}
          </div>

          {/* Country downloads from BigQuery */}
          {countryDownloads?.length > 0 && (
            <BreakdownChart
              title="Downloads by Country"
              sub="Last 30 days (source: BigQuery public dataset)"
              data={countryDownloads.map(d => ({
                country: formatCountryName(d.countryCode),
                downloads: d.downloads,
              }))}
              nameKey="country"
              valueKey="downloads"
              maxItems={20}
              color={C.amber}
            />
          )}
        </>
      ) : packages.length === 0 ? (
        <Empty message={`No ${ecosystem} data available yet.`} command={`npm run collect-${ecosystem.toLowerCase()}`} />
      ) : null}
    </>
  );
}

/* ============================================
   Docker Tab
   ============================================ */
function DockerTab({ images, selectedImage, setSelectedImage, dockerData, loading }) {
  const [imgFilter, setImgFilter] = useState('');
  const filteredImages = imgFilter
    ? images.filter(img => (img.full_name || '').toLowerCase().includes(imgFilter.toLowerCase()))
    : images;

  return (
    <>
      {/* Image table */}
      {images.length > 0 && (
        <div className="section-card">
          <div className="section-header"><div className="section-title">Docker Images</div></div>
          {images.length > 3 && (
            <div style={{ padding: '12px 16px 0' }}>
              <SearchInput value={imgFilter} onChange={setImgFilter} placeholder="Filter Docker images..." />
            </div>
          )}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Image</th>
                  <th className="r">Total Pulls</th>
                  <th className="r">Stars</th>
                </tr>
              </thead>
              <tbody>
                {filteredImages.map(img => (
                  <tr key={img.id} className={`clickable ${selectedImage === img.id ? 'selected' : ''}`}
                    onClick={() => setSelectedImage(img.id)}>
                    <td><span className="product-name">{img.full_name}</span></td>
                    <td className="num strong">{formatFullNumber(img.totalPulls)}</td>
                    <td className="num">{img.stars || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Selector */}
      {images.length > 0 && (
        <Selector label="Image Detail" value={selectedImage} onChange={setSelectedImage}
          items={images} nameKey="full_name" />
      )}

      {loading ? <Loading /> : dockerData ? (
        <>
          <div className="grid grid-3">
            <MetricCard icon={<Container size={18} color={C.sky} />} iconBg="rgba(56,189,248,0.10)"
              label="Total Pulls" value={formatFullNumber(dockerData.summary?.totalPulls)} sub="All time" />
            <MetricCard icon={<TrendingUp size={18} color={C.teal} />} iconBg="rgba(0,212,170,0.10)"
              label="Pull Growth" value={`+${formatFullNumber(dockerData.summary?.pullGrowth)}`} sub="During tracked period" />
            <MetricCard icon={<Star size={18} color={C.amber} />} iconBg="rgba(245,158,11,0.10)"
              label="Docker Hub Stars" value={formatFullNumber(dockerData.summary?.stars)} sub={dockerData.image?.full_name || ''} />
          </div>

          {dockerData.pulls?.length > 1 && (
            <ChartWrap title="Cumulative Pulls">
              <ResponsiveContainer width="100%" height={350}>
                <AreaChart data={dockerData.pulls}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="date" {...xDateProps} />
                  <YAxis {...axProps} />
                  <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                  <Area type="monotone" dataKey="totalPulls" stroke={C.sky} fill={C.skyFill} name="Total Pulls" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartWrap>
          )}

          {dockerData.pulls?.length > 2 && (
            <ChartWrap title="Daily Pulls">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={dockerData.pulls.slice(1)}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="date" {...xDateProps} />
                  <YAxis {...axProps} />
                  <Tooltip labelFormatter={formatDateLabel} {...ttProps} />
                  <Bar dataKey="dailyPulls" fill={C.sky} name="Pulls" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartWrap>
          )}

          {/* Docker tag information */}
          {dockerData.tags?.length > 0 && (
            <BreakdownTable
              title="Image Tags"
              columns={[
                { key: 'tag', label: 'Tag' },
                { key: 'full_size', label: 'Size', align: 'right', format: v => formatBytes(v) },
                { key: 'last_updated', label: 'Last Updated', format: v => v ? formatDateLabel(v.split('T')[0]) : '--' },
              ]}
              data={dockerData.tags}
            />
          )}
        </>
      ) : images.length === 0 ? (
        <Empty message="No Docker data available yet." command="npm run collect-docker" />
      ) : null}
    </>
  );
}
