const { json, handleOptions, applyCors } = require('./lib-http.js');
const { pingDb } = require('./lib-db.js');

const V2_TYPES = new Set(['op', 'ed', 'mixed-op', 'mixed-ed', 'recap']);

let _s3 = null;
function s3() {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _s3;
}

function v1Body(st, e, l, t) {
  return {
    found: true,
    results: [{
      interval: { start_time: Number(st), end_time: Number(e) },
      skip_type: t,
      episode_length: Number(l),
    }],
  };
}
function v2Body(st, e, l, t) {
  return {
    statusCode: 200,
    message: 'Successfully found skip times',
    found: true,
    results: [{
      interval: { startTime: Number(st), endTime: Number(e) },
      skipType: t,
      episodeLength: Number(l),
    }],
  };
}

async function uploadR2(req, res) {
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return json(req, res, 401, { message: 'unauthorized' });
  }
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET) {
    return json(req, res, 500, { message: 'R2 env not set' });
  }

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { query } = require('./lib-db.js');

  // Paginated upload: each call processes a chunk of rows from the
  // skip_times table, groups them by anime, and writes one JSON per
  // anime into both v1/ and v2/ prefixes. Vercel Hobby has a 10s
  // timeout, so the row limit is tuned accordingly. The "force"
  // flag will overwrite an existing anime file.
  const u = new URL(req.url, 'http://localhost');
  const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0', 10) || 0);
  const limit = Math.min(3000, Math.max(1, parseInt(u.searchParams.get('limit') || '2000', 10) || 2000));
  const force = u.searchParams.get('force') === '1';

  const started = Date.now();
  const { rows } = await query(
    'SELECT anime_id, episode_number, skip_type, start_time, end_time, episode_length ' +
    'FROM skip_times WHERE votes > -2 ' +
    'ORDER BY anime_id, episode_number, skip_type ' +
    'LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  if (rows.length === 0) {
    return json(req, res, 200, { ok: 0, errs: 0, skipped: 0, offset, limit, done: true, elapsed_s: 0 });
  }

  // Group rows by anime: { anime_id: { ep_str: { type: { start, end, length } } } }
  // Both v1 and v2 use the same inner map; buildResults in the Worker
  // formats per version.
  const animes = new Map();
  let skipped = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') { skipped++; continue; }
    const t = r.skip_type;
    if (!V2_TYPES.has(t)) { skipped++; continue; }
    const aid = r.anime_id;
    const ep = r.episode_number;
    let epMap = animes.get(aid);
    if (!epMap) {
      epMap = {};
      animes.set(aid, epMap);
    }
    const epStr = String(ep);
    let byType = epMap[epStr];
    if (!byType) {
      byType = {};
      epMap[epStr] = byType;
    }
    byType[t] = {
      start: Number(r.start_time),
      end: Number(r.end_time),
      length: Number(r.episode_length),
    };
  }

  let ok = 0, errs = 0;
  const tasks = [];
  for (const [aid, data] of animes) {
    const body = JSON.stringify(data, (k, v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      return v;
    });
    tasks.push(
      s3().send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `v1/${aid}.json`,
        Body: body,
        ContentType: 'application/json',
      })).then(() => s3().send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `v2/${aid}.json`,
        Body: body,
        ContentType: 'application/json',
      }))).then(
        () => { ok++; },
        (err) => { errs++; if (errs < 5) console.error('[upload-r2]', err.message); }
      )
    );
  }
  // Limit parallel R2 calls; 8 keeps us well under R2's per-prefix rate.
  const CONC = 8;
  for (let i = 0; i < tasks.length; i += CONC) {
    await Promise.all(tasks.slice(i, i + CONC));
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`[upload-r2] offset=${offset} rows=${rows.length} animes=${animes.size} ok=${ok} err=${errs} skip=${skipped} elapsed=${elapsed}s`);
  return json(req, res, 200, {
    ok, errs, skipped, offset, limit, animes: animes.size,
    next_offset: offset + rows.length, elapsed_s: Number(elapsed),
  });
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);

  if (req.method === 'POST' && req.url.startsWith('/admin/upload-r2')) {
    return uploadR2(req, res);
  }

  if (req.method !== 'GET') {
    return json(req, res, 405, { status: 405, message: 'Method not allowed' });
  }

  const started = Date.now();
  let db = false;
  let error = null;
  try {
    db = await pingDb();
  } catch (e) {
    error = e?.message || 'db error';
  }

  const body = {
    status: db ? 'ok' : 'degraded',
    service: 'aniskip-mirror',
    version: '1.0.0',
    database: db ? 'connected' : 'unreachable',
    uptime_ms: process.uptime ? Math.round(process.uptime() * 1000) : null,
    latency_ms: Date.now() - started,
  };
  if (error && process.env.NODE_ENV !== 'production') body.error = error;
  return json(req, res, db ? 200 : 503, body);
};
