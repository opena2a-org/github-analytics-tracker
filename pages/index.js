import { useState, useEffect } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart,
} from 'recharts';
import { GitFork, Star, Eye, GitPullRequest, Calendar, Users } from 'lucide-react';

export default function Dashboard() {
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [timeRange, setTimeRange] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRepos();
  }, []);

  useEffect(() => {
    if (selectedRepo) {
      fetchData(selectedRepo, timeRange);
    }
  }, [selectedRepo, timeRange]);

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
      // Get ISO week start (Monday)
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

  const formatDateLabel = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <h1 className="text-3xl font-bold text-gray-900">GitHub Analytics Dashboard</h1>
          <p className="text-gray-600 mt-1">Historical repository statistics beyond GitHub's 14-day limit</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
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
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
            <p className="text-gray-600 mt-4">Loading analytics...</p>
          </div>
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

            {/* Combined Daily Traffic (Area Chart) */}
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Daily Traffic</h2>
              <ResponsiveContainer width="100%" height={350}>
                <ComposedChart data={getCombinedData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip
                    labelFormatter={formatDateLabel}
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                  />
                  <Legend />
                  <Area type="monotone" dataKey="views" stroke="#3b82f6" fill="#93c5fd" fillOpacity={0.3} name="Views" />
                  <Area type="monotone" dataKey="viewsUnique" stroke="#06b6d4" fill="#67e8f9" fillOpacity={0.2} name="Unique Visitors" />
                  <Line type="monotone" dataKey="clones" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Clones" />
                  <Line type="monotone" dataKey="clonesUnique" stroke="#ec4899" strokeWidth={2} dot={false} name="Unique Cloners" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Weekly Summary (Bar Chart) */}
            {getWeeklyData().length > 1 && (
              <div className="bg-white rounded-lg shadow p-6 mb-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">Weekly Summary</h2>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={getWeeklyData()}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" tickFormatter={formatDateLabel} fontSize={12} />
                    <YAxis fontSize={12} />
                    <Tooltip
                      labelFormatter={(v) => `Week of ${formatDateLabel(v)}`}
                      contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                    />
                    <Legend />
                    <Bar dataKey="views" fill="#3b82f6" name="Views" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="clones" fill="#8b5cf6" name="Clones" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Views vs Clones side by side */}
            <div className="grid md:grid-cols-2 gap-6 mb-6">
              {/* Views Line Chart */}
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

              {/* Clones Line Chart */}
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

            {/* Popular Content Bar Chart */}
            {data.paths && data.paths.length > 0 && (
              <div className="bg-white rounded-lg shadow p-6 mb-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-1">Popular Content</h2>
                <p className="text-sm text-gray-500 mb-4">Most visited pages (last 14 days)</p>
                <ResponsiveContainer width="100%" height={Math.max(200, data.paths.length * 40)}>
                  <BarChart data={data.paths.slice(0, 10)} layout="vertical" margin={{ left: 120 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis type="number" fontSize={12} />
                    <YAxis type="category" dataKey="path" fontSize={11} width={120} />
                    <Tooltip
                      contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                      formatter={(value, name) => [value, name]}
                    />
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
                The "Unique Visitors" count in the summary card uses GitHub's 14-day API figure,
                which is properly deduplicated. Daily unique counts in the charts are per-day
                (the same visitor on different days is counted once per day). All-time unique
                totals cannot be accurately computed from daily data.
              </p>
            </div>
          </>
        ) : (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <Calendar className="mx-auto text-gray-400" size={48} />
            <p className="text-gray-600 mt-4">No data available yet. Run the collector to start tracking.</p>
            <code className="block mt-4 text-sm bg-gray-100 px-4 py-2 rounded inline-block">npm run collect</code>
          </div>
        )}
      </main>
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
