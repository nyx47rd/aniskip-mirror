# AniSkip Mirror by nyx47rd

[![Tests](https://github.com/nyx47rd/aniskip-mirror/actions/workflows/tests.yml/badge.svg)](https://github.com/nyx47rd/aniskip-mirror/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live (Vercel)](https://img.shields.io/badge/live-vercel-blue)](https://aniskip-mirror.vercel.app/health)
[![Live (Cloudflare)](https://img.shields.io/badge/live-cloudflare-orange)](https://aniskip-mirror-cf.yasar-123-sevda.workers.dev/health)

A self-hosted, **AniSkip-compatible** API for anime skip times (opening /
ending / recap). It pulls the weekly public dataset from
[`aniskip/sanitize_db_dump`](https://github.com/aniskip/sanitize_db_dump),
loads it into PostgreSQL (Neon in production), and serves it through the
**same v1 and v2 endpoints** the official
[`aniskip/aniskip-api`](https://github.com/aniskip/aniskip-api) exposes -
so anime apps that already talk to `api.aniskip.com` can point at your
URL with no client-side changes.

**Live instances:**

| Backend | URL | Best for |
|---|---|---|
| Vercel + Neon (source of truth) | <https://aniskip-mirror.vercel.app> | Always-fresh data, low-cold-start in EU |
| Cloudflare Worker + R2 (edge cache) | <https://aniskip-mirror-cf.yasar-123-sevda.workers.dev> | Global low-latency, scales with traffic |

```bash
# Health check (both backends respond with the same shape)
curl -s https://aniskip-mirror.vercel.app/health | jq
curl -s https://aniskip-mirror-cf.yasar-123-sevda.workers.dev/health | jq

# Get OP + ED times for One Piece episode 1
curl -s 'https://aniskip-mirror.vercel.app/v1/skip-times/21/1?types=op,ed' | jq
curl -s 'https://aniskip-mirror-cf.yasar-123-sevda.workers.dev/v1/skip-times/21/1?types=op,ed' | jq

# Same query via v2 (camelCase + 404-on-empty)
curl -s 'https://aniskip-mirror.vercel.app/v2/skip-times/21/1?types=op,ed' | jq
```

The mirror is intentionally **read-only**. POST endpoints (create /
vote) return `403`. If you want to accept submissions, see
[Enabling writes](#enabling-writes-optional) below.

> Data attribution: skip times are sourced from the public
> [AniSkip dataset](https://github.com/aniskip/sanitize_db_dump),
> originally collected by the AniSkip community.
> API surface is reverse-engineered from the MIT-licensed
> [aniskip-api](https://github.com/aniskip/aniskip-api) source code.

---

## Table of contents

1. [Architecture](#architecture)
2. [Requirements](#requirements)
3. [Setup](#setup)
4. [Neon PostgreSQL setup](#neon-postgresql-setup)
5. [Local development](#local-development)
6. [Dataset import](#dataset-import)
7. [Vercel deployment](#vercel-deployment)
8. [Cloudflare Worker + R2 (edge mirror)](#cloudflare-worker--r2-edge-mirror)
9. [GitHub Actions: weekly update](#github-actions-weekly-update)
10. [API endpoints](#api-endpoints)
11. [Example requests](#example-requests)
12. [Enabling writes (optional)](#enabling-writes-optional)
13. [Troubleshooting](#troubleshooting)

---

## Architecture

```
                    ┌────────────────────┐
                    │ AniSkip Public CSV │  (raw.githubusercontent.com)
                    └─────────┬──────────┘
                              │  Python importer (psycopg2 + COPY)
                              ▼
                    ┌────────────────────┐
                    │ Neon PostgreSQL    │  skip_times table
                    └─────────┬──────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
   ┌────────────────────┐          ┌────────────────────┐
   │ Vercel + Neon      │  ──push──▶│ Cloudflare R2      │
   │ (source of truth)  │          │ aniskip-mirror-data│
   │ /v1, /v2 endpoints │          │ v1/<animeId>.json  │
   │                    │          │ v2/<animeId>.json  │
   └─────────┬──────────┘          └─────────┬──────────┘
             │                               │
             ▼                               ▼
   ┌────────────────────┐          ┌────────────────────┐
   │ Vercel serverless  │          │ Cloudflare Worker  │
   │  /v1, /v2 (always  │          │  /v1, /v2 (edge    │
   │  fresh, EU)        │          │  cached, global)   │
   └─────────┬──────────┘          └─────────┬──────────┘
             │                               │
             └───────────────┬───────────────┘
                             ▼
                      Anime applications
```

- **API (Vercel):** Node.js, `@vercel/node` runtime. Each endpoint is
  a single file under `api/`. Hot path uses parameterized SQL with a
  `(anime_id, episode_number, skip_type, votes DESC)` covering index.
- **API (Cloudflare):** Same shape, served by `cf-worker/src/index.js`.
  Reads pre-built JSON from R2 and wraps it with a 7-day edge cache.
- **Importer:** Python 3.12, `psycopg2-binary`. Streams the CSV
  through a temp table and inserts in one transaction.
- **R2 populator:** `cf-worker/scripts/populate_r2_per_anime.py`. Reads
  the database once and writes one JSON per anime to R2
  (`v1/<animeId>.json` and `v2/<animeId>.json`), collapsing ~75k
  per-type rows into ~3k per-anime files. The Worker then parses
  those files at request time and returns the upstream-shaped body.
- **Database:** PostgreSQL 16 (Neon). Uses `pgcrypto` for
  `gen_random_uuid()`.

The dataset has ~75k rows, ~3.8 MB. A full import takes about 5–10 s.

---

## Requirements

- Node.js 18+ (Vercel runtime is Node 20)
- Python 3.12 with `psycopg2-binary` (only for the importer)
- A PostgreSQL database - this guide assumes [Neon](https://neon.tech)
  free tier, but any Postgres 14+ works
- A Vercel account (free Hobby tier is enough)
- (Optional) GitHub Actions - the weekly update workflow is included

---

## Setup

1. **Clone this repo** (or generate your own from these files):

   ```bash
   git clone https://github.com/<you>/aniskip-mirror.git
   cd aniskip-mirror
   ```

2. **Install Node dependencies**:

   ```bash
   npm install
   ```

3. **Install Python dependencies** (for the importer only):

   ```bash
   pip install -r requirements.txt
   ```

4. **Copy `.env.example`** to `.env` and fill in:

   ```bash
   cp .env.example .env
   ```

   The only required value is `DATABASE_URL`.

---

## Neon PostgreSQL setup

1. Create a free account at <https://neon.tech>.
2. Create a new project (pick the closest region).
4. Open the project dashboard → **Connection Details** → copy the
   connection string. It looks like:

   ```
   postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require
   ```

5. Paste it into `.env` as `DATABASE_URL`.
6. Apply the schema:

   ```bash
   psql "$DATABASE_URL" -f sql/init.sql
   psql "$DATABASE_URL" -f sql/migrations/001_relax_constraints.sql
   ```

   (`psql` is part of the postgres-client package. On macOS:
    `brew install libpq && brew link --force libpq`.)

7. (Optional) Verify the table is empty:

   ```bash
   DATABASE_URL=... python3 scripts/validate_dataset.py
   ```

---

## Local development

```bash
# Terminal 1 - run the API locally
DATABASE_URL=... npm run dev   # uses vercel dev

# Terminal 2 - hit it
curl http://localhost:3000/health
curl 'http://localhost:3000/v1/skip-times/21/1?types=op'
```

`api/_server.js` is a tiny Node router that mimics Vercel's behavior
so you can also run `node api/_server.js` without installing the Vercel
CLI.

---

## Dataset import

```bash
# Import the latest public CSV
DATABASE_URL=... python3 scripts/import_dataset.py

# Import a local copy
DATABASE_URL=... python3 scripts/import_dataset.py --csv ./skip_times_public.csv

# Validate without touching the DB
python3 scripts/import_dataset.py --csv ./skip_times_public.csv --dry-run
```

The importer:

- Downloads the CSV from the URL in `CSV_SOURCE_URL` (default =
  AniSkip's repo).
- Drops outliers: votes < -1000, episode_length > 6 hours, end_time
  inconsistent with episode_length, malformed dates.
- Stages the rest in a temp TSV, `COPY`s into Postgres, then inserts
  via `INSERT ... ON CONFLICT DO NOTHING` (the public CSV has no
  `skip_id`, so duplicates in the CSV collapse by natural key).
- Reports accepted / rejected / inserted counts and rolls back on any
  error.

Re-running is idempotent for already-imported rows.

---

## Vercel deployment

1. **Push the repo to GitHub** (private or public, your choice).
3. **Import into Vercel**:
   - New Project → Import Git Repository.
   - Framework preset: **Other**.
   - Build command: leave empty (Vercel auto-detects from `vercel.json`).
4. **Set environment variables** in *Project Settings → Environment
   Variables*:

   | Name | Value | Scope |
   |---|---|---|
   | `DATABASE_URL` | your Neon connection string | Production (and Preview if you want previews to work) |
   | `CORS_ORIGINS` | `*` (or comma-separated list of origins) | Production |
   | `NODE_ENV` | `production` | Production |
   | `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | Production (for the admin upload endpoint) |
   | `R2_BUCKET` | your R2 bucket name (e.g. `aniskip-mirror-data`) | Production |
   | `R2_ACCESS_KEY_ID` | R2 API token access key | Production |
   | `R2_SECRET_ACCESS_KEY` | R2 API token secret key | Production |
   | `ADMIN_TOKEN` | a long random string | Production (required to call `/admin/upload-r2`) |

5. **Deploy**. Vercel will run `vercel.json` and expose the endpoints
   listed below.
6. **Smoke test**:

   ```bash
   curl https://<your-project>.vercel.app/health
   curl 'https://<your-project>.vercel.app/v1/skip-times/21/1?types=op'
   ```

You can point any AniSkip-compatible client at the root URL with no
further changes.

### Populating the R2 edge cache

Once Vercel is serving traffic, you can mirror the dataset into a
Cloudflare R2 bucket so the Cloudflare Worker can serve it with
sub-100ms global latency. The admin endpoint at `/admin/upload-r2`
streams rows from the database in paginated chunks and writes one
JSON per anime into the bucket:

```bash
ADMIN_TOKEN=...   # the same value you set in Vercel
URL=https://<your-project>.vercel.app

offset=0
while :; do
  resp=$(curl -fsS -X POST -H "x-admin-token: $ADMIN_TOKEN" \
    "$URL/admin/upload-r2?offset=$offset&limit=2000")
  echo "$resp"
  next=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("next_offset",-1))')
  ok=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok",0))')
  err=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("errs",0))')
  if [ -z "$next" ] || [ "$next" -le "$offset" ] || [ "$ok" = "0" ] && [ "$err" = "0" ]; then
    break
  fi
  offset=$next
done
```

The full 75k rows finish in ~4 minutes (Vercel Hobby 10s timeout per
chunk is respected via `?limit=2000`). A weekly GitHub Action can call
the same endpoint to keep R2 in sync after each dataset refresh.

---

## Cloudflare Worker + R2 (edge mirror)

For global low-latency reads, mirror the dataset into a Cloudflare R2
bucket and serve it with a Cloudflare Worker. The Worker returns the
exact same response shape as Vercel, so the client only needs to swap
the base URL.

### 1. Create the R2 bucket

```bash
# Log in with wrangler (creates a scoped API token on first use)
npx wrangler login

# Create the bucket
npx wrangler r2 bucket create aniskip-mirror-data
```

Note the Cloudflare **account ID** (`wrangler whoami` shows it). You
will need it for the next step.

### 2. Create an R2 API token

In the Cloudflare dashboard: **R2 → Manage R2 API Tokens → Create
API token** with *Object Read & Write* scoped to
`aniskip-mirror-data`. Save the `access_key_id` and
`secret_access_key` somewhere safe - you will add them to Vercel as
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and to your local
machine for the populator.

### 3. Configure the Worker

`cf-worker/wrangler.toml` already binds an R2 bucket called `DATA`:

```toml
name = "aniskip-mirror-cf"
main = "src/index.js"
compatibility_date = "2024-12-01"

[[r2_buckets]]
binding = "DATA"
bucket_name = "aniskip-mirror-data"
```

The handler in `cf-worker/src/index.js`:

- Reads the per-anime JSON file from R2 (e.g. `v1/21.json` or
  `v2/21.json`).
- Picks the requested episode and skip types and returns the
  upstream-shaped body.
- Wraps every successful response in a 7-day Cloudflare cache
  (`Cache-Control: public, s-maxage=604800`).
- Returns 404 (with body) on missing data for v2, 200 with
  `found:false` for v1.

Deploy with:

```bash
cd cf-worker
npm install
npx wrangler deploy
```

The Worker is now reachable at
`https://aniskip-mirror-cf.<your-subdomain>.workers.dev`.

### 4. Populate R2 from the database

`cf-worker/scripts/populate_r2_per_anime.py` reads the
`skip_times` table from Neon and writes one JSON per anime:

```bash
export R2_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
export R2_BUCKET="aniskip-mirror-data"
export R2_ACCESS_KEY_ID="..."
export R2_SECRET_ACCESS_KEY="..."
export DATABASE_URL="postgresql://..."

pip install boto3 psycopg2-binary
python3 cf-worker/scripts/populate_r2_per_anime.py
```

This collapses the 75k per-row dataset into ~3k per-anime files.
Re-run after every weekly dataset refresh, or trigger the
`/admin/upload-r2` endpoint from the GitHub Action to keep the bucket
in sync.

### 5. Smoke test

```bash
CF=https://aniskip-mirror-cf.<your-subdomain>.workers.dev
curl -s $CF/health
curl -s "$CF/v1/skip-times/21/1?types=op,ed"
curl -s "$CF/v2/skip-times/21/1?types=op,ed"
```

The Cloudflare mirror is read-only and updates with the same weekly
cadence as Vercel. To use it as the primary, point your client at the
Worker URL; to keep Vercel as the primary and the Worker as a hot
fallback, configure your client with both URLs.

---

## GitHub Actions: weekly update

`.github/workflows/update-dataset.yml` runs every Sunday at 03:17 UTC.
It re-applies the schema (idempotent thanks to `CREATE TABLE IF NOT
EXISTS`), runs the importer, and optionally smoke-tests the deployed
API.

To enable:

1. **Add `DATABASE_URL`** as a repository secret (Settings → Secrets
   and variables → Actions → New repository secret).
2. (Optional) Add `API_BASE_URL` as a *variable* (not a secret) to
   enable the smoke test step - e.g. `https://aniskip-mirror.vercel.app`.
3. (Optional) Override `CSV_SOURCE_URL` if you mirror the dataset
   yourself.
4. Trigger manually once from the Actions tab to confirm everything
   works.

---

## API endpoints

All routes accept CORS preflight (`OPTIONS`) and respond with
`Access-Control-Allow-Origin` set from the `CORS_ORIGINS` env var
(defaults to `*`).

| Method | Path | Response shape | Notes |
|---|---|---|---|
| GET | `/health` | `{status, service, database, ...}` | 503 if DB unreachable |
| GET | `/v1/skip-times/:anime_id/:episode_number` | `{found, results:[{interval:{start_time,end_time},skip_type,episode_length}]}` | snake_case, always 200, edge-cached 24h |
| GET | `/v2/skip-times/:animeId/:episodeNumber` | `{statusCode,message,found,results:[{interval:{startTime,endTime},skipType,episodeLength}]}` | camelCase, 404 on no data, edge-cached 24h |
| GET | `/v1/rules/:anime_id` | `{found, rules:[...]}` | empty unless `RELATION_RULES_PATH` set |
| GET | `/v2/relation-rules/:animeId` | `{statusCode,message,found,rules:[...]}` | 404 on empty |
| POST | `/v1/skip-times/:anime_id/:episode_number` | `403` | disabled (see below) |
| POST | `/v1/skip-times/vote/:skip_id` | `403` | disabled |
| POST | `/v2/skip-times/:animeId/:episodeNumber` | `403` | disabled |
| POST | `/v2/skip-times/vote/:skipId` | `403` | disabled |
| POST | `/admin/upload-r2?offset=N&limit=N` | `{ok, errs, skipped, next_offset, ...}` | requires `x-admin-token: $ADMIN_TOKEN`; streams a paginated chunk from `skip_times` into the R2 bucket |

### Query parameters (GET skip-times)

| Param | v1 | v2 | Type | Default | Notes |
|---|---|---|---|---|---|
| `types` | ✓ | ✓ | string or array | `["op","ed"]` | Repeat the param or comma-separate |
| `episode_length` | ✓ | – | number | `0` | `0` disables the ±20s tolerance |
| `episodeLength` | – | ✓ | number | `0` | same semantics |

The endpoint matches the official AniSkip API's behaviour:

- `votes > -2` (filters out heavily-downvoted entries)
- `ABS(episode_length - $provided_length) <= 20` when a length is given
- `ORDER BY votes DESC LIMIT 10`, taking the first match per type
- v2 returns `404` (with body) when no skip times are found, mirroring
  the upstream contract

---

## Example requests

```bash
# v1: opening + ending for anime 21 (One Piece), episode 1
curl 'https://YOUR-DOMAIN/v1/skip-times/21/1?types=op&types=ed'

# v2: same query, camelCase params
curl 'https://YOUR-DOMAIN/v2/skip-times/21/1?types=op,ed&episodeLength=0'

# v2 with strict episode-length tolerance (within ±20s of 1420)
curl 'https://YOUR-DOMAIN/v2/skip-times/21/1?types=op,ed&episodeLength=1420'

# v1 for an anime that doesn't exist
curl 'https://YOUR-DOMAIN/v1/skip-times/999999/1?types=op'
# {"found":false,"results":[]}
```

A v1 success looks like:

```json
{
  "found": true,
  "results": [
    {
      "interval": { "start_time": 90.0, "end_time": 180.0 },
      "skip_type": "op",
      "episode_length": 1420.061
    }
  ]
}
```

---

## Enabling writes (optional)

The mirror is read-only by default. If you want to accept submissions
or votes, you need to:

1. Implement the `INSERT` and `UPDATE` paths (see the official
   `aniskip-api` repository for the exact SQL and input validation).
2. Remove the 403 stubs under `api/v1/skip-times/create.js`,
   `api/v1/skip-times/vote.js`, `api/v2/skip-times/create.js`,
   `api/v2/skip-times/vote.js`.
3. Use a unique constraint on the natural key (or `skip_id`) so the
   importer doesn't double-insert.

We deliberately keep the mirror read-only in this version because
community moderation is the hard part of accepting submissions - and
the public dataset is already curated.

---

## Troubleshooting

**`/health` returns 503 "unreachable"**
- Check that `DATABASE_URL` is set in Vercel (Project → Settings →
  Environment Variables) and that you redeployed after adding it.
- Neon requires `sslmode=require` in the URL. Make sure it's there.

**`/v1/skip-times/...` returns `found:false` for an anime that does
have skips**
- The public dataset is curated. Some entries are dropped by the
  upstream `votes > -2` filter. If your client provides
  `episode_length`, make sure it's within ±20 seconds of the
  recorded length.

**Importer fails with `extension "pgcrypto" is not available`**
- Neon has `pgcrypto` enabled. On a self-hosted Postgres, run:
  `CREATE EXTENSION IF NOT EXISTS pgcrypto;` once as a superuser.

**GitHub Actions step `Apply schema` errors with `permission denied`**
- Your `DATABASE_URL` is missing `sslmode=require` or points to a
  database the role can't write to.

**CORS errors in the browser**
- Default `CORS_ORIGINS=*` allows everything. If you restrict it,
  include the full origin (`https://app.example.com`), not just the
  domain.

**Vercel function times out**
- The first cold start runs the connection pool warmup. Subsequent
  requests are < 50 ms in our tests. If you see sustained timeouts,
  check the Neon status page and your connection-string region.

**Cloudflare Worker returns 500 on the first request after deploy**
- The R2 binding needs at least one object to exist before the
  Worker can serve traffic. Re-run the populator and the next
  request will be served from the edge cache.

**`/admin/upload-r2` returns 401**
- The `ADMIN_TOKEN` env var is missing on Vercel or the
  `x-admin-token` request header does not match. Vercel env var
  changes require a redeploy.

**`/admin/upload-r2` returns `FUNCTION_INVOCATION_TIMEOUT`**
- Vercel Hobby caps serverless functions at 10s. Keep `limit` at
  2000 or below, or upgrade to Vercel Pro (60s default, 5 min
  with `vercel.json` `functions` config) to push larger chunks.

---

## License & attribution

- Source code: **MIT** (matches the upstream
  [aniskip-api](https://github.com/aniskip/aniskip-api) license).
- Public dataset: © AniSkip community, distributed at
  <https://github.com/aniskip/sanitize_db_dump>. Please retain the
  upstream attribution if you redistribute the data.
- The mirror's compatibility surface is derived from the
  [MIT-licensed](https://github.com/aniskip/aniskip-api/blob/main/LICENSE)
  AniSkip API source code.

This project is not affiliated with AniSkip; it is a community
mirror.