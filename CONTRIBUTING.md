# Contributing

Thanks for your interest in contributing.

## Quick links

- Found a bug? [Open an issue](https://github.com/opena2a-org/github-analytics-tracker/issues/new).
- Have a feature idea? Start a discussion before opening a PR.
- Want to track a new data source (HuggingFace, Reddit, etc.)? See the patterns in `scripts/collect-*.js`.

## Local development

```bash
git clone https://github.com/opena2a-org/github-analytics-tracker.git
cd github-analytics-tracker
npm install
cp .env.example .env  # add your GITHUB_TOKEN
npm run setup-db
npm run collect
npm run dev
```

Open http://localhost:3000.

## Code style

- Plain Node.js, no frameworks beyond Next.js (intentional — keep it transparent).
- SQL queries always use `prepare(...).run(...)` parameterization. Never string-concat SQL.
- New collectors follow the pattern in `scripts/collect-npm-stats.js`: open DB, fetch from public API, upsert with `INSERT OR REPLACE`, write a static JSON artifact to `data/`.
- New tables go in `scripts/setup-database.js` with `CREATE TABLE IF NOT EXISTS`.

## Pull request checklist

1. New collectors: include schema migration in `setup-database.js`, output static JSON in `data/`, document the env var in `README.md` and `.github/workflows/collect-stats.yml`.
2. Dashboard changes: verify charts render with empty data (newly-added repos start with 0 history).
3. No new secrets in env vars without documenting in `.env.example` and the workflow.
4. Run `npm audit` and fix any new high/critical vulns.

## Code of conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree your work is licensed under MIT (see [LICENSE](./LICENSE)).
