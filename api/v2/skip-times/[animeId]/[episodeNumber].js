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
    return json(req, res, 405, { statusCode: 405, message: 'Method not allowed' });
  }
  if (!rl(req, res)) return;

  let animeId, episodeNumber, types, episodeLength;
  try {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const animeIdRaw = parts[2] ?? req.query.animeId;
    const epRaw = parts[3] ?? req.query.episodeNumber;
    animeId = parsePositiveInt(animeIdRaw, 'animeId');
    episodeNumber = parseEpisodeNumber(epRaw);
    types = parseTypes(req.query.types, 2);
    episodeLength = parseEpisodeLength(req.query.episodeLength);
  } catch (e) {
    return json(req, res, 400, { statusCode: 400, message: e.message });
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
            startTime: Number(top.start_time),
            endTime: Number(top.end_time),
          },
          skipType: top.skip_type,
          skipId: top.skip_id,
          episodeLength: Number(top.episode_length),
        });
      }
    }
  } catch (err) {
    console.error('[v2] findSkipTimes error', err);
    return json(req, res, 500, {
      statusCode: 500,
      message: 'Internal server error',
    });
  }

  if (results.length === 0) {
    return json(req, res, 404, {
      statusCode: 404,
      message: 'No skip times found',
      found: false,
      results: [],
    });
  }

  return json(req, res, 200, {
    statusCode: 200,
    message: 'Successfully found skip times',
    found: true,
    results,
  });
}