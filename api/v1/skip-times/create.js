const {json, handleOptions, applyCors} = require('../../../lib-http.js');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  return json(req, res, 403, {
    message:
      'Read-only mirror: skip-time submissions are disabled. Configure ALLOW_WRITES=true to enable.',
  });
}