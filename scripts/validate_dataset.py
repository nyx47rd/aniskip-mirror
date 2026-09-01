#!/usr/bin/env python3
"""
Quick schema-validation tool: connects to the DB, lists tables, and
checks that the skip_times table exists and has the expected columns.

Usage:  DATABASE_URL=... python3 scripts/validate_dataset.py
"""
from __future__ import annotations

import os
import sys

import psycopg2

EXPECTED = {
    "skip_id": "uuid",
    "anime_id": "integer",
    "episode_number": "real",
    "provider_name": "character varying",
    "skip_type": "character varying",
    "votes": "integer",
    "start_time": "real",
    "end_time": "real",
    "episode_length": "real",
    "submit_date": "timestamp without time zone",
    "submitter_id": "uuid",
}


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2
    with psycopg2.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_name = 'skip_times' ORDER BY ordinal_position;"
            )
            rows = cur.fetchall()
            if not rows:
                print("skip_times table missing", file=sys.stderr)
                return 1
            cols = {name: dtype for name, dtype in rows}
            missing = set(EXPECTED) - set(cols)
            if missing:
                print(f"missing columns: {missing}", file=sys.stderr)
                return 1
            print("ok: skip_times columns present")
            cur.execute("SELECT count(*) FROM skip_times;")
            (n,) = cur.fetchone()
            print(f"rows: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())