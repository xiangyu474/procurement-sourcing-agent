"""Measure how often the same demand ends in a usable conclusion.

Runs the official-case demand N times through the operator path and reports
the verdict distribution of every run. The point is not one run but how often
the research lands on a source that states the measurement.

Usage: uv run --python 3.11 python scripts/measure_verdict_stability.py [runs]
"""

from __future__ import annotations

import collections
import json
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

BASE = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"
DEMAND = "采购5MP工业网络摄像机，数量10套，预计单价100元/套，输出分辨率不低于5MP。"


def run_once(client: httpx.Client, index: int) -> dict[str, object]:
    created = client.post("/api/projects", json={"title": f"判定稳定性测量 {index}", "requirement_text": DEMAND})
    created.raise_for_status()
    project_id = created.json()["project_id"]
    revision = client.get(f"/api/projects/{project_id}").json()["demand_revision"]
    compile_start = client.post(f"/api/projects/{project_id}/requirement-compile")
    compile_start.raise_for_status()
    compile_id = compile_start.json()["compile_id"]
    state: dict[str, object] = {}
    for _ in range(60):
        state = client.get(f"/api/projects/{project_id}/requirement-compile/{compile_id}").json()
        if state.get("status") in {"COMPLETED", "FAILED"}:
            break
        time.sleep(10)
    if state.get("status") != "COMPLETED":
        return {"project_id": project_id, "compile": state.get("status"), "verdicts": {}}
    started = client.post(
        f"/api/projects/{project_id}/pipeline",
        headers={"idempotency-key": f"stability-{project_id}"},
        json={"demand_revision": revision},
    )
    started.raise_for_status()
    pipeline_id = started.json()["pipeline_id"]
    snapshot: dict[str, object] = {}
    for _ in range(120):
        snapshot = client.get(f"/api/projects/{project_id}/pipeline/{pipeline_id}").json()
        if snapshot.get("status") in {"COMPLETED", "PARTIAL", "FAILED"}:
            break
        time.sleep(15)
    if snapshot.get("status") == "FAILED":
        stages = snapshot.get("stages") or []
        reason = next((row.get("error_code") for row in stages if row.get("error_code")), "unknown")
        return {"project_id": project_id, "pipeline_id": pipeline_id, "status": "FAILED", "reason": reason, "verdicts": {}}
    analysis = client.get(f"/api/projects/{project_id}/analysis", params={"pipeline_id": pipeline_id}).json()
    summary = analysis.get("summary") or {}
    return {
        "project_id": project_id,
        "pipeline_id": pipeline_id,
        "status": snapshot.get("status"),
        "research": analysis.get("research_status"),
        "verdicts": summary.get("by_verdict"),
        "recommendations": summary.get("by_recommendation"),
        "models": [row.get("product_model") for row in summary.get("models") or []],
        "evidence": summary.get("evidence"),
    }


def main() -> int:
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    token = pathlib.Path(".demo_access_token").read_text(encoding="utf-8").strip()

    def one(index: int) -> dict[str, object]:
        with httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, timeout=120) as client:
            outcome = run_once(client, index)
        print(json.dumps(outcome, ensure_ascii=False), flush=True)
        return outcome

    # The runs are independent, so they are started together: three samples
    # take one run's time instead of three.
    with ThreadPoolExecutor(max_workers=max(1, runs)) as pool:
        results = list(pool.map(one, range(1, runs + 1)))
    totals: collections.Counter[str] = collections.Counter()
    for outcome in results:
        for verdict, count in (outcome.get("verdicts") or {}).items():
            totals[verdict] += int(count)
    print("totals:", dict(totals), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
