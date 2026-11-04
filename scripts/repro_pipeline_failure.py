"""Reproduce the pipeline failure the frontend run found and read the reason.

Runs the same demand the frontend agent used, through the operator path, and
prints the stage error code that the Worker now keeps for every failed stage.
"""

from __future__ import annotations

import json
import pathlib
import sys
import time

import httpx

BASE = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"
DEMAND = (
    "采购 10 套 5MP 工业网络摄像机，要求像素不低于 5MP，防护等级 IP67，"
    "支持 PoE 供电，质保不少于 2 年，单价不超过 500 元/套。"
)


def main() -> int:
    token = pathlib.Path(".demo_access_token").read_text(encoding="utf-8").strip()
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(base_url=BASE, headers=headers, timeout=120) as client:
        created = client.post("/api/projects", json={"title": "复现：前端报告的流水线失败", "requirement_text": DEMAND})
        created.raise_for_status()
        project_id = created.json()["project_id"]
        revision = client.get(f"/api/projects/{project_id}").json()["demand_revision"]
        compile_start = client.post(f"/api/projects/{project_id}/requirement-compile")
        compile_start.raise_for_status()
        compile_id = compile_start.json()["compile_id"]
        for _ in range(60):
            state = client.get(f"/api/projects/{project_id}/requirement-compile/{compile_id}").json()
            if state.get("status") in {"COMPLETED", "FAILED"}:
                break
            time.sleep(10)
        print("compile:", state.get("status"), flush=True)
        started = client.post(
            f"/api/projects/{project_id}/pipeline",
            headers={"idempotency-key": f"repro-{project_id}"},
            json={"demand_revision": revision},
        )
        print("start:", started.status_code, started.text[:200], flush=True)
        pipeline_id = started.json()["pipeline_id"]
        for _ in range(180):
            snapshot = client.get(f"/api/projects/{project_id}/pipeline/{pipeline_id}").json()
            if snapshot.get("status") in {"COMPLETED", "PARTIAL", "FAILED"}:
                break
            time.sleep(15)
        print(json.dumps(snapshot, ensure_ascii=False, indent=1)[:2500])
        print("project:", project_id, "pipeline:", pipeline_id)
        return 0


if __name__ == "__main__":
    sys.exit(main())
