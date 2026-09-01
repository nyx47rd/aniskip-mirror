const { json, handleOptions, rateLimit, applyCors } = require('./lib-http.js');
const { pingDb } = require('./lib-db.js');

const rl = rateLimit({ windowMs: 60_000, max: 120 });

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') {
    return json(req, res, 405, { status: 405, message: 'Method not allowed' });
  }
  if (!rl(req, res)) return;

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
}