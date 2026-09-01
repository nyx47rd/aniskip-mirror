#!/usr/bin/env python3
"""Populate R2 bucket from Neon with one JSON file per anime.

Each file is keyed at v1/<animeId>.json and v2/<animeId>.json and stores
all (episode, skip_type) entries for that anime in a nested map. This
collapses 75k per-type files into ~5k per-anime files, sidestepping R2's
concurrent-PUT rate limit on the same key prefix.

Per-anime files also lets us upload with high concurrency (different keys,
no contention).

Usage:
  source /tmp/r2.env
  source /tmp/db_url.env
  python3 populate_r2_per_anime.py
"""
import os
import sys
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import psycopg2
import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

CONCURRENCY = 8
BATCH = 2000

V2_TYPES = {"op", "ed", "mixed-op", "mixed-ed", "recap"}


def main():
    db_url = os.environ["DATABASE_URL"]
    endpoint = os.environ["R2_ENDPOINT"]
    bucket = os.environ["R2_BUCKET"]
    ak = os.environ["R2_ACCESS_KEY_ID"]
    sk = os.environ["R2_SECRET_ACCESS_KEY"]

    print(f"[init] connecting to Neon…", flush=True)
    conn = psycopg2.connect(db_url, connect_timeout=10)
    conn.autocommit = False
    cur = conn.cursor(name="populate_r2_cursor")
    cur.itersize = BATCH * 4

    print(f"[init] creating S3 client for {endpoint}…", flush=True)
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=ak,
        aws_secret_access_key=sk,
        config=BotoConfig(
            signature_version="s3v4",
            retries={"max_attempts": 5, "mode": "adaptive"},
            connect_timeout=10,
            read_timeout=30,
        ),
        region_name="auto",
    )

    print("[init] reading all rows (server-side cursor)…", flush=True)
    cur.execute(
        "SELECT anime_id, episode_number, skip_type, start_time, end_time, episode_length "
        "FROM skip_times WHERE votes > -2 "
        "ORDER BY anime_id, episode_number, skip_type"
    )

    started = time.time()
    animes_v1 = {}  # anime_id -> { ep_str -> { type: { start, end, length } } }
    animes_v2 = {}
    anime_lock = threading.Lock()
    total_rows = 0
    last_print = time.time()

    def put_anime(anime_id, data_v1, data_v2):
        if not data_v1:
            return "skip"
        body_v1 = json.dumps(data_v1, separators=(",", ":"))
        body_v2 = json.dumps(data_v2, separators=(",", ":"))
        last_err = None
        for attempt in range(4):
            try:
                s3.put_object(
                    Bucket=bucket, Key=f"v1/{anime_id}.json",
                    Body=body_v1.encode("utf-8"),
                    ContentType="application/json",
                )
                s3.put_object(
                    Bucket=bucket, Key=f"v2/{anime_id}.json",
                    Body=body_v2.encode("utf-8"),
                    ContentType="application/json",
                )
                return "ok"
            except ClientError as exc:
                last_err = exc
                code = exc.response.get("Error", {}).get("Code", "")
                wait = 0.2 * (2 ** attempt)
                if code in ("SlowDown", "ServiceUnavailable", "InternalError", "RequestTimeout"):
                    time.sleep(wait)
                    continue
                break
        print(f"[err] {anime_id}: {last_err}", flush=True)
        return "err"

    pending = []  # list of (anime_id, v1_data, v2_data)
    pool = ThreadPoolExecutor(max_workers=CONCURRENCY)
    in_flight = []

    def flush():
        nonlocal in_flight
        new_in_flight = []
        for f in as_completed(in_flight):
            r = f.result()
            stats[r] = stats.get(r, 0) + 1
        in_flight = new_in_flight

    stats = {"ok": 0, "err": 0, "skip": 0}

    def submit(anime_id, v1, v2):
        in_flight.append(pool.submit(put_anime, anime_id, v1, v2))

    try:
        for row in cur:
            anime_id, ep, t, st, e, length = row
            if t not in V2_TYPES:
                continue
            ep_str = str(ep)
            v1 = animes_v1.setdefault(anime_id, {})
            v2 = animes_v2.setdefault(anime_id, {})
            v1_ep = v1.setdefault(ep_str, {})
            v2_ep = v2.setdefault(ep_str, {})
            v1_ep[t] = {"start": float(st), "end": float(e), "length": float(length)}
            v2_ep[t] = {"start": float(st), "end": float(e), "length": float(length)}
            total_rows += 1

            if len(in_flight) >= CONCURRENCY * 2:
                done = []
                for f in as_completed(in_flight):
                    done.append(f.result())
                in_flight.clear()
                for r in done:
                    stats[r] = stats.get(r, 0) + 1

            now = time.time()
            if now - last_print > 5:
                elapsed = now - started
                rate = total_rows / elapsed
                eta = (75644 - total_rows) / rate if rate > 0 else 0
                print(
                    f"[scan] rows={total_rows} animes={len(animes_v1)} "
                    f"put_ok={stats['ok']} put_err={stats['err']} "
                    f"{rate:.0f}/s elapsed={elapsed:.0f}s eta={eta:.0f}s",
                    flush=True,
                )
                last_print = now

        # Submit remaining animes
        for anime_id, v1 in animes_v1.items():
            submit(anime_id, v1, animes_v2[anime_id])

        for f in as_completed(in_flight):
            r = f.result()
            stats[r] = stats.get(r, 0) + 1

    finally:
        pool.shutdown(wait=True)
        cur.close()
        conn.close()

    elapsed = time.time() - started
    print(
        f"\n[done] animes={len(animes_v1)} rows={total_rows} "
        f"put_ok={stats['ok']} put_err={stats['err']} "
        f"elapsed={elapsed:.1f}s rate={stats['ok']/elapsed:.1f}/s",
        flush=True,
    )


if __name__ == "__main__":
    main()
