// POST endpoints (create / vote) are intentionally disabled in the
// public read-only mirror. Clients that need to submit skip times
// should use the official AniSkip API. We still respond with a
// well-formed 403 so misconfigured clients fail predictably.
const {json, handleOptions, applyCors} = require('./lib-http.js');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  return json(req, res, 403, {
    statusCode: 403,
    message:
      'Read-only mirror: skip-time submissions are disabled. Configure ALLOW_WRITES=true to enable.',
  });
}