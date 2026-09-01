// End-to-end test against a real Postgres (CI provides one via the
// `services:` block in tests.yml).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

process.env.CORS_ORIGINS = '*';
const dbMod = require('../api/lib-db.js');
const http = require('../api/lib-http.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Each test runs in isolation; we use a fresh anime/episode pair to
// avoid clashing with concurrent jobs in CI.

function fakeReq(url, method = 'GET') {
  // Build a minimal req/res mimicking what Vercel passes in.
  const u = new URL(url, 'http://localhost');
  const req = {
    method,
    url,
    headers: {},
    query: Object.fromEntries(u.searchParams),
  };
  return req;
}

function fakeRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    end(body) {
      this.body = body;
      this.headers = headers;
    },
  };
  return res;
}

async function seed(animeId, episode, rows = []) {
  await pool.query('DELETE FROM skip_times WHERE anime_id = $1', [animeId]);
  const sql = `INSERT INTO skip_times (anime_id, episode_number, provider_name, skip_type, votes, start_time, end_time, episode_length, submitter_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,gen_random_uuid())`;
  for (const r of rows) {
    await pool.query(sql, [
      animeId, episode, r.provider || 'Crunchyroll',
      r.type || 'op', r.votes ?? 100, r.start, r.end, r.length,
    ]);
  }
}

test('health endpoint returns ok when DB connected', async () => {
  const req = fakeReq('/health');
  const res = fakeRes();
  const handler = require('../api/health.js');
  await handler(req, res);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.service, 'aniskip-mirror');
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(res.statusCode, 200);
});

test('v1 GET returns snake_case interval + skip_type', async () => {
  const ANIME = 100001;
  const EP = 7;
  await seed(ANIME, EP, [
    { type: 'op', start: 90, end: 180, length: 1440, votes: 1000 },
    { type: 'ed', start: 1300, end: 1390, length: 1440, votes: 500 },
  ]);
  const req = fakeReq(`/v1/skip-times/${ANIME}/${EP}?types=op,ed&episode_length=1440`);
  const res = fakeRes();
  const handler = require('../api/v1/skip-times/[anime_id]/[episode_number].js');
  await handler(req, res);
  const body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.found, true);
  assert.strictEqual(body.results.length, 2);
  const op = body.results.find((r) => r.skip_type === 'op');
  assert.ok(op, 'expected op result');
  assert.ok('start_time' in op.interval);
  assert.ok('end_time' in op.interval);
  assert.strictEqual(typeof op.skip_id, 'string');
});

test('v1 GET returns found:false when no data', async () => {
  const ANIME = 100002;
  const req = fakeReq(`/v1/skip-times/${ANIME}/99?types=op`);
  const res = fakeRes();
  const handler = require('../api/v1/skip-times/[anime_id]/[episode_number].js');
  await handler(req, res);
  const body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.found, false);
  assert.deepStrictEqual(body.results, []);
});

test('v1 GET returns 400 for bad anime id', async () => {
  const req = fakeReq('/v1/skip-times/0/1?types=op');
  const res = fakeRes();
  const handler = require('../api/v1/skip-times/[anime_id]/[episode_number].js');
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400);
});

test('v1 GET respects episode_length tolerance (±20s)', async () => {
  const ANIME = 100003;
  const EP = 1;
  await seed(ANIME, EP, [
    { type: 'op', start: 90, end: 180, length: 1500, votes: 50 },
  ]);
  // Client says length is 1440 -> within ±20 of 1440? No (diff=60).
  // Try 1485 -> diff=15 -> match.
  let req = fakeReq(`/v1/skip-times/${ANIME}/${EP}?types=op&episode_length=1485`);
  let res = fakeRes();
  let handler = require('../api/v1/skip-times/[anime_id]/[episode_number].js');
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).found, true);

  req = fakeReq(`/v1/skip-times/${ANIME}/${EP}?types=op&episode_length=1000`);
  res = fakeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).found, false);
});

test('v2 GET returns camelCase and 404 on no data', async () => {
  const ANIME = 100004;
  const EP = 1;
  await seed(ANIME, EP, [
    { type: 'mixed-op', start: 0, end: 90, length: 1400, votes: 100 },
  ]);
  let req = fakeReq(`/v2/skip-times/${ANIME}/${EP}?types=mixed-op`);
  let res = fakeRes();
  let handler = require('../api/v2/skip-times/[animeId]/[episodeNumber].js');
  await handler(req, res);
  let body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.found, true);
  assert.strictEqual(body.statusCode, 200);
  assert.ok(body.results[0].interval.startTime != null);
  assert.ok(body.results[0].interval.endTime != null);
  assert.strictEqual(body.results[0].skipType, 'mixed-op');
  assert.ok(body.results[0].skipId);

  // 404 path
  req = fakeReq(`/v2/skip-times/${ANIME}/99?types=mixed-op`);
  res = fakeRes();
  await handler(req, res);
  body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(body.statusCode, 404);
  assert.strictEqual(body.found, false);
});

test('v2 GET rejects v1-only skip_type with 400', async () => {
  const req = fakeReq('/v2/skip-times/1/1?types=op,invalid-type');
  const res = fakeRes();
  const handler = require('../api/v2/skip-times/[animeId]/[episodeNumber].js');
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400);
});

test('votes > -2 hides heavily downvoted entries', async () => {
  const ANIME = 100005;
  const EP = 1;
  await seed(ANIME, EP, [
    { type: 'op', start: 90, end: 180, length: 1400, votes: -5 },
    { type: 'op', start: 100, end: 190, length: 1400, votes: -1 },
  ]);
  const req = fakeReq(`/v1/skip-times/${ANIME}/${EP}?types=op`);
  const res = fakeRes();
  const handler = require('../api/v1/skip-times/[anime_id]/[episode_number].js');
  await handler(req, res);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.found, true);
  // Only the -1 row should pass the votes > -2 filter.
  assert.strictEqual(body.results.length, 1);
  assert.strictEqual(body.results[0].interval.start_time, 100);
});

test('writes are disabled by default (v1 POST -> 403)', async () => {
  const req = fakeReq('/v1/skip-times/1/1', 'POST');
  const res = fakeRes();
  const handler = require('../api/v1/skip-times/create.js');
  await handler(req, res);
  assert.strictEqual(res.statusCode, 403);
});

test('CORS preflight returns 204 with headers', () => {
  const req = fakeReq('/health', 'OPTIONS');
  const res = fakeRes();
  const handler = require('../api/health.js');
  return handler(req, res).then(() => {
    assert.strictEqual(res.statusCode, 204);
    assert.ok(res.headers['Access-Control-Allow-Origin']);
  });
});

test.after(async () => {
  await pool.end();
});