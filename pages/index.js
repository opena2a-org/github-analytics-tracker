import { useState, useEffect } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { TrendingUp, GitFork, Star, Eye, GitPullRequest, Calendar } from 'lucide-react';

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
      const data = await res.json();
      setData(data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const currentRepo = repos.find(r => r.id === selectedRepo);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <h1 className="text-3xl font-bold text-gray-900">📊 GitHub Analytics Dashboard</h1>
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
            <div className="grid md:grid-cols-4 gap-6 mb-6">
              <StatCard
                icon={<Eye className="text-blue-600" size={24} />}
                title="Total Views"
                value={data.summary.total_views.toLocaleString()}
                subtitle={`${data.summary.unique_views.toLocaleString()} unique`}
              />
              <StatCard
                icon={<GitPullRequest className="text-green-600" size={24} />}
                title="Total Clones"
                value={data.summary.total_clones.toLocaleString()}
                subtitle={`${data.summary.unique_clones.toLocaleString()} unique`}
              />
              <StatCard
                icon={<Star className="text-yellow-600" size={24} />}
                title="Stars"
                value={data.summary.latest_stars.toLocaleString()}
                subtitle={data.summary.stars_growth > 0 ? `+${data.summary.stars_growth} this period` : 'No change'}
              />
              <StatCard
                icon={<GitFork className="text-purple-600" size={24} />}
                title="Forks"
                value={data.summary.latest_forks.toLocaleString()}
                subtitle={data.summary.forks_growth > 0 ? `+${data.summary.forks_growth} this period` : 'No change'}
              />
            </div>

            {/* Views Chart */}
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Repository Views</h2>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.views}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="count" stroke="#3b82f6" name="Total Views" />
                  <Line type="monotone" dataKey="uniques" stroke="#10b981" name="Unique Visitors" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Clones Chart */}
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Repository Clones</h2>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.clones}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="count" stroke="#8b5cf6" name="Total Clones" />
                  <Line type="monotone" dataKey="uniques" stroke="#ec4899" name="Unique Cloners" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Top Referrers */}
            {data.referrers && data.referrers.length > 0 && (
              <div className="bg-white rounded-lg shadow p-6 mb-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">Top Referrers</h2>
                <div className="space-y-2">
                  {data.referrers.slice(0, 10).map((ref, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded">
                      <span className="font-medium text-gray-900">{ref.referrer}</span>
                      <div className="text-right">
                        <span className="text-blue-600 font-semibold">{ref.count} views</span>
                        <span className="text-gray-500 text-sm ml-2">({ref.uniques} unique)</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Popular Paths */}
            {data.paths && data.paths.length > 0 && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">Popular Content</h2>
                <div className="space-y-2">
                  {data.paths.slice(0, 10).map((path, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded">
                      <div>
                        <span className="font-medium text-gray-900">{path.path}</span>
                        {path.title && <p className="text-sm text-gray-600">{path.title}</p>}
                      </div>
                      <div className="text-right">
                        <span className="text-blue-600 font-semibold">{path.count} views</span>
                        <span className="text-gray-500 text-sm ml-2">({path.uniques} unique)</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <Calendar className="mx-auto text-gray-400" size={48} />
            <p className="text-gray-600 mt-4">No data available yet. Run the collector to start tracking!</p>
            <code className="block mt-4 text-sm bg-gray-100 px-4 py-2 rounded">npm run collect</code>
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({ icon, title, value, subtitle }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-2">
        {icon}
      </div>
      <h3 className="text-sm font-medium text-gray-600 mb-1">{title}</h3>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}
