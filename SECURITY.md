# Security policy

## Reporting a vulnerability

If you find a security issue, please email **info@opena2a.org** rather than opening a public issue.

Include:
- A description of the issue and its impact.
- Steps to reproduce, ideally with a minimal proof-of-concept.
- The version and commit SHA you tested against.

We aim to respond within 72 hours and to ship a fix or mitigation within 14 days for high-severity issues.

## Scope

This repository is a self-hosted analytics tracker. The components that handle untrusted input are:

- `pages/api/*` — read-only HTTP endpoints over the public analytics data.
- `scripts/collect-*.js` — outbound calls to GitHub, npm, PyPI, Docker Hub, and (optionally) Google BigQuery.

The SQLite database and dashboard render only data fetched from those public APIs. There is no user-supplied input path from the dashboard into the database.

## Out of scope

- Hosting your own dashboard on a public URL is out of scope; the API endpoints are unauthenticated by design (the data they expose is already public).
- Issues that require physical access to the machine running the tracker.
- Findings in third-party dependencies that already have an open advisory and a planned upgrade in our queue.

## Supported versions

Only `main` is supported. We do not maintain release branches.
