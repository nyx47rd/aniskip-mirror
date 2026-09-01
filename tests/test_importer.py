#!/usr/bin/env python3
"""Tests for the CSV importer's validation logic.

These don't need a database - they exercise validate_row() directly.
"""
from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from import_dataset import validate_row


def ok(row):
    valid, reason = validate_row(row)
    assert valid, f"expected valid, got {reason}"
    return row


def bad(row, contains=None):
    valid, reason = validate_row(row)
    assert not valid, f"expected invalid, got ok"
    if contains:
        assert contains in reason, f"{reason!r} doesn't contain {contains!r}"


BASE = {
    "anime_id": "1",
    "episode_number": "1",
    "provider_name": "Crunchyroll",
    "skip_type": "op",
    "votes": "10",
    "start_time": "90",
    "end_time": "180",
    "episode_length": "1440",
    "submit_date": "2024-05-01",
}


def test_ok():
    ok(BASE)


def test_ok_mixed_op():
    r = {**BASE, "skip_type": "mixed-op"}
    ok(r)


def test_bad_anime_id():
    bad({**BASE, "anime_id": "-1"}, contains="anime_id")


def test_bad_skip_type():
    bad({**BASE, "skip_type": "intro"}, contains="skip_type")


def test_bad_interval():
    bad({**BASE, "start_time": "200", "end_time": "180"}, contains="interval")


def test_bad_episode_length():
    bad({**BASE, "episode_length": "-1"}, contains="episode_length")


def test_bad_submit_date():
    bad({**BASE, "submit_date": "01/05/2024"}, contains="submit_date")


def test_outlier_episode_length():
    bad({**BASE, "episode_length": "99999999"}, contains="episode_length")


def test_provider_name_too_long():
    bad({**BASE, "provider_name": "x" * 100}, contains="provider_name")