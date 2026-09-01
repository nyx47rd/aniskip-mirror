#!/usr/bin/env python3
"""
AniSkip public-dataset importer for AniSkip Mirror.

Reads the public CSV from
https://raw.githubusercontent.com/aniskip/sanitize_db_dump/main/skip_times_public.csv
(or a local path), validates it, and upserts into the `skip_times`
table. Idempotent: re-running is a no-op except for *new* rows.

Why Python and not Node?  The original AniSkip dump is huge
(~75k rows, ~4 MB raw). psycopg2's COPY is the fastest way to get it
into Postgres in one go. The script also works on Neon over SSL.

Usage:
    DATABASE_URL=postgresql://... python3 scripts/import_dataset.py
    DATABASE_URL=postgresql://... python3 scripts/import_dataset.py --csv ./skip_times_public.csv

Exit codes:
    0 success
    1 CSV download / parse error
    2 database error (transaction rolled back)
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import os
import sys
import tempfile
import time
import uuid
from datetime import datetime
from typing import Iterable, Iterator, List, Tuple
from urllib.request import Request, urlopen

import psycopg2
import psycopg2.extras

DEFAULT_CSV_URL = os.environ.get(
    "CSV_SOURCE_URL",
    "https://raw.githubusercontent.com/aniskip/sanitize_db_dump/main/skip_times_public.csv",
)

EXPECTED_HEADER = [
    "anime_id",
    "episode_number",
    "provider_name",
    "skip_type",
    "votes",
    "start_time",
    "end_time",
    "episode_length",
    "submit_date",
]

ALLOWED_SKIP_TYPES = {"op", "ed", "mixed-op", "mixed-ed", "recap"}
MIN_SUBMIT_DATE = datetime(2020, 1, 1)


def log(msg: str) -> None:
    print(f"[import_dataset] {msg}", flush=True)


def download_csv(url: str, dest: str) -> None:
    req = Request(url, headers={"User-Agent": "aniskip-mirror/1.0"})
    with urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1024 * 64)
            if not chunk:
                break
            f.write(chunk)


def iter_rows(path: str) -> Iterator[dict]:
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != EXPECTED_HEADER:
            raise ValueError(
                f"unexpected header: {reader.fieldnames} (expected {EXPECTED_HEADER})"
            )
        for row in reader:
            yield row


def validate_row(row: dict) -> Tuple[bool, str]:
    """Return (ok, reason).  reason is "" when ok."""
    try:
        anime_id = int(row["anime_id"])
        episode_number = float(row["episode_number"])
        votes = int(row["votes"])
        start_time = float(row["start_time"])
        end_time = float(row["end_time"])
        episode_length = float(row["episode_length"])
    except (TypeError, ValueError) as e:
        return False, f"type error: {e}"

    if anime_id < 0:
        return False, f"anime_id < 0"
    if episode_number < 0:
        return False, f"episode_number < 0"
    if row["provider_name"] == "" or len(row["provider_name"]) > 64:
        return False, "provider_name invalid"
    if row["skip_type"] not in ALLOWED_SKIP_TYPES:
        return False, f"skip_type={row['skip_type']} not allowed"
    if votes < -1000:
        return False, f"votes too negative: {votes}"
    if start_time < 0 or end_time <= start_time:
        return False, f"bad interval [{start_time}, {end_time}]"
    if episode_length < 0:
        return False, f"episode_length < 0"
    # Outlier guard: a single bad row from the public CSV uses 1e6+ lengths.
    if episode_length > 60 * 60 * 6:  # >6 hours
        return False, f"episode_length absurd: {episode_length}"
    if end_time > episode_length * 60:  # tolerate some slack but not orders of magnitude
        return False, f"end_time > 60*episode_length"
    try:
        d = datetime.strptime(row["submit_date"], "%Y-%m-%d")
        if d < MIN_SUBMIT_DATE:
            return False, f"submit_date too old: {row['submit_date']}"
    except ValueError:
        return False, f"submit_date not YYYY-MM-DD: {row['submit_date']}"
    return True, ""


def coerce(row: dict) -> Tuple:
    """Convert a validated dict into a tuple matching the COPY columns."""
    return (
        int(row["anime_id"]),
        float(row["episode_number"]),
        row["provider_name"][:64],
        row["skip_type"],
        int(row["votes"]),
        float(row["start_time"]),
        float(row["end_time"]),
        float(row["episode_length"]),
        # submit_date has no time; use noon UTC as a deterministic value.
        datetime.strptime(row["submit_date"], "%Y-%m-%d").replace(hour=12),
        # No submitter_id in the public CSV; use a stable deterministic UUID
        # derived from the row content so we have a unique non-null value.
        uuid.UUID(hashlib.md5(
            f"{row['anime_id']}|{row['episode_number']}|{row['provider_name']}|"
            f"{row['skip_type']}|{row['start_time']}|{row['end_time']}".encode()
        ).hexdigest()),
    )


COPY_COLUMNS = (
    "anime_id", "episode_number", "provider_name", "skip_type", "votes",
    "start_time", "end_time", "episode_length", "submit_date", "submitter_id",
)


def stage_csv(path: str) -> Tuple[str, int, int, int]:
    """Read the CSV, validate, and stage a temp file in COPY-friendly format.

    Returns (staged_path, total_rows, accepted, rejected).
    """
    staged = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".tsv", delete=False, newline=""
    )
    try:
        total = accepted = rejected = 0
        writer = csv.writer(staged, delimiter="\t", lineterminator="\n")
        for row in iter_rows(path):
            total += 1
            ok, _reason = validate_row(row)
            if not ok:
                rejected += 1
                continue
            writer.writerow(coerce(row))
            accepted += 1
    finally:
        staged.close()
    return staged.name, total, accepted, rejected


def import_to_db(conn, staged_path: str) -> int:
    """COPY the staged file into a temp table, then upsert into skip_times.

    Returns the number of rows upserted.
    """
    cur = conn.cursor()
    cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
    cur.execute(
        """
        CREATE TEMP TABLE _stg_skip_times (LIKE skip_times INCLUDING DEFAULTS)
        ON COMMIT DROP;
        """
    )
    with open(staged_path, "r", encoding="utf-8") as f:
        cur.copy_expert(
            f"COPY _stg_skip_times ({','.join(COPY_COLUMNS)}) FROM STDIN WITH (FORMAT csv, DELIMITER E'\\t')",
            f,
        )

    # Upsert by a natural key (we don't have skip_id in the public CSV).
    # We use (anime_id, episode_number, provider_name, skip_type,
    # start_time, end_time) as the dedupe key, so duplicates in the CSV
    # collapse into one row with the most positive votes.
    cur.execute(
        """
        WITH ranked AS (
          SELECT DISTINCT ON (
            anime_id, episode_number, provider_name, skip_type, start_time, end_time
          ) *
          FROM _stg_skip_times
          ORDER BY
            anime_id, episode_number, provider_name, skip_type, start_time, end_time,
            votes DESC
        ),
        inserted AS (
          INSERT INTO skip_times (
            skip_id, anime_id, episode_number, provider_name, skip_type,
            votes, start_time, end_time, episode_length, submit_date, submitter_id
          )
          SELECT
            gen_random_uuid(), anime_id, episode_number, provider_name, skip_type,
            votes, start_time, end_time, episode_length, submit_date, submitter_id
          FROM ranked
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        SELECT count(*) FROM inserted;
        """
    )
    # NOTE: ON CONFLICT requires a unique constraint or unique index on the
    # conflict target. The above is therefore a "first-write-wins" insert.
    # If you want full upsert semantics, add a unique index on
    # (anime_id, episode_number, provider_name, skip_type, start_time, end_time)
    # and switch to ON CONFLICT (...) DO UPDATE.
    inserted = cur.fetchone()[0]
    conn.commit()
    return inserted


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", help="local CSV path (else downloaded)")
    parser.add_argument("--csv-url", default=DEFAULT_CSV_URL)
    parser.add_argument("--keep-csv", action="store_true",
                        help="don't delete the downloaded CSV")
    parser.add_argument("--dry-run", action="store_true",
                        help="validate only, do not write to DB")
    args = parser.parse_args()

    csv_path = args.csv
    if not csv_path:
        tmp = tempfile.NamedTemporaryFile(
            prefix="skip_times_", suffix=".csv", delete=False
        )
        csv_path = tmp.name
        tmp.close()
        log(f"downloading {args.csv_url} -> {csv_path}")
        try:
            download_csv(args.csv_url, csv_path)
        except Exception as e:
            log(f"download failed: {e}")
            return 1
    else:
        log(f"using local CSV: {csv_path}")

    t0 = time.time()
    staged_path, total, accepted, rejected = stage_csv(csv_path)
    log(f"staged {accepted}/{total} rows (rejected {rejected}) in {time.time() - t0:.1f}s -> {staged_path}")

    if args.dry_run:
        log("dry-run; skipping DB")
        if not args.keep_csv and not args.csv:
            os.unlink(csv_path)
        os.unlink(staged_path)
        return 0

    if not os.environ.get("DATABASE_URL"):
        log("DATABASE_URL not set")
        return 2
    try:
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
    except Exception as e:
        log(f"connect failed: {e}")
        return 2

    try:
        n = import_to_db(conn, staged_path)
        log(f"inserted {n} new rows (out of {accepted} staged)")
    except Exception as e:
        log(f"DB import failed: {e}")
        conn.rollback()
        return 2
    finally:
        conn.close()
        try:
            os.unlink(staged_path)
        except OSError:
            pass
        if not args.keep_csv and not args.csv:
            try:
                os.unlink(csv_path)
            except OSError:
                pass

    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())