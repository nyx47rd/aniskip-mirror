# Security policy

## Reporting a vulnerability

If you discover a security issue in **AniSkip Mirror**, please report it
privately rather than opening a public GitHub issue.

- **GitHub:** open a [private security advisory](https://github.com/nyx47rd/aniskip-mirror/security/advisories/new)
- **Response time:** best effort, usually within 7 days

## Scope

- The Node.js API code in `api/`
- The Python importer in `scripts/`
- The PostgreSQL schema in `sql/`

## Out of scope

- The upstream AniSkip API and dataset (file issues against the
  [original repositories](https://github.com/aniskip) instead)
- The Vercel platform
- The Neon platform

## Hardening notes for self-hosters

- `DATABASE_URL` contains credentials; treat it like a password
- Do not commit `.env.local`, `.env`, or any file matching `.env*`
- CORS defaults to `*`; restrict via the `CORS_ORIGINS` env var if you
  don't need cross-origin access
- This mirror is read-only; POST endpoints return `403` by design
