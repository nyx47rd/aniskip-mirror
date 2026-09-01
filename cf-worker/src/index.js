// Cloudflare Worker that serves the AniSkip dataset from R2.
// Replaces the upstream AniSkip API endpoint shape 1:1 so clients
// can switch with a single base-URL change.
//
// Routes:
//   GET /v1/skip-times/:animeId/:episodeNumber?types=op,ed
//   GET /v2/skip-times/:animeId/:episodeNumber?types=op,ed
//   GET /v1/rules/:animeId
//   GET /v2/relation-rules/:animeId
//   GET /health
//
// Storage layout in R2 bucket `aniskip-mirror-data`:
//   v1/<animeId>.json
//   v2/<animeId>.json
//
// Each file is a per-anime map:
//   {
//     "<episodeNumber>": {
//       "<skipType>": { "start": <float>, "end": <float>, "length": <float> }
//     }
//   }
//
// All skip types for an anime are written in a single file so the R2
// upload phase is one PUT per anime (~5k files total instead of 75k).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function corsOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
    ...extraHeaders,
  };
  if (status === 200) {
    headers["Cache-Control"] = "public, s-maxage=604800, stale-while-revalidate=2592000";
  } else {
    headers["Cache-Control"] = "no-store";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// Cloudflare Cache API wrapper. We cache the *built* skip-times / rules
// responses keyed on (version, animeId, episodeNumber, types) so we
// don't hit R2 on every request. 404 responses are also cached briefly
// to absorb scanner traffic.
async function cached(request, ctx, key, ttl, builder) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await builder();
  if (res && res.status === 200 && ctx && ctx.waitUntil) {
    const cacheable = new Response(res.clone().body, {
      status: res.status,
      headers: {
        ...Object.fromEntries(res.headers),
        "Cache-Control": `public, s-maxage=${ttl}`,
      },
    });
    ctx.waitUntil(cache.put(request, cacheable));
  }
  return res;
}

function notFound(version) {
  if (version === "v2") {
    return jsonResponse(
      { statusCode: 404, message: "No skip times found", found: false, results: [] },
      404
    );
  }
  return jsonResponse({ found: false, results: [] }, 200);
}

function badRequest(message, version) {
  if (version === "v2") {
    return jsonResponse({ statusCode: 400, message }, 400);
  }
  return jsonResponse({ message }, 400);
}

const V1_TYPES = new Set(["op", "ed"]);
const V2_TYPES = new Set(["op", "ed", "mixed-op", "mixed-ed", "recap"]);

function parseTypes(raw, version) {
  const allowed = version === "v2" ? V2_TYPES : V1_TYPES;
  let arr;
  if (raw == null) arr = [];
  else if (Array.isArray(raw)) arr = raw;
  else arr = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  const uniq = [...new Set(arr)];
  for (const t of uniq) {
    if (!allowed.has(t)) {
      throw new Error(`invalid skip_type: ${t}`);
    }
  }
  if (uniq.length === 0) return ["op", "ed"];
  return uniq;
}

async function readAnime(bucket, version, animeId) {
  const key = `${version}/${animeId}.json`;
  const obj = await bucket.get(key);
  if (!obj) return null;
  const text = await obj.text();
  return JSON.parse(text);
}

function buildResults(animeData, episodeNumber, types, version) {
  const ep = animeData?.[String(episodeNumber)];
  if (!ep) return [];
  const out = [];
  for (const skipType of types) {
    const entry = ep[skipType];
    if (!entry) continue;
    if (version === "v2") {
      out.push({
        interval: { startTime: entry.start, endTime: entry.end },
        skipType,
        episodeLength: entry.length,
      });
    } else {
      out.push({
        interval: { start_time: entry.start, end_time: entry.end },
        skip_type: skipType,
        episode_length: entry.length,
      });
    }
  }
  return out;
}

async function handleSkipTimes(request, env, version) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const animeId = parts[2];
  const episodeNumber = parts[3];

  if (!animeId || !episodeNumber) {
    return badRequest("anime_id and episode_number are required", version);
  }
  if (!/^\d+$/.test(animeId) || Number(animeId) < 1) {
    return badRequest("anime_id must be a positive integer", version);
  }
  const epNum = Number(episodeNumber);
  if (!Number.isFinite(epNum) || epNum < 0) {
    return badRequest("episode_number must be a number >= 0", version);
  }

  let types;
  try {
    types = parseTypes(url.searchParams.get("types"), version);
  } catch (e) {
    return badRequest(e.message, version);
  }

  const animeData = await readAnime(env.DATA, version, animeId);
  if (!animeData) return notFound(version);

  const results = buildResults(animeData, episodeNumber, types, version);
  if (results.length === 0) return notFound(version);

  if (version === "v2") {
    return jsonResponse({
      statusCode: 200,
      message: "Successfully found skip times",
      found: true,
      results,
    });
  }
  return jsonResponse({ found: true, results });
}

async function handleHealth(env) {
  // We don't ping R2 on every health check; just report ok.
  return jsonResponse({
    status: "ok",
    service: "aniskip-mirror-cf",
    version: "1.0.0",
    backend: "cloudflare-r2",
    uptime_s: Math.round(Date.now() / 1000),
  });
}

async function handleRules(request, env, version) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const animeId = parts[2];
  if (!animeId || !/^\d+$/.test(animeId)) {
    return badRequest("anime_id must be a positive integer", version);
  }
  // Static rules file (optional). If not present, return empty.
  const key = `${version}-rules/${animeId}.json`;
  const obj = await env.DATA.get(key);
  const found = !!obj;
  let rules = [];
  if (obj) {
    const text = await obj.text();
    rules = JSON.parse(text);
  }
  if (version === "v2") {
    if (!found) {
      return jsonResponse({ statusCode: 404, message: "No relation rules found", found: false, rules: [] }, 404);
    }
    return jsonResponse({ statusCode: 200, message: "Successfully found relation rules", found: true, rules });
  }
  return jsonResponse({ found, rules });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return corsOptions();
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/health" || path === "/health/") return handleHealth(env);
      if (path.startsWith("/v1/skip-times/")) {
        return await cached(request, ctx, "v1-skip", 604800, () =>
          handleSkipTimes(request, env, "v1")
        );
      }
      if (path.startsWith("/v2/skip-times/")) {
        return await cached(request, ctx, "v2-skip", 604800, () =>
          handleSkipTimes(request, env, "v2")
        );
      }
      if (path.startsWith("/v1/rules/")) {
        return await cached(request, ctx, "v1-rules", 604800, () =>
          handleRules(request, env, "v1")
        );
      }
      if (path.startsWith("/v2/relation-rules/")) {
        return await cached(request, ctx, "v2-rules", 604800, () =>
          handleRules(request, env, "v2")
        );
      }
      return jsonResponse({ message: "Not found" }, 404);
    } catch (err) {
      console.error("worker error", err);
      return jsonResponse({ message: "Internal server error" }, 500);
    }
  },
};
