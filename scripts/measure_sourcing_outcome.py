"""Start one analysis for an existing project and report the sourcing outcome.

Usage: uv run --python 3.11 python scripts/measure_sourcing_outcome.py <project_id>
It uses the public gateway with the operator credential and only reads.
"""

from __future__ import annotations

import json
import pathlib
import sys
import time

import httpx

BASE = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: measure_sourcing_outcome.py <project_id>")
    project_id = sys.argv[1]
    token = pathlib.Path(".demo_access_token").read_text(encoding="utf-8").strip()
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(base_url=BASE, headers=headers, timeout=60) as client:
        project = client.get(f"/api/projects/{project_id}").json()
        revision = project.get("demand_revision")
        started = client.post(
            f"/api/projects/{project_id}/pipeline",
            headers={"idempotency-key": f"measure-{project_id}-{revision}"},
            json={"demand_revision": revision},
        )
        print("start:", started.status_code, started.text[:200])
        started.raise_for_status()
        pipeline_id = started.json()["pipeline_id"]
        for _ in range(90):
            snapshot = client.get(f"/api/projects/{project_id}/pipeline/{pipeline_id}").json()
            print(
                "  status:", snapshot.get("status"), "stage:", snapshot.get("stage"),
                "models:", snapshot.get("models_found"), "candidates:", snapshot.get("candidates_found"),
                "report:", snapshot.get("report_status"), flush=True,
            )
            if snapshot.get("status") in {"COMPLETED", "PARTIAL", "FAILED"}:
                break
            time.sleep(20)
        analysis = client.get(f"/api/projects/{project_id}/analysis", params={"pipeline_id": pipeline_id})
        if analysis.status_code != 200:
            print("analysis:", analysis.status_code, analysis.text[:200])
            return 1
        payload = analysis.json()
        print(json.dumps(payload.get("summary"), ensure_ascii=False, indent=2))
        return 0


if __name__ == "__main__":
    sys.exit(main())
