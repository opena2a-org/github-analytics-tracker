import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart,
} from 'recharts';
import {
  GitFork, Star, Eye, GitPullRequest, Calendar, Users, Download,
  Package, TrendingUp, TrendingDown, BarChart3, Container,
  Github, Box, Layers, ChevronRight,
} from 'lucide-react';

// --- Constants ---
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
  { id: 'overview', label: 'Overview', color: '#1e293b' },
  { id: 'github', label: 'GitHub', color: '#3b82f6' },
  { id: 'npm', label: 'npm', color: '#dc2626' },
  { id: 'pypi', label: 'PyPI', color: '#f59e0b' },
  { id: 'docker', label: 'Docker', color: '#0ea5e9' },
];

// --- Dashboard Root ---
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [timeRange, setTimeRange] = useState('30');

  // GitHub state
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [githubData, setGithubData] = useState(null);
  const [githubLoading, setGithubLoading] = useState(false);

  // npm state
  const [npmPackages, setNpmPackages] = useState([]);
  const [selectedNpmPackage, setSelectedNpmPackage] = useState(null);
  const [npmData, setNpmData] = useState(null);
  const [npmLoading, setNpmLoading] = useState(false);

  // PyPI state
  const [pypiPackages, setPypiPackages] = useState([]);
  const [selectedPypiPackage, setSelectedPypiPackage] = useState(null);
  const [pypiData, setPypiData] = useState(null);
  const [pypiLoading, setPypiLoading] = useState(false);

  // Docker state
  const [dockerImages, setDockerImages] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [dockerData, setDockerData] = useState(null);
  const [dockerLoading, setDockerLoading] = useState(false);

  // Overview state
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  // Sidebar collapsed for mobile
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // --- Data fetching ---
  useEffect(() => {
    fetchRepos();
    fetchNpmPackages();
    fetchPypiPackages();
    fetchDockerImages();
    fetchOverview();
  }, []);

  useEffect(() => {
    if (selectedRepo) fetchGithubData(selectedRepo, timeRange);
  }, [selectedRepo, timeRange]);

  useEffect(() => {
    if (selectedNpmPackage) fetchNpmData(selectedNpmPackage, timeRange);
  }, [selectedNpmPackage, timeRange]);

  useEffect(() => {
    if (selectedPypiPackage) fetchPypiData(selectedPypiPackage, timeRange);
  }, [selectedPypiPackage, timeRange]);

  useEffect(() => {
    if (selectedImage) fetchDockerData(selectedImage, timeRange);
  }, [selectedImage, timeRange]);

  const fetchRepos = async () => {
    try {
      const res = await fetch('/api/repos');
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setRepos(data);
      if (data.length > 0) setSelectedRepo(data[0].id);
    } catch (e) { /* silent */ }
  };

  const fetchNpmPackages = async () => {
    try {
      const res = await fetch('/api/npm-stats');
      if (!res.ok) return;
      const data = await res.json();
      setNpmPackages(data.packages || []);
      if (data.packages?.length > 0) setSelectedNpmPackage(data.packages[0].id);
    } catch (e) { /* silent */ }
  };

  const fetchPypiPackages = async () => {
    try {
      const res = await fetch('/api/pypi-stats');
      if (!res.ok) return;
      const data = await res.json();
      setPypiPackages(data.packages || []);
      if (data.packages?.length > 0) setSelectedPypiPackage(data.packages[0].id);
    } catch (e) { /* silent */ }
  };

  const fetchDockerImages = async () => {
    try {
      const res = await fetch('/api/docker-stats');
      if (!res.ok) return;
      const data = await res.json();
      setDockerImages(data.images || []);
      if (data.images?.length > 0) setSelectedImage(data.images[0].id);
    } catch (e) { /* silent */ }
  };

  const fetchOverview = async () => {
    setOverviewLoading(true);
    try {
      const res = await fetch('/api/overview');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.totals) setOverview(data);
    } catch (e) { /* silent */ }
    finally { setOverviewLoading(false); }
  };

  const fetchGithubData = async (repoId, days) => {
    setGithubLoading(true);
    try {
      const res = await fetch(`/api/stats?repo_id=${repoId}&days=${days}`);
      if (!res.ok) return;
      setGithubData(await res.json());
    } catch (e) { /* silent */ }
    finally { setGithubLoading(false); }
  };

  const fetchNpmData = async (pkgId, days) => {
    setNpmLoading(true);
    try {
      const res = await fetch(`/api/npm-stats?package_id=${pkgId}&days=${days}`);
      if (!res.ok) return;
      setNpmData(await res.json());
    } catch (e) { /* silent */ }
    finally { setNpmLoading(false); }
  };

  const fetchPypiData = async (pkgId, days) => {
    setPypiLoading(true);
    try {
      const res = await fetch(`/api/pypi-stats?package_id=${pkgId}&days=${days}`);
      if (!res.ok) return;
      setPypiData(await res.json());
    } catch (e) { /* silent */ }
    finally { setPypiLoading(false); }
  };

  const fetchDockerData = async (imgId, days) => {
    setDockerLoading(true);
    try {
      const res = await fetch(`/api/docker-stats?image_id=${imgId}&days=${days}`);
      if (!res.ok) return;
      setDockerData(await res.json());
    } catch (e) { /* silent */ }
    finally { setDockerLoading(false); }
  };

  // --- Helpers ---
  const getCombinedGithubData = () => {
    if (!githubData) return [];
    const dateMap = {};
    (githubData.views || []).forEach(v => {
      dateMap[v.date] = { date: v.date, views: v.count, viewsUnique: v.uniques };
    });
    (githubData.clones || []).forEach(c => {
      if (!dateMap[c.date]) dateMap[c.date] = { date: c.date };
      dateMap[c.date].clones = c.count;
      dateMap[c.date].clonesUnique = c.uniques;
    });
    return Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  };

  const getWeeklyGithubData = () => {
    const combined = getCombinedGithubData();
    if (combined.length === 0) return [];
    const weeks = {};
    combined.forEach(d => {
      const date = new Date(d.date + 'T00:00:00Z');
      const day = date.getUTCDay();
      const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
      const ws = new Date(date);
      ws.setUTCDate(diff);
      const weekKey = ws.toISOString().split('T')[0];
      if (!weeks[weekKey]) weeks[weekKey] = { week: weekKey, views: 0, clones: 0 };
      weeks[weekKey].views += d.views || 0;
      weeks[weekKey].clones += d.clones || 0;
    });
    return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week));
  };

  const getWeeklyDownloadData = (downloads) => {
    if (!downloads || downloads.length === 0) return [];
    const weeks = {};
    downloads.forEach(d => {
      const date = new Date(d.date + 'T00:00:00Z');
      const day = date.getUTCDay();
      const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
      const ws = new Date(date);
      ws.setUTCDate(diff);
      const weekKey = ws.toISOString().split('T')[0];
      if (!weeks[weekKey]) weeks[weekKey] = { week: weekKey, downloads: 0 };
      weeks[weekKey].downloads += d.downloads || 0;
    });
    return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week));
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 text-white transform transition-transform duration-200 lg:translate-x-0 lg:static lg:inset-auto ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-700">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center">
            <BarChart3 size={18} />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">Analytics</h1>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest">OpenA2A</p>
          </div>
        </div>
        <nav className="mt-4 px-3 space-y-1">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-slate-800 text-white shadow-inner'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: activeTab === tab.id ? tab.color : 'transparent', border: `1.5px solid ${tab.color}` }} />
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-slate-700">
          <p className="text-[10px] text-slate-500">
            {overview?.lastUpdated ? `Updated ${formatDateLabel(overview.lastUpdated.split('T')[0])}` : ''}
          </p>
        </div>
      </aside>

      {/* Overlay for mobile sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Top bar for mobile */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-slate-200">
          <button onClick={() => setSidebarOpen(true)} className="p-1.5 rounded-lg hover:bg-slate-100">
            <Layers size={20} className="text-slate-600" />
          </button>
          <h2 className="text-sm font-semibold text-slate-900">
            {TABS.find(t => t.id === activeTab)?.label}
          </h2>
        </div>

        {/* Time Range Filter - sticky */}
        <div className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-slate-200 px-6 py-3">
          <div className="flex items-center justify-between">
            <h2 className="hidden lg:block text-lg font-semibold text-slate-900">
              {TABS.find(t => t.id === activeTab)?.label}
            </h2>
            <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
              {TIME_RANGES.map(tr => (
                <button
                  key={tr.value}
                  onClick={() => setTimeRange(tr.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    timeRange === tr.value
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {tr.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        <main className="p-6 max-w-[1400px] mx-auto">
          {activeTab === 'overview' && (
            <OverviewTab overview={overview} loading={overviewLoading} />
          )}
          {activeTab === 'github' && (
            <GitHubTab
              repos={repos}
              selectedRepo={selectedRepo}
              setSelectedRepo={setSelectedRepo}
              data={githubData}
              loading={githubLoading}
              getCombinedData={getCombinedGithubData}
              getWeeklyData={getWeeklyGithubData}
            />
          )}
          {activeTab === 'npm' && (
            <NpmTab
              packages={npmPackages}
              selectedPackage={selectedNpmPackage}
              setSelectedPackage={setSelectedNpmPackage}
              npmData={npmData}
              loading={npmLoading}
              getWeeklyData={() => getWeeklyDownloadData(npmData?.downloads)}
            />
          )}
          {activeTab === 'pypi' && (
            <PyPITab
              packages={pypiPackages}
              selectedPackage={selectedPypiPackage}
              setSelectedPackage={setSelectedPypiPackage}
              pypiData={pypiData}
              loading={pypiLoading}
              getWeeklyData={() => getWeeklyDownloadData(pypiData?.downloads)}
            />
          )}
          {activeTab === 'docker' && (
            <DockerTab
              images={dockerImages}
              selectedImage={selectedImage}
              setSelectedImage={setSelectedImage}
              dockerData={dockerData}
              loading={dockerLoading}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// --- Shared Utilities ---
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

function calcGrowth(current, previous) {
  if (!previous || previous === 0) return null;
  return ((current - previous) / previous * 100).toFixed(1);
}

// --- Shared Components ---
function GrowthBadge({ value }) {
  if (value == null) return null;
  const num = parseFloat(value);
  const isPositive = num >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${isPositive ? 'text-emerald-600' : 'text-red-500'}`}>
      {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {isPositive ? '+' : ''}{value}%
    </span>
  );
}

function StatCard({ icon, title, value, subtitle, growth, accentColor }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <div className={`p-2 rounded-lg`} style={{ backgroundColor: accentColor ? `${accentColor}15` : '#f1f5f9' }}>
          {icon}
        </div>
        {growth != null && <GrowthBadge value={growth} />}
      </div>
      <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide">{title}</h3>
      <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
      {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
    </div>
  );
}

function HeroCard({ icon, title, value, subtitle, gradient }) {
  return (
    <div className={`rounded-xl p-6 text-white shadow-lg ${gradient}`}>
      <div className="flex items-center gap-2 mb-2 opacity-80">
        {icon}
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="text-3xl font-bold">{value}</p>
      <p className="text-xs opacity-60 mt-1">{subtitle}</p>
    </div>
  );
}

function ChartCard({ title, children, subtitle }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

const tooltipStyle = { borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '12px' };

function LoadingSpinner() {
  return (
    <div className="text-center py-16">
      <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-200 border-t-slate-900 mx-auto" />
      <p className="text-sm text-slate-500 mt-4">Loading analytics...</p>
    </div>
  );
}

function EmptyState({ message, command }) {
  return (
    <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
      <Calendar className="mx-auto text-slate-300" size={40} />
      <p className="text-sm text-slate-500 mt-4">{message}</p>
      <code className="block mt-3 text-xs bg-slate-100 text-slate-600 px-4 py-2 rounded-lg inline-block font-mono">{command}</code>
    </div>
  );
}

function MetricRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-900">{formatFullNumber(value)}</span>
    </div>
  );
}

// --- Overview Tab ---
function OverviewTab({ overview, loading }) {
  if (loading) return <LoadingSpinner />;
  if (!overview) return <EmptyState message="No data available yet." command="npm run collect-all" />;

  const { totals, products = [], weeklyTrend = [] } = overview;

  return (
    <div className="space-y-6">
      {/* Hero KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <HeroCard
          icon={<TrendingUp size={18} />}
          title="Total Adoption"
          value={formatFullNumber(totals.combined.totalAdoption)}
          subtitle="Clones + npm + PyPI + Docker"
          gradient="bg-gradient-to-br from-slate-900 to-slate-700"
        />
        <HeroCard
          icon={<Eye size={18} />}
          title="Page Views"
          value={formatFullNumber(totals.combined.totalPageViews)}
          subtitle={`${totals.github.repos} repositories`}
          gradient="bg-gradient-to-br from-blue-600 to-blue-500"
        />
        <HeroCard
          icon={<Star size={18} />}
          title="GitHub Stars"
          value={formatFullNumber(totals.github.totalStars)}
          subtitle="Community endorsements"
          gradient="bg-gradient-to-br from-amber-500 to-orange-500"
        />
        <HeroCard
          icon={<Download size={18} />}
          title="npm (30d)"
          value={formatFullNumber(totals.npm.last30Downloads)}
          subtitle={`${totals.npm.packages} packages`}
          gradient="bg-gradient-to-br from-red-600 to-red-500"
        />
        <HeroCard
          icon={<Package size={18} />}
          title="PyPI (30d)"
          value={formatFullNumber(totals.pypi?.last30Downloads || 0)}
          subtitle={`${totals.pypi?.packages || 0} packages`}
          gradient="bg-gradient-to-br from-amber-600 to-yellow-500"
        />
      </div>

      {/* Product Adoption Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h3 className="text-base font-semibold text-slate-900">Product Adoption</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left py-3 px-6 font-semibold text-slate-600 text-xs uppercase tracking-wide">Product</th>
                <th className="text-right py-3 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">Views</th>
                <th className="text-right py-3 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">Clones</th>
                <th className="text-right py-3 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">npm</th>
                <th className="text-right py-3 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">PyPI</th>
                <th className="text-right py-3 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">Docker</th>
                <th className="text-right py-3 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">Stars</th>
                <th className="text-right py-3 px-6 font-semibold text-slate-900 text-xs uppercase tracking-wide">Total</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => (
                <tr key={p.name} className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${i % 2 ? 'bg-slate-50/50' : ''}`}>
                  <td className="py-3 px-6">
                    <div className="font-medium text-slate-900">{p.name}</div>
                    <div className="text-xs text-slate-400">{p.description}</div>
                  </td>
                  <td className="py-3 px-4 text-right text-slate-600 tabular-nums">{formatFullNumber(p.github.views)}</td>
                  <td className="py-3 px-4 text-right text-slate-600 tabular-nums">{formatFullNumber(p.github.clones)}</td>
                  <td className="py-3 px-4 text-right text-slate-600 tabular-nums">{formatFullNumber(p.npm.allTimeDownloads)}</td>
                  <td className="py-3 px-4 text-right text-slate-600 tabular-nums">{formatFullNumber(p.pypi?.allTimeDownloads || 0)}</td>
                  <td className="py-3 px-4 text-right text-slate-600 tabular-nums">{formatFullNumber(p.docker?.totalPulls || 0)}</td>
                  <td className="py-3 px-4 text-right text-slate-600 tabular-nums">{p.github.stars || 0}</td>
                  <td className="py-3 px-6 text-right font-bold text-slate-900 tabular-nums">{formatFullNumber(p.totalAdoption)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 bg-slate-50">
                <td className="py-3 px-6 font-bold text-slate-900">Total</td>
                <td className="py-3 px-4 text-right font-bold tabular-nums">{formatFullNumber(totals.github.totalViews)}</td>
                <td className="py-3 px-4 text-right font-bold tabular-nums">{formatFullNumber(totals.github.totalClones)}</td>
                <td className="py-3 px-4 text-right font-bold tabular-nums">{formatFullNumber(totals.npm.allTimeDownloads)}</td>
                <td className="py-3 px-4 text-right font-bold tabular-nums">{formatFullNumber(totals.pypi?.allTimeDownloads || 0)}</td>
                <td className="py-3 px-4 text-right font-bold tabular-nums">{formatFullNumber(totals.docker?.totalPulls || 0)}</td>
                <td className="py-3 px-4 text-right font-bold tabular-nums">{totals.github.totalStars || 0}</td>
                <td className="py-3 px-6 text-right font-bold text-slate-900 tabular-nums">{formatFullNumber(totals.combined.totalAdoption)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Stacked Bar + Weekly Trend side by side */}
      <div className="grid lg:grid-cols-2 gap-6">
        {products.length > 0 && (
          <ChartCard title="Adoption by Product">
            <ResponsiveContainer width="100%" height={Math.max(250, products.length * 50)}>
              <BarChart data={products} layout="vertical" margin={{ left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" fontSize={11} tick={{ fill: '#64748b' }} />
                <YAxis type="category" dataKey="name" fontSize={11} width={100} tick={{ fill: '#334155' }} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Bar dataKey="github.clones" fill="#3b82f6" name="Git Clones" stackId="a" />
                <Bar dataKey="npm.allTimeDownloads" fill="#dc2626" name="npm" stackId="a" />
                <Bar dataKey="pypi.allTimeDownloads" fill="#f59e0b" name="PyPI" stackId="a" />
                <Bar dataKey="docker.totalPulls" fill="#0ea5e9" name="Docker" stackId="a" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {weeklyTrend.length > 1 && (
          <ChartCard title="Weekly Download Trend" subtitle="npm + PyPI combined">
            <ResponsiveContainer width="100%" height={Math.max(250, products.length * 50)}>
              <ComposedChart data={weeklyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="week_start" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                <Tooltip labelFormatter={v => `Week of ${formatDateLabel(v)}`} contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Bar dataKey="npm" fill="#fca5a5" name="npm" stackId="dl" radius={[0, 0, 0, 0]} />
                <Bar dataKey="pypi" fill="#fcd34d" name="PyPI" stackId="dl" radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="downloads" stroke="#1e293b" strokeWidth={2} dot={false} name="Total" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {/* Ecosystem Cards */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded bg-blue-100 flex items-center justify-center">
              <Github size={14} className="text-blue-600" />
            </div>
            <h4 className="text-sm font-semibold text-slate-900">GitHub</h4>
          </div>
          <div className="space-y-1">
            <MetricRow label="Repositories" value={totals.github.repos} />
            <MetricRow label="Page views" value={totals.github.totalViews} />
            <MetricRow label="Git clones" value={totals.github.totalClones} />
            <MetricRow label="Stars" value={totals.github.totalStars} />
            <MetricRow label="Forks" value={totals.github.totalForks} />
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded bg-red-100 flex items-center justify-center">
              <Box size={14} className="text-red-600" />
            </div>
            <h4 className="text-sm font-semibold text-slate-900">npm</h4>
          </div>
          <div className="space-y-1">
            <MetricRow label="Packages" value={totals.npm.packages} />
            <MetricRow label="All-time downloads" value={totals.npm.allTimeDownloads} />
            <MetricRow label="Last 30d" value={totals.npm.last30Downloads} />
            <MetricRow label="Last 7d" value={totals.npm.last7Downloads} />
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded bg-amber-100 flex items-center justify-center">
              <Package size={14} className="text-amber-600" />
            </div>
            <h4 className="text-sm font-semibold text-slate-900">PyPI</h4>
          </div>
          <div className="space-y-1">
            <MetricRow label="Packages" value={totals.pypi?.packages || 0} />
            <MetricRow label="All-time downloads" value={totals.pypi?.allTimeDownloads || 0} />
            <MetricRow label="Last 30d" value={totals.pypi?.last30Downloads || 0} />
            <MetricRow label="Last 7d" value={totals.pypi?.last7Downloads || 0} />
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded bg-sky-100 flex items-center justify-center">
              <Container size={14} className="text-sky-600" />
            </div>
            <h4 className="text-sm font-semibold text-slate-900">Docker</h4>
          </div>
          <div className="space-y-1">
            <MetricRow label="Images" value={totals.docker?.images || 0} />
            <MetricRow label="Total pulls" value={totals.docker?.totalPulls || 0} />
          </div>
        </div>
      </div>
    </div>
  );
}

// --- GitHub Tab ---
function GitHubTab({ repos, selectedRepo, setSelectedRepo, data, loading, getCombinedData, getWeeklyData }) {
  return (
    <div className="space-y-6">
      {/* Selector */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Repository</label>
        <select
          value={selectedRepo || ''}
          onChange={e => setSelectedRepo(Number(e.target.value))}
          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          {repos.map(r => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </select>
      </div>

      {loading ? <LoadingSpinner /> : data ? (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard icon={<Eye size={20} className="text-blue-600" />} title="Total Views" value={formatFullNumber(data.summary.totalViews)} subtitle="All time" accentColor="#3b82f6" />
            <StatCard icon={<GitPullRequest size={20} className="text-emerald-600" />} title="Total Clones" value={formatFullNumber(data.summary.totalClones)} subtitle="All time" accentColor="#10b981" />
            <StatCard icon={<Users size={20} className="text-cyan-600" />} title="Unique Visitors" value={formatFullNumber(data.summary.recentUniqueVisitors)} subtitle="Last 14d (API)" accentColor="#06b6d4" />
            <StatCard icon={<Star size={20} className="text-amber-500" />} title="Stars" value={formatFullNumber(data.summary.latestStars)} subtitle={data.summary.starsGrowth > 0 ? `+${data.summary.starsGrowth} this period` : 'Current'} accentColor="#f59e0b" />
            <StatCard icon={<GitFork size={20} className="text-purple-600" />} title="Forks" value={formatFullNumber(data.summary.latestForks)} subtitle={data.summary.forksGrowth > 0 ? `+${data.summary.forksGrowth} this period` : 'Current'} accentColor="#8b5cf6" />
          </div>

          {/* Daily Traffic */}
          <ChartCard title="Daily Traffic">
            <ResponsiveContainer width="100%" height={350}>
              <ComposedChart data={getCombinedData()}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                <Tooltip labelFormatter={formatDateLabel} contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Area type="monotone" dataKey="views" stroke="#3b82f6" fill="#93c5fd" fillOpacity={0.3} name="Views" />
                <Area type="monotone" dataKey="viewsUnique" stroke="#06b6d4" fill="#67e8f9" fillOpacity={0.2} name="Unique Visitors" />
                <Line type="monotone" dataKey="clones" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Clones" />
                <Line type="monotone" dataKey="clonesUnique" stroke="#ec4899" strokeWidth={2} dot={false} name="Unique Cloners" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Weekly Summary */}
          {getWeeklyData().length > 1 && (
            <ChartCard title="Weekly Summary">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={getWeeklyData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="week" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={v => `Week of ${formatDateLabel(v)}`} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="views" fill="#3b82f6" name="Views" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="clones" fill="#8b5cf6" name="Clones" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Side-by-side */}
          <div className="grid lg:grid-cols-2 gap-6">
            <ChartCard title="Views Over Time">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={data.views}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={formatDateLabel} contentStyle={tooltipStyle} />
                  <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} name="Views" />
                  <Line type="monotone" dataKey="uniques" stroke="#06b6d4" strokeWidth={2} dot={{ r: 2 }} name="Unique" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Clones Over Time">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={data.clones}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={formatDateLabel} contentStyle={tooltipStyle} />
                  <Line type="monotone" dataKey="count" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 2 }} name="Clones" />
                  <Line type="monotone" dataKey="uniques" stroke="#ec4899" strokeWidth={2} dot={{ r: 2 }} name="Unique" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* Referrers */}
          {data.referrers?.length > 0 && (
            <ChartCard title="Top Referrers" subtitle="Traffic sources (last 14 days)">
              <ResponsiveContainer width="100%" height={Math.max(200, data.referrers.length * 40)}>
                <BarChart data={data.referrers.slice(0, 10)} layout="vertical" margin={{ left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" fontSize={11} />
                  <YAxis type="category" dataKey="referrer" fontSize={11} width={80} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="count" fill="#3b82f6" name="Views" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="uniques" fill="#06b6d4" name="Unique" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Popular Content */}
          {data.paths?.length > 0 && (
            <ChartCard title="Popular Content" subtitle="Most visited pages (last 14 days)">
              <ResponsiveContainer width="100%" height={Math.max(200, data.paths.length * 40)}>
                <BarChart data={data.paths.slice(0, 10)} layout="vertical" margin={{ left: 120 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" fontSize={11} />
                  <YAxis type="category" dataKey="path" fontSize={11} width={120} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="count" fill="#8b5cf6" name="Views" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="uniques" fill="#a78bfa" name="Unique" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </>
      ) : (
        <EmptyState message="No GitHub data available yet." command="npm run collect" />
      )}
    </div>
  );
}

// --- npm Tab ---
function NpmTab({ packages, selectedPackage, setSelectedPackage, npmData, loading, getWeeklyData }) {
  return (
    <div className="space-y-6">
      {/* Package Table */}
      {packages.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h3 className="text-base font-semibold text-slate-900">All Packages</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left py-2.5 px-6 font-semibold text-slate-600 text-xs uppercase tracking-wide">Package</th>
                  <th className="text-right py-2.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">Version</th>
                  <th className="text-right py-2.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">7d</th>
                  <th className="text-right py-2.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">30d</th>
                  <th className="text-right py-2.5 px-6 font-semibold text-slate-600 text-xs uppercase tracking-wide">All Time</th>
                </tr>
              </thead>
              <tbody>
                {[...packages].sort((a, b) => b.allTimeDownloads - a.allTimeDownloads).map(pkg => (
                  <tr
                    key={pkg.id}
                    className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 transition-colors ${selectedPackage === pkg.id ? 'bg-red-50/50 border-l-2 border-l-red-500' : ''}`}
                    onClick={() => setSelectedPackage(pkg.id)}
                  >
                    <td className="py-2.5 px-6 font-medium text-slate-900">{pkg.name}</td>
                    <td className="py-2.5 px-4 text-right text-slate-400 font-mono text-xs">{pkg.version}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{formatFullNumber(pkg.last7Downloads)}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{formatFullNumber(pkg.last30Downloads)}</td>
                    <td className="py-2.5 px-6 text-right font-semibold tabular-nums">{formatFullNumber(pkg.allTimeDownloads)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50">
                  <td className="py-2.5 px-6 font-bold text-slate-900">Total</td>
                  <td />
                  <td className="py-2.5 px-4 text-right font-bold tabular-nums">{formatFullNumber(packages.reduce((s, p) => s + (p.last7Downloads || 0), 0))}</td>
                  <td className="py-2.5 px-4 text-right font-bold tabular-nums">{formatFullNumber(packages.reduce((s, p) => s + (p.last30Downloads || 0), 0))}</td>
                  <td className="py-2.5 px-6 text-right font-bold tabular-nums">{formatFullNumber(packages.reduce((s, p) => s + (p.allTimeDownloads || 0), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Package Selector */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Package Detail</label>
        <select
          value={selectedPackage || ''}
          onChange={e => setSelectedPackage(Number(e.target.value))}
          className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent"
        >
          {packages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {loading ? <LoadingSpinner /> : npmData ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard icon={<Download size={20} className="text-red-600" />} title="Period Downloads" value={formatFullNumber(npmData.summary?.periodDownloads)} subtitle="Selected range" accentColor="#dc2626" />
            <StatCard icon={<Package size={20} className="text-orange-500" />} title="All-Time Downloads" value={formatFullNumber(npmData.summary?.allTimeDownloads)} subtitle="Since tracking began" accentColor="#f97316" />
            <StatCard icon={<Star size={20} className="text-amber-500" />} title="Version" value={npmData.package?.version || '--'} subtitle={npmData.package?.name || ''} accentColor="#f59e0b" />
          </div>

          {npmData.downloads?.length > 0 && (
            <ChartCard title="Daily Downloads">
              <ResponsiveContainer width="100%" height={350}>
                <AreaChart data={npmData.downloads}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={formatDateLabel} contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="downloads" stroke="#dc2626" fill="#fca5a5" fillOpacity={0.3} name="Downloads" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {getWeeklyData().length > 1 && (
            <ChartCard title="Weekly Downloads">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={getWeeklyData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="week" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={v => `Week of ${formatDateLabel(v)}`} contentStyle={tooltipStyle} />
                  <Bar dataKey="downloads" fill="#dc2626" name="Downloads" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </>
      ) : packages.length === 0 ? (
        <EmptyState message="No npm data available yet." command="npm run collect-npm" />
      ) : null}
    </div>
  );
}

// --- PyPI Tab ---
function PyPITab({ packages, selectedPackage, setSelectedPackage, pypiData, loading, getWeeklyData }) {
  return (
    <div className="space-y-6">
      {/* Package Table */}
      {packages.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h3 className="text-base font-semibold text-slate-900">All Packages</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left py-2.5 px-6 font-semibold text-slate-600 text-xs uppercase tracking-wide">Package</th>
                  <th className="text-right py-2.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">Version</th>
                  <th className="text-right py-2.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">7d</th>
                  <th className="text-right py-2.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">30d</th>
                  <th className="text-right py-2.5 px-6 font-semibold text-slate-600 text-xs uppercase tracking-wide">All Time</th>
                </tr>
              </thead>
              <tbody>
                {[...packages].sort((a, b) => b.allTimeDownloads - a.allTimeDownloads).map(pkg => (
                  <tr
                    key={pkg.id}
                    className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 transition-colors ${selectedPackage === pkg.id ? 'bg-amber-50/50 border-l-2 border-l-amber-500' : ''}`}
                    onClick={() => setSelectedPackage(pkg.id)}
                  >
                    <td className="py-2.5 px-6 font-medium text-slate-900">{pkg.name}</td>
                    <td className="py-2.5 px-4 text-right text-slate-400 font-mono text-xs">{pkg.version}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{formatFullNumber(pkg.last7Downloads)}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{formatFullNumber(pkg.last30Downloads)}</td>
                    <td className="py-2.5 px-6 text-right font-semibold tabular-nums">{formatFullNumber(pkg.allTimeDownloads)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50">
                  <td className="py-2.5 px-6 font-bold text-slate-900">Total</td>
                  <td />
                  <td className="py-2.5 px-4 text-right font-bold tabular-nums">{formatFullNumber(packages.reduce((s, p) => s + (p.last7Downloads || 0), 0))}</td>
                  <td className="py-2.5 px-4 text-right font-bold tabular-nums">{formatFullNumber(packages.reduce((s, p) => s + (p.last30Downloads || 0), 0))}</td>
                  <td className="py-2.5 px-6 text-right font-bold tabular-nums">{formatFullNumber(packages.reduce((s, p) => s + (p.allTimeDownloads || 0), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Package Selector */}
      {packages.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Package Detail</label>
          <select
            value={selectedPackage || ''}
            onChange={e => setSelectedPackage(Number(e.target.value))}
            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          >
            {packages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      {loading ? <LoadingSpinner /> : pypiData ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard icon={<Download size={20} className="text-amber-600" />} title="Period Downloads" value={formatFullNumber(pypiData.summary?.periodDownloads)} subtitle="Selected range" accentColor="#f59e0b" />
            <StatCard icon={<Package size={20} className="text-orange-500" />} title="All-Time Downloads" value={formatFullNumber(pypiData.summary?.allTimeDownloads)} subtitle="Since tracking began" accentColor="#f97316" />
            <StatCard icon={<Star size={20} className="text-amber-500" />} title="Version" value={pypiData.package?.version || '--'} subtitle={pypiData.package?.name || ''} accentColor="#eab308" />
          </div>

          {pypiData.downloads?.length > 0 && (
            <ChartCard title="Daily Downloads">
              <ResponsiveContainer width="100%" height={350}>
                <AreaChart data={pypiData.downloads}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={formatDateLabel} contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="downloads" stroke="#f59e0b" fill="#fcd34d" fillOpacity={0.3} name="Downloads" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {getWeeklyData().length > 1 && (
            <ChartCard title="Weekly Downloads">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={getWeeklyData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="week" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={v => `Week of ${formatDateLabel(v)}`} contentStyle={tooltipStyle} />
                  <Bar dataKey="downloads" fill="#f59e0b" name="Downloads" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </>
      ) : packages.length === 0 ? (
        <EmptyState message="No PyPI data available yet." command="npm run collect-pypi" />
      ) : null}
    </div>
  );
}

// --- Docker Tab ---
function DockerTab({ images, selectedImage, setSelectedImage, dockerData, loading }) {
  return (
    <div className="space-y-6">
      {/* Image Table */}
      {images.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h3 className="text-base font-semibold text-slate-900">Docker Images</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left py-2.5 px-6 font-semibold text-slate-600 text-xs uppercase tracking-wide">Image</th>
                  <th className="text-right py-2.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">Total Pulls</th>
                  <th className="text-right py-2.5 px-6 font-semibold text-slate-600 text-xs uppercase tracking-wide">Stars</th>
                </tr>
              </thead>
              <tbody>
                {images.map(img => (
                  <tr
                    key={img.id}
                    className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 transition-colors ${selectedImage === img.id ? 'bg-sky-50/50 border-l-2 border-l-sky-500' : ''}`}
                    onClick={() => setSelectedImage(img.id)}
                  >
                    <td className="py-2.5 px-6 font-medium text-slate-900">{img.full_name}</td>
                    <td className="py-2.5 px-4 text-right font-semibold tabular-nums">{formatFullNumber(img.totalPulls)}</td>
                    <td className="py-2.5 px-6 text-right tabular-nums">{img.stars || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Image Selector */}
      {images.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Image Detail</label>
          <select
            value={selectedImage || ''}
            onChange={e => setSelectedImage(Number(e.target.value))}
            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-500 focus:border-transparent"
          >
            {images.map(img => <option key={img.id} value={img.id}>{img.full_name}</option>)}
          </select>
        </div>
      )}

      {loading ? <LoadingSpinner /> : dockerData ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard icon={<Container size={20} className="text-sky-600" />} title="Total Pulls" value={formatFullNumber(dockerData.summary?.totalPulls)} subtitle="All time" accentColor="#0ea5e9" />
            <StatCard icon={<TrendingUp size={20} className="text-emerald-600" />} title="Pull Growth" value={`+${formatFullNumber(dockerData.summary?.pullGrowth)}`} subtitle="During tracked period" accentColor="#10b981" />
            <StatCard icon={<Star size={20} className="text-amber-500" />} title="Docker Hub Stars" value={formatFullNumber(dockerData.summary?.stars)} subtitle={dockerData.image?.full_name || ''} accentColor="#f59e0b" />
          </div>

          {dockerData.pulls?.length > 1 && (
            <ChartCard title="Cumulative Pulls">
              <ResponsiveContainer width="100%" height={350}>
                <AreaChart data={dockerData.pulls}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={formatDateLabel} contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="totalPulls" stroke="#0ea5e9" fill="#7dd3fc" fillOpacity={0.3} name="Total Pulls" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {dockerData.pulls?.length > 2 && (
            <ChartCard title="Daily Pulls">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={dockerData.pulls.slice(1)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} tick={{ fill: '#64748b' }} />
                  <YAxis fontSize={11} tick={{ fill: '#64748b' }} />
                  <Tooltip labelFormatter={formatDateLabel} contentStyle={tooltipStyle} />
                  <Bar dataKey="dailyPulls" fill="#0ea5e9" name="Pulls" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </>
      ) : images.length === 0 ? (
        <EmptyState message="No Docker data available yet." command="npm run collect-docker" />
      ) : null}
    </div>
  );
}
