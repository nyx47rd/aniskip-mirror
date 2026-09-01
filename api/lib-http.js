// CORS + standard JSON helpers shared by every endpoint.

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers.origin;
  let allowOrigin = '*';
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes('*')) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) allowOrigin = origin;
    else allowOrigin = ALLOWED_ORIGINS[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function applyCors(req, res) {
  const h = corsHeaders(req);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function json(req, res, status, body) {
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Cache successful GET responses at the CDN edge for 1 week.
  // Skip-time data is updated weekly (Sunday ~03:00 UTC) and the
  // update-dataset workflow issues a PURGE after each import, so
  // long cache is safe and cuts Neon egress dramatically.
  if (status === 200 && req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.end(JSON.stringify(body));
}

function handleOptions(req, res) {
  applyCors(req, res);
  res.statusCode = 204;
  res.end();
}

// Lightweight in-memory token bucket. One bucket per IP per window.
// Good enough for Vercel without pulling in Redis; counts are wiped
// when the function freezes, but Vercel keeps the instance warm for
// short bursts which is the realistic abuse window.
const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = 240 } = {}) {
  return function check(req, res) {
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';
    const now = Date.now();
    const entry = buckets.get(ip);
    if (!entry || now - entry.start > windowMs) {
      buckets.set(ip, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (entry.count > max) {
      json(req, res, 429, {
        statusCode: 429,
        message: 'Too many requests',
      });
      return false;
    }
    return true;
  };
}

// Parse and validate path/query params consistently.
function parsePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    const e = new Error(`${name} must be a positive integer`);
    e.status = 400;
    throw e;
  }
  return Math.trunc(n);
}

function parseEpisodeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    const e = new Error('episode_number must be a number >= 0');
    e.status = 400;
    throw e;
  }
  return n;
}

const V1_TYPES = new Set(['op', 'ed']);
const V2_TYPES = new Set(['op', 'ed', 'mixed-op', 'mixed-ed', 'recap']);

function parseTypes(rawTypes, version) {
  const allowed = version === 2 ? V2_TYPES : V1_TYPES;
  let arr;
  if (rawTypes == null) arr = [];
  else if (Array.isArray(rawTypes)) arr = rawTypes;
  else arr = String(rawTypes).split(',').map((s) => s.trim()).filter(Boolean);
  const uniq = [...new Set(arr)];
  for (const t of uniq) {
    if (!allowed.has(t)) {
      const e = new Error(`invalid skip_type: ${t}`);
      e.status = 400;
      throw e;
    }
  }
  if (uniq.length === 0) return ['op', 'ed'];
  return uniq;
}

function parseEpisodeLength(raw) {
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
module.exports = { applyCors, json, handleOptions, rateLimit, parsePositiveInt, parseEpisodeNumber, parseTypes, parseEpisodeLength };
