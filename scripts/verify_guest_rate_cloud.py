"""Check D1's conditional fixed-window update under concurrent requests.

Uses a unique, synthetic scope, not the live global or per-IP counters. It
removes only its own row. This is a D1 concurrency check, not a guest-session,
provider-budget, or public-readiness acceptance.

Usage: uv run --python 3.11 python scripts/verify_guest_rate_cloud.py
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import subprocess
import uuid

DATABASE = "3a67c338-107f-4053-b678-109dd218773c"
CF = "cf.cmd" if os.name == "nt" else "cf"


def query(sql: str) -> list[dict]:
    completed = subprocess.run(
        [CF, "d1", "query", DATABASE, "--sql", sql],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"D1 request failed: {completed.stderr[:300]}")
    output = json.loads(completed.stdout)
    if not output or not all(item.get("success") for item in output):
        raise RuntimeError("D1 query failed")
    return output[0].get("results") or []


def main() -> int:
    scope = f"test:{uuid.uuid4().hex}"
    window = 987654321
    try:
        sql = (
            "INSERT INTO guest_session_creation_windows(scope,window_start,request_count) "
            f"VALUES ('{scope}',{window},1) "
            "ON CONFLICT(scope,window_start) DO UPDATE SET request_count=request_count+1 "
            "WHERE request_count<5 RETURNING request_count"
        )
        # Two simultaneous writers still exercise the atomic boundary while
        # avoiding unnecessary load on the shared production database.
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _i: query(sql), range(12)))
        granted = sum(bool(rows) for rows in responses)
        row = query(f"SELECT request_count FROM guest_session_creation_windows WHERE scope='{scope}' AND window_start={window}")
        assert granted == 5 and row and row[0]["request_count"] == 5, (granted, row)
        print("PASS: real D1 accepted exactly 5 of 12 conditional updates with two concurrent writers")
    finally:
        query(f"DELETE FROM guest_session_creation_windows WHERE scope='{scope}' AND window_start={window}")
        print("synthetic counter removed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
