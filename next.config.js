/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    '/api/**': ['./data/**'],
  },
};

module.exports = nextConfig;
