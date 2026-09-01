const {json,
  handleOptions,
  applyCors,
  rateLimit,
  parsePositiveInt,} = require('../../lib-http.js');
const {readFile, stat} = require('node:fs/promises');
const {existsSync} = require('node:fs');

const rl = rateLimit({ windowMs: 60_000, max: 120 });

let cache = null;
let cacheMtime = 0;
const RULES_PATH = process.env.RELATION_RULES_PATH || '/data/anime-relations.txt';

function parseRules(text) {
  const byAnime = new Map();
  let currentAnime = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('::rules')) {
      currentAnime = parseInt(line.split(/\s+/)[1], 10);
      if (!byAnime.has(currentAnime)) byAnime.set(currentAnime, []);
      continue;
    }
    if (line.startsWith('::meta')) {
      currentAnime = null;
      continue;
    }
    if (currentAnime == null) continue;
    const m = line.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+<->\s+(\d+)\s+(\d+)\s+(\d+)$/
    );
    if (!m) continue;
    byAnime.get(currentAnime).push({
      from: { malId: parseInt(m[1], 10), start: parseInt(m[2], 10), end: parseInt(m[3], 10) },
      to:   { malId: parseInt(m[4], 10), start: parseInt(m[5], 10), end: parseInt(m[6], 10) },
    });
  }
  return byAnime;
}

async function getRules() {
  if (!existsSync(RULES_PATH)) return new Map();
  const st = await stat(RULES_PATH);
  if (cache && st.mtimeMs === cacheMtime) return cache;
  const text = await readFile(RULES_PATH, 'utf8');
  cache = parseRules(text);
  cacheMtime = st.mtimeMs;
  return cache;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') {
    return json(req, res, 405, { statusCode: 405, message: 'Method not allowed' });
  }
  if (!rl(req, res)) return;

  let animeId;
  try {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    animeId = parsePositiveInt(parts[2] ?? req.query.animeId, 'animeId');
  } catch (e) {
    return json(req, res, 400, { statusCode: 400, message: e.message });
  }

  let rules = [];
  try {
    const map = await getRules();
    rules = map.get(animeId) || [];
  } catch (err) {
    console.error('[v2 rules] parse error', err);
  }

  if (rules.length === 0) {
    return json(req, res, 404, {
      statusCode: 404,
      message: 'No relation rules found',
      found: false,
      rules: [],
    });
  }
  return json(req, res, 200, {
    statusCode: 200,
    message: 'Successfully found relation rules',
    found: true,
    rules,
  });
}