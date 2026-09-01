# Minimal local Node server. Mimics Vercel's routing for
# `api/health.js`, `api/v1/...`, `api/v2/...`. NOT used in production
# on Vercel - Vercel invokes the files directly as serverless
# functions.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const API_DIR = path.join(__dirname);

function fileFor(urlPath) {
  // /v1/skip-times/1/2 -> api/v1/skip-times/[anime_id]/[episode_number].js
  const parts = urlPath.split('/').filter(Boolean);
  const fileParts = [];
  for (const part of parts) {
    fileParts.push(part);
    const candidate = path.join(API_DIR, ...fileParts) + '.js';
    if (fs.existsSync(candidate)) return candidate;
    fileParts[fileParts.length - 1] = `[${part}]`;
  }
  return null;
}

http.createServer(async (req, res) => {
  const file = fileFor(req.url.split('?')[0]);
  if (!file) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Not found' }));
    return;
  }
  try {
    const mod = await import(file);
    const handler = mod.default || mod.handler;
    if (typeof handler !== 'function') throw new Error('no default export');
    await handler(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: 'Internal server error' }));
    }
  }
}).listen(PORT, () => console.log(`aniskip-mirror listening on :${PORT}`));