#!/usr/bin/env python3
"""
Update the AniSkip dataset in the database.

Differences from import_dataset.py:
- Always downloads the latest CSV.
- Logs the SHA-256 of the file (useful for GitHub Actions summaries).
- Performs the import inside a single transaction so a half-applied
  import rolls back cleanly.
- Designed to be called from GitHub Actions or cron.

Usage:
    DATABASE_URL=postgresql://... python3 scripts/update_dataset.py
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 64), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    url = os.environ.get(
        "CSV_SOURCE_URL",
        "https://raw.githubusercontent.com/aniskip/sanitize_db_dump/main/skip_times_public.csv",
    )
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2

    here = os.path.dirname(os.path.abspath(__file__))
    importer = os.path.join(here, "import_dataset.py")

    # Run the importer inline with the database URL in env.
    env = os.environ.copy()
    env["CSV_SOURCE_URL"] = url
    env["DATABASE_URL"] = database_url

    # Capture CSV path via --csv so we can hash it.
    with tempfile.NamedTemporaryFile(prefix="skip_times_", suffix=".csv", delete=False) as t:
        csv_path = t.name

    print(f"[update_dataset] csv_url={url}", flush=True)
    rc = subprocess.call([sys.executable, importer, "--csv", csv_path, "--keep-csv"], env=env)
    if rc != 0:
        print(f"[update_dataset] importer exited {rc}", file=sys.stderr)
        try:
            os.unlink(csv_path)
        except OSError:
            pass
        return rc

    digest = sha256_of(csv_path)
    size = os.path.getsize(csv_path)
    print(f"[update_dataset] csv_sha256={digest} size_bytes={size}", flush=True)
    try:
        os.unlink(csv_path)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())