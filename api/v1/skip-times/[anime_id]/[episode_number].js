const {json,
  handleOptions,
  applyCors,
  rateLimit,
  parsePositiveInt,
  parseEpisodeNumber,
  parseTypes,
  parseEpisodeLength,} = require('../../../lib-http.js');
const {findSkipTimes} = require('../../../lib-db.js');

const rl = rateLimit({ windowMs: 60_000, max: 120 });

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') {
    return json(req, res, 405, { status: 405, message: 'Method not allowed' });
  }
  if (!rl(req, res)) return;

  let animeId, episodeNumber, types, episodeLength;
  try {
    // Vercel dynamic route params are in the URL, not req.query.
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    // /v1/skip-times/<anime_id>/<episode_number>
    const animeIdRaw = parts[2] ?? req.query.anime_id;
    const epRaw = parts[3] ?? req.query.episode_number;
    animeId = parsePositiveInt(animeIdRaw, 'anime_id');
    episodeNumber = parseEpisodeNumber(epRaw);
    types = parseTypes(req.query.types, 1);
    episodeLength = parseEpisodeLength(req.query.episode_length);
  } catch (e) {
    return json(req, res, 400, { message: e.message });
  }

  const results = [];
  try {
    for (const skipType of types) {
      const rows = await findSkipTimes({
        animeId,
        episodeNumber,
        skipType,
        episodeLength,
      });
      const top = rows[0];
      if (top) {
        results.push({
          interval: {
            start_time: Number(top.start_time),
            end_time: Number(top.end_time),
          },
          skip_type: top.skip_type,
          episode_length: Number(top.episode_length),
        });
      }
    }
  } catch (err) {
    console.error('[v1] findSkipTimes error', err);
    return json(req, res, 500, { message: 'Internal server error' });
  }

  return json(req, res, 200, {
    found: results.length > 0,
    results,
  });
}