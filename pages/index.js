import { useState, useEffect } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart,
} from 'recharts';
import { GitFork, Star, Eye, GitPullRequest, Calendar, Users, Download, Package, TrendingUp, BarChart3 } from 'lucide-react';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [timeRange, setTimeRange] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // npm state
  const [npmPackages, setNpmPackages] = useState([]);
  const [selectedPackage, setSelectedPackage] = useState(null);
  const [npmData, setNpmData] = useState(null);
  const [npmLoading, setNpmLoading] = useState(false);

  // overview state
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  useEffect(() => {
    fetchRepos();
    fetchNpmPackages();
    fetchOverview();
  }, []);

  useEffect(() => {
    if (selectedRepo) {
      fetchData(selectedRepo, timeRange);
    }
  }, [selectedRepo, timeRange]);

  useEffect(() => {
    if (selectedPackage) {
      fetchNpmData(selectedPackage, timeRange);
    }
  }, [selectedPackage, timeRange]);

  const fetchRepos = async () => {
    try {
      const res = await fetch('/api/repos');
      const data = await res.json();
      setRepos(data);
      if (data.length > 0) {
        setSelectedRepo(data[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch repos:', error);
    }
  };

  const fetchNpmPackages = async () => {
    try {
      const res = await fetch('/api/npm-stats');
      const data = await res.json();
      setNpmPackages(data.packages || []);
      if (data.packages && data.packages.length > 0) {
        setSelectedPackage(data.packages[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch npm packages:', error);
    }
  };

  const fetchOverview = async () => {
    setOverviewLoading(true);
    try {
      const res = await fetch('/api/overview');
      const data = await res.json();
      setOverview(data);
    } catch (error) {
      console.error('Failed to fetch overview:', error);
    } finally {
      setOverviewLoading(false);
    }
  };

  const fetchData = async (repoId, days) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stats?repo_id=${repoId}&days=${days}`);
      const result = await res.json();
      setData(result);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchNpmData = async (packageId, days) => {
    setNpmLoading(true);
    try {
      const res = await fetch(`/api/npm-stats?package_id=${packageId}&days=${days}`);
      const result = await res.json();
      setNpmData(result);
    } catch (error) {
      console.error('Failed to fetch npm data:', error);
    } finally {
      setNpmLoading(false);
    }
  };

  // Merge views and clones by date for the combined chart
  const getCombinedData = () => {
    if (!data) return [];
    const dateMap = {};
    (data.views || []).forEach(v => {
      dateMap[v.date] = { date: v.date, views: v.count, viewsUnique: v.uniques };
    });
    (data.clones || []).forEach(c => {
      if (!dateMap[c.date]) dateMap[c.date] = { date: c.date };
      dateMap[c.date].clones = c.count;
      dateMap[c.date].clonesUnique = c.uniques;
    });
    return Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  };

  // Aggregate data by week for the weekly bar chart
  const getWeeklyData = () => {
    const combined = getCombinedData();
    if (combined.length === 0) return [];

    const weeks = {};
    combined.forEach(d => {
      const date = new Date(d.date + 'T00:00:00Z');
      const day = date.getUTCDay();
      const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(date);
      weekStart.setUTCDate(diff);
      const weekKey = weekStart.toISOString().split('T')[0];

      if (!weeks[weekKey]) {
        weeks[weekKey] = { week: weekKey, views: 0, clones: 0, viewsUnique: 0, clonesUnique: 0 };
      }
      weeks[weekKey].views += d.views || 0;
      weeks[weekKey].clones += d.clones || 0;
      weeks[weekKey].viewsUnique += d.viewsUnique || 0;
      weeks[weekKey].clonesUnique += d.clonesUnique || 0;
    });

    return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week));
  };

  // Aggregate npm downloads by week
  const getNpmWeeklyData = () => {
    if (!npmData || !npmData.downloads) return [];

    const weeks = {};
    npmData.downloads.forEach(d => {
      const date = new Date(d.date + 'T00:00:00Z');
      const day = date.getUTCDay();
      const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(date);
      weekStart.setUTCDate(diff);
      const weekKey = weekStart.toISOString().split('T')[0];

      if (!weeks[weekKey]) {
        weeks[weekKey] = { week: weekKey, downloads: 0 };
      }
      weeks[weekKey].downloads += d.downloads || 0;
    });

    return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week));
  };

  const formatDateLabel = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <h1 className="text-3xl font-bold text-gray-900">Analytics Dashboard</h1>
          <p className="text-gray-600 mt-1">GitHub repos and npm package statistics</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Tab Navigation */}
        <div className="flex space-x-1 bg-white rounded-lg shadow p-1 mb-6">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex-1 py-2.5 px-4 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'overview'
                ? 'bg-gray-900 text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('github')}
            className={`flex-1 py-2.5 px-4 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'github'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            GitHub
          </button>
          <button
            onClick={() => setActiveTab('npm')}
            className={`flex-1 py-2.5 px-4 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'npm'
                ? 'bg-red-600 text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            npm
          </button>
        </div>

        {activeTab === 'overview' ? (
          <OverviewTab overview={overview} loading={overviewLoading} formatDateLabel={formatDateLabel} />
        ) : activeTab === 'github' ? (
          <GitHubTab
            repos={repos}
            selectedRepo={selectedRepo}
            setSelectedRepo={setSelectedRepo}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            data={data}
            loading={loading}
            getCombinedData={getCombinedData}
            getWeeklyData={getWeeklyData}
            formatDateLabel={formatDateLabel}
          />
        ) : (
          <NpmTab
            packages={npmPackages}
            selectedPackage={selectedPackage}
            setSelectedPackage={setSelectedPackage}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            npmData={npmData}
            loading={npmLoading}
            getNpmWeeklyData={getNpmWeeklyData}
            formatDateLabel={formatDateLabel}
          />
        )}
      </main>
    </div>
  );
}

function GitHubTab({ repos, selectedRepo, setSelectedRepo, timeRange, setTimeRange, data, loading, getCombinedData, getWeeklyData, formatDateLabel }) {
  return (
    <>
      {/* Repository and Time Range Selector */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Repository</label>
            <select
              value={selectedRepo || ''}
              onChange={(e) => setSelectedRepo(Number(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {repos.map(repo => (
                <option key={repo.id} value={repo.id}>{repo.full_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Time Range</label>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last year</option>
              <option value="all">All time</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : data ? (
        <>
          {/* Summary Cards */}
          <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <StatCard
              icon={<Eye className="text-blue-600" size={24} />}
              title="Total Views"
              value={(data.summary.totalViews || 0).toLocaleString()}
              subtitle="All time"
            />
            <StatCard
              icon={<GitPullRequest className="text-green-600" size={24} />}
              title="Total Clones"
              value={(data.summary.totalClones || 0).toLocaleString()}
              subtitle="All time"
            />
            <StatCard
              icon={<Users className="text-teal-600" size={24} />}
              title="Unique Visitors"
              value={(data.summary.recentUniqueVisitors || 0).toLocaleString()}
              subtitle="Last 14 days (API)"
            />
            <StatCard
              icon={<Star className="text-yellow-600" size={24} />}
              title="Stars"
              value={(data.summary.latestStars || 0).toLocaleString()}
              subtitle={data.summary.starsGrowth > 0 ? `+${data.summary.starsGrowth} this period` : 'Current'}
            />
            <StatCard
              icon={<GitFork className="text-purple-600" size={24} />}
              title="Forks"
              value={(data.summary.latestForks || 0).toLocaleString()}
              subtitle={data.summary.forksGrowth > 0 ? `+${data.summary.forksGrowth} this period` : 'Current'}
            />
          </div>

          {/* Combined Daily Traffic */}
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Daily Traffic</h2>
            <ResponsiveContainer width="100%" height={350}>
              <ComposedChart data={getCombinedData()}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={12} />
                <YAxis fontSize={12} />
                <Tooltip labelFormatter={formatDateLabel} contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }} />
                <Legend />
                <Area type="monotone" dataKey="views" stroke="#3b82f6" fill="#93c5fd" fillOpacity={0.3} name="Views" />
                <Area type="monotone" dataKey="viewsUnique" stroke="#06b6d4" fill="#67e8f9" fillOpacity={0.2} name="Unique Visitors" />
                <Line type="monotone" dataKey="clones" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Clones" />
                <Line type="monotone" dataKey="clonesUnique" stroke="#ec4899" strokeWidth={2} dot={false} name="Unique Cloners" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Weekly Summary */}
          {getWeeklyData().length > 1 && (
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Weekly Summary</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={getWeeklyData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="week" tickFormatter={formatDateLabel} fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip labelFormatter={(v) => `Week of ${formatDateLabel(v)}`} contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }} />
                  <Legend />
                  <Bar dataKey="views" fill="#3b82f6" name="Views" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="clones" fill="#8b5cf6" name="Clones" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Views vs Clones side by side */}
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Views Over Time</h2>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={data.views}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip labelFormatter={formatDateLabel} />
                  <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} name="Views" />
                  <Line type="monotone" dataKey="uniques" stroke="#06b6d4" strokeWidth={2} dot={{ r: 2 }} name="Unique" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Clones Over Time</h2>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={data.clones}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip labelFormatter={formatDateLabel} />
                  <Line type="monotone" dataKey="count" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 2 }} name="Clones" />
                  <Line type="monotone" dataKey="uniques" stroke="#ec4899" strokeWidth={2} dot={{ r: 2 }} name="Unique" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Referrers Bar Chart */}
          {data.referrers && data.referrers.length > 0 && (
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-1">Top Referrers</h2>
              <p className="text-sm text-gray-500 mb-4">Traffic sources (last 14 days)</p>
              <ResponsiveContainer width="100%" height={Math.max(200, data.referrers.length * 40)}>
                <BarChart data={data.referrers.slice(0, 10)} layout="vertical" margin={{ left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" fontSize={12} />
                  <YAxis type="category" dataKey="referrer" fontSize={12} width={80} />
                  <Tooltip contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }} />
                  <Legend />
                  <Bar dataKey="count" fill="#3b82f6" name="Views" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="uniques" fill="#06b6d4" name="Unique Visitors" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Popular Content */}
          {data.paths && data.paths.length > 0 && (
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-1">Popular Content</h2>
              <p className="text-sm text-gray-500 mb-4">Most visited pages (last 14 days)</p>
              <ResponsiveContainer width="100%" height={Math.max(200, data.paths.length * 40)}>
                <BarChart data={data.paths.slice(0, 10)} layout="vertical" margin={{ left: 120 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" fontSize={12} />
                  <YAxis type="category" dataKey="path" fontSize={11} width={120} />
                  <Tooltip contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }} />
                  <Legend />
                  <Bar dataKey="count" fill="#8b5cf6" name="Views" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="uniques" fill="#a78bfa" name="Unique Visitors" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Metrics Note */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <h3 className="text-sm font-semibold text-blue-900 mb-1">About Unique Visitor Counts</h3>
            <p className="text-sm text-blue-800">
              The "Unique Visitors" count uses GitHub's 14-day API figure, which is properly deduplicated.
              Daily unique counts in charts are per-day (same visitor on different days counted once per day).
            </p>
          </div>
        </>
      ) : (
        <EmptyState message="No GitHub data available yet." command="npm run collect" />
      )}
    </>
  );
}

function NpmTab({ packages, selectedPackage, setSelectedPackage, timeRange, setTimeRange, npmData, loading, getNpmWeeklyData, formatDateLabel }) {
  return (
    <>
      {/* Package Overview Cards */}
      {packages.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">All Packages</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 pr-4 font-medium text-gray-600">Package</th>
                  <th className="text-right py-2 px-4 font-medium text-gray-600">Version</th>
                  <th className="text-right py-2 px-4 font-medium text-gray-600">Last 7d</th>
                  <th className="text-right py-2 px-4 font-medium text-gray-600">Last 30d</th>
                  <th className="text-right py-2 pl-4 font-medium text-gray-600">All Time</th>
                </tr>
              </thead>
              <tbody>
                {[...packages].sort((a, b) => b.allTimeDownloads - a.allTimeDownloads).map(pkg => (
                  <tr
                    key={pkg.id}
                    className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${selectedPackage === pkg.id ? 'bg-red-50' : ''}`}
                    onClick={() => setSelectedPackage(pkg.id)}
                  >
                    <td className="py-2 pr-4 font-medium text-gray-900">{pkg.name}</td>
                    <td className="py-2 px-4 text-right text-gray-500">{pkg.version}</td>
                    <td className="py-2 px-4 text-right">{(pkg.last7Downloads || 0).toLocaleString()}</td>
                    <td className="py-2 px-4 text-right">{(pkg.last30Downloads || 0).toLocaleString()}</td>
                    <td className="py-2 pl-4 text-right font-semibold">{(pkg.allTimeDownloads || 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300">
                  <td className="py-2 pr-4 font-bold text-gray-900">Total</td>
                  <td></td>
                  <td className="py-2 px-4 text-right font-bold">{packages.reduce((s, p) => s + (p.last7Downloads || 0), 0).toLocaleString()}</td>
                  <td className="py-2 px-4 text-right font-bold">{packages.reduce((s, p) => s + (p.last30Downloads || 0), 0).toLocaleString()}</td>
                  <td className="py-2 pl-4 text-right font-bold">{packages.reduce((s, p) => s + (p.allTimeDownloads || 0), 0).toLocaleString()}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Package Selector and Time Range */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Package</label>
            <select
              value={selectedPackage || ''}
              onChange={(e) => setSelectedPackage(Number(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
            >
              {packages.map(pkg => (
                <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Time Range</label>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
            >
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last year</option>
              <option value="all">All time</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : npmData ? (
        <>
          {/* Summary Cards */}
          <div className="grid md:grid-cols-3 gap-4 mb-6">
            <StatCard
              icon={<Download className="text-red-600" size={24} />}
              title="Period Downloads"
              value={(npmData.summary?.periodDownloads || 0).toLocaleString()}
              subtitle={`Selected range`}
            />
            <StatCard
              icon={<Package className="text-orange-600" size={24} />}
              title="All-Time Downloads"
              value={(npmData.summary?.allTimeDownloads || 0).toLocaleString()}
              subtitle="Since tracking began"
            />
            <StatCard
              icon={<Star className="text-yellow-600" size={24} />}
              title="Version"
              value={npmData.package?.version || '--'}
              subtitle={npmData.package?.name || ''}
            />
          </div>

          {/* Daily Downloads Area Chart */}
          {npmData.downloads && npmData.downloads.length > 0 && (
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Daily Downloads</h2>
              <ResponsiveContainer width="100%" height={350}>
                <AreaChart data={npmData.downloads}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip labelFormatter={formatDateLabel} contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }} />
                  <Area type="monotone" dataKey="downloads" stroke="#dc2626" fill="#fca5a5" fillOpacity={0.3} name="Downloads" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Weekly Downloads Bar Chart */}
          {getNpmWeeklyData().length > 1 && (
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Weekly Downloads</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={getNpmWeeklyData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="week" tickFormatter={formatDateLabel} fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip labelFormatter={(v) => `Week of ${formatDateLabel(v)}`} contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }} />
                  <Bar dataKey="downloads" fill="#dc2626" name="Downloads" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      ) : packages.length === 0 ? (
        <EmptyState message="No npm data available yet." command="npm run collect-npm" />
      ) : null}
    </>
  );
}

function OverviewTab({ overview, loading, formatDateLabel }) {
  if (loading) return <LoadingSpinner />;
  if (!overview) return <EmptyState message="No data available yet." command="npm run collect-all" />;

  const { totals, products, weeklyTrend } = overview;

  return (
    <>
      {/* Hero Metrics */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-gradient-to-br from-gray-900 to-gray-700 rounded-lg shadow-lg p-6 text-white">
          <div className="flex items-center mb-2">
            <TrendingUp size={20} className="mr-2 opacity-80" />
            <span className="text-sm font-medium opacity-80">Total Adoption</span>
          </div>
          <p className="text-3xl font-bold">{(totals.combined.totalAdoption || 0).toLocaleString()}</p>
          <p className="text-xs opacity-60 mt-1">Git clones + npm downloads</p>
        </div>
        <div className="bg-gradient-to-br from-blue-600 to-blue-500 rounded-lg shadow-lg p-6 text-white">
          <div className="flex items-center mb-2">
            <Eye size={20} className="mr-2 opacity-80" />
            <span className="text-sm font-medium opacity-80">Total Page Views</span>
          </div>
          <p className="text-3xl font-bold">{(totals.combined.totalPageViews || 0).toLocaleString()}</p>
          <p className="text-xs opacity-60 mt-1">Across {totals.github.repos} repositories</p>
        </div>
        <div className="bg-gradient-to-br from-yellow-500 to-orange-500 rounded-lg shadow-lg p-6 text-white">
          <div className="flex items-center mb-2">
            <Star size={20} className="mr-2 opacity-80" />
            <span className="text-sm font-medium opacity-80">GitHub Stars</span>
          </div>
          <p className="text-3xl font-bold">{(totals.github.totalStars || 0).toLocaleString()}</p>
          <p className="text-xs opacity-60 mt-1">Community endorsements</p>
        </div>
        <div className="bg-gradient-to-br from-red-600 to-red-500 rounded-lg shadow-lg p-6 text-white">
          <div className="flex items-center mb-2">
            <Download size={20} className="mr-2 opacity-80" />
            <span className="text-sm font-medium opacity-80">npm Downloads (30d)</span>
          </div>
          <p className="text-3xl font-bold">{(totals.npm.last30Downloads || 0).toLocaleString()}</p>
          <p className="text-xs opacity-60 mt-1">{totals.npm.packages} packages</p>
        </div>
      </div>

      {/* Product-Level Breakdown */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Product Adoption</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-gray-200">
                <th className="text-left py-3 pr-4 font-semibold text-gray-700">Product</th>
                <th className="text-right py-3 px-3 font-semibold text-gray-700">GitHub Views</th>
                <th className="text-right py-3 px-3 font-semibold text-gray-700">Git Clones</th>
                <th className="text-right py-3 px-3 font-semibold text-gray-700">npm Downloads</th>
                <th className="text-right py-3 px-3 font-semibold text-gray-700">Stars</th>
                <th className="text-right py-3 pl-3 font-semibold text-gray-900">Total Adoption</th>
              </tr>
            </thead>
            <tbody>
              {products.map(product => (
                <tr key={product.name} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-gray-900">{product.name}</div>
                    <div className="text-xs text-gray-500">{product.description}</div>
                  </td>
                  <td className="py-3 px-3 text-right text-gray-600">{(product.github.views || 0).toLocaleString()}</td>
                  <td className="py-3 px-3 text-right text-gray-600">{(product.github.clones || 0).toLocaleString()}</td>
                  <td className="py-3 px-3 text-right text-gray-600">{(product.npm.allTimeDownloads || 0).toLocaleString()}</td>
                  <td className="py-3 px-3 text-right text-gray-600">{product.github.stars || 0}</td>
                  <td className="py-3 pl-3 text-right font-bold text-gray-900">{(product.totalAdoption || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300">
                <td className="py-3 pr-4 font-bold text-gray-900">Total</td>
                <td className="py-3 px-3 text-right font-bold">{(totals.github.totalViews || 0).toLocaleString()}</td>
                <td className="py-3 px-3 text-right font-bold">{(totals.github.totalClones || 0).toLocaleString()}</td>
                <td className="py-3 px-3 text-right font-bold">{(totals.npm.allTimeDownloads || 0).toLocaleString()}</td>
                <td className="py-3 px-3 text-right font-bold">{totals.github.totalStars || 0}</td>
                <td className="py-3 pl-3 text-right font-bold text-gray-900">{(totals.combined.totalAdoption || 0).toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Product Adoption Bar Chart */}
      {products.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Adoption by Product</h2>
          <ResponsiveContainer width="100%" height={Math.max(250, products.length * 50)}>
            <BarChart data={products} layout="vertical" margin={{ left: 100 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis type="number" fontSize={12} />
              <YAxis type="category" dataKey="name" fontSize={12} width={100} />
              <Tooltip contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }} />
              <Legend />
              <Bar dataKey="github.clones" fill="#3b82f6" name="Git Clones" stackId="adoption" radius={[0, 0, 0, 0]} />
              <Bar dataKey="npm.allTimeDownloads" fill="#dc2626" name="npm Downloads" stackId="adoption" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Weekly npm Download Trend */}
      {weeklyTrend && weeklyTrend.length > 1 && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Weekly npm Download Trend (All Packages)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={weeklyTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="week_start" tickFormatter={formatDateLabel} fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip
                labelFormatter={(v) => `Week of ${formatDateLabel(v)}`}
                contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
              />
              <Bar dataKey="downloads" fill="#fca5a5" name="Downloads" radius={[4, 4, 0, 0]} />
              <Line type="monotone" dataKey="downloads" stroke="#dc2626" strokeWidth={2} dot={false} name="Trend" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Ecosystem Summary */}
      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">GitHub Ecosystem</h3>
          <div className="space-y-3">
            <MetricRow label="Public repositories" value={totals.github.repos} />
            <MetricRow label="Total page views" value={totals.github.totalViews} />
            <MetricRow label="Total git clones" value={totals.github.totalClones} />
            <MetricRow label="Total stars" value={totals.github.totalStars} />
            <MetricRow label="Total forks" value={totals.github.totalForks} />
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">npm Ecosystem</h3>
          <div className="space-y-3">
            <MetricRow label="Published packages" value={totals.npm.packages} />
            <MetricRow label="All-time downloads" value={totals.npm.allTimeDownloads} />
            <MetricRow label="Last 30 days" value={totals.npm.last30Downloads} />
            <MetricRow label="Last 7 days" value={totals.npm.last7Downloads} />
          </div>
        </div>
      </div>
    </>
  );
}

function MetricRow({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-600">{label}</span>
      <span className="text-sm font-semibold text-gray-900">{(value || 0).toLocaleString()}</span>
    </div>
  );
}

function StatCard({ icon, title, value, subtitle }) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <div className="flex items-center justify-between mb-2">
        {icon}
      </div>
      <h3 className="text-sm font-medium text-gray-600 mb-1">{title}</h3>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="text-center py-12">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
      <p className="text-gray-600 mt-4">Loading analytics...</p>
    </div>
  );
}

function EmptyState({ message, command }) {
  return (
    <div className="text-center py-12 bg-white rounded-lg shadow">
      <Calendar className="mx-auto text-gray-400" size={48} />
      <p className="text-gray-600 mt-4">{message}</p>
      <code className="block mt-4 text-sm bg-gray-100 px-4 py-2 rounded inline-block">{command}</code>
    </div>
  );
}
