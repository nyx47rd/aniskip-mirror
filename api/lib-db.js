// Shared database client for Vercel functions.
//
// Uses Neon's serverless driver when DATABASE_URL looks like a Neon URL
// (neon.tech / neon.tech with @neondatabase/serverless), otherwise falls
// back to the standard `pg` Pool which works on Neon over SSL too.
//
// The pool is created lazily and reused across invocations inside the
// same Lambda container.
const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  _pool = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  return _pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function pingDb() {
  const r = await query('SELECT 1 AS ok');
  return r.rows[0]?.ok === 1;
}

// The exact SQL used by the official AniSkip API to find skip times.
// Kept here so v1 and v2 stay in lockstep.
const FIND_SKIP_TIMES_SQL = `
  SELECT skip_id, start_time, skip_type, end_time, episode_length
  FROM   skip_times
  WHERE  anime_id = $1::integer
    AND  episode_number = $2::real
    AND  skip_type = $3::varchar
    AND  votes > -2
    AND  ($4::real = 0 OR ABS(episode_length - $4::real) <= 20)
  ORDER BY votes DESC
  LIMIT 10;
`;

async function findSkipTimes({ animeId, episodeNumber, skipType, episodeLength = 0 }) {
  const { rows } = await query(FIND_SKIP_TIMES_SQL, [
    animeId,
    episodeNumber,
    skipType,
    episodeLength,
  ]);
  return rows;
}
module.exports = { getPool, query, pingDb, findSkipTimes, FIND_SKIP_TIMES_SQL };
