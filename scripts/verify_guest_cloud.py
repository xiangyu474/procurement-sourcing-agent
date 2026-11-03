"""Cloud acceptance for the guest session: isolation plus one visitor demo run.

Usage: uv run --python 3.11 python scripts/verify_guest_cloud.py
It uses the public Worker only. Two independent visitor sessions are created;
neither may read the other's project. One visitor then runs the complete demo
chain: demand, compile, one-click analysis, analysis result and report download.
"""

from __future__ import annotations

import json
import sys
import time

import httpx

BASE = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"
ORIGIN = BASE
DEMAND = "采购5MP工业网络摄像机，数量10套，预计单价100元/套，输出分辨率不低于5MP。"


def new_session(client: httpx.Client) -> httpx.Client:
    response = client.post("/api/session", headers={"origin": ORIGIN})
    if response.status_code not in (200, 201):
        raise SystemExit(f"session creation failed: {response.status_code} {response.text[:200]}")
    cookie = response.headers.get("set-cookie", "").split(";")[0]
    if not cookie.startswith("__Host-ps_session="):
        raise SystemExit("the session cookie was not set")
    return httpx.Client(base_url=BASE, headers={"cookie": cookie, "origin": ORIGIN}, timeout=60)


def main() -> int:
    failures: list[str] = []
    with httpx.Client(base_url=BASE, timeout=30) as plain:
        if plain.get("/api/projects").status_code != 401:
            failures.append("a request without a session was not rejected")
        if plain.post("/api/session").status_code != 403:
            failures.append("a session request without an Origin was not rejected")
        if plain.post("/api/session", headers={"origin": "https://elsewhere.test"}).status_code != 403:
            failures.append("a session request from another origin was not rejected")
    with new_session(httpx.Client(base_url=BASE, timeout=30)) as a, new_session(httpx.Client(base_url=BASE, timeout=30)) as b:
        projects_a = a.get("/api/projects").json()["projects"]
        projects_b = b.get("/api/projects").json()["projects"]
        if [p["id"] for p in projects_a] != [p["id"] for p in projects_b]:
            failures.append("two visitors do not see the same project list")
        created = a.post("/api/projects", json={"title": "访客 A 的公开演示项目", "requirement_text": DEMAND})
        if created.status_code != 201:
            failures.append(f"the visitor could not create a project: {created.status_code} {created.text[:200]}")
            return report(failures, None)
        project_id = created.json()["project_id"]
        if b.get(f"/api/projects/{project_id}").status_code != 404:
            failures.append("the second visitor could read the first visitor's project")
        if b.get(f"/api/projects/{project_id}/analysis").status_code != 404:
            failures.append("the second visitor could read the first visitor's analysis")
        if b.get(f"/api/projects/{project_id}/runs").status_code != 404:
            failures.append("the second visitor could read the first visitor's runs")
        if b.get(f"/api/projects/{project_id}/reports").status_code != 404:
            failures.append("the second visitor could read the first visitor's reports")
        if a.get(f"/api/projects/{project_id}").status_code != 200:
            failures.append("the owner could not read their own project")
        detail = a.get(f"/api/projects/{project_id}").json()
        revision = detail.get("demand_revision")
        compile_start = a.post(f"/api/projects/{project_id}/requirement-compile")
        if compile_start.status_code != 202:
            failures.append(f"the visitor could not start the demand compile: {compile_start.status_code} {compile_start.text[:200]}")
            return report(failures, project_id)
        compile_id = compile_start.json()["compile_id"]
        compiled = False
        for _ in range(60):
            state = a.get(f"/api/projects/{project_id}/requirement-compile/{compile_id}").json()
            if state.get("status") in {"COMPLETED", "FAILED"}:
                compiled = state.get("status") == "COMPLETED"
                break
            time.sleep(10)
        if not compiled:
            failures.append("the demand compile did not finish for the visitor")
            return report(failures, project_id)
        requirements = a.get(f"/api/projects/{project_id}/requirements").json()
        if not (requirements.get("compilation") or {}).get("requirements"):
            failures.append("the visitor's demand produced no requirement")
            return report(failures, project_id)
        started = a.post(f"/api/projects/{project_id}/pipeline",
            headers={"idempotency-key": f"guest-demo-{project_id}"}, json={"demand_revision": revision})
        if started.status_code != 202:
            failures.append(f"the visitor could not start the analysis: {started.status_code} {started.text[:200]}")
            return report(failures, project_id)
        body = started.json()
        pipeline_id, run_id = body["pipeline_id"], body["run_id"]
        again = a.post(f"/api/projects/{project_id}/pipeline",
            headers={"idempotency-key": f"guest-demo-{project_id}"}, json={"demand_revision": revision})
        if again.status_code != 202 or again.json()["pipeline_id"] != pipeline_id:
            failures.append("a repeated start created a second task")
        finished = False
        for _ in range(150):
            snapshot = a.get(f"/api/projects/{project_id}/pipeline/{pipeline_id}").json()
            if snapshot.get("status") in {"COMPLETED", "PARTIAL", "FAILED"}:
                finished = snapshot.get("status") != "FAILED"
                if not finished:
                    failures.append(f"the visitor's analysis failed: {snapshot.get('stage')} {snapshot.get('error')}")
                break
            time.sleep(20)
        if not finished:
            failures.append("the visitor's analysis did not finish in time")
            return report(failures, project_id)
        analysis_response = a.get(f"/api/projects/{project_id}/analysis", params={"pipeline_id": pipeline_id})
        if analysis_response.status_code != 200:
            failures.append(f"the visitor could not read the analysis: {analysis_response.status_code}")
            return report(failures, project_id)
        # The report is written after the decision; wait for it before reading it.
        report_ready = False
        for _ in range(40):
            state = a.get(f"/api/projects/{project_id}/pipeline/{pipeline_id}").json()
            if state.get("report_status") == "COMPLETED":
                report_ready = True
                break
            if state.get("report_status") == "FAILED":
                failures.append(f"the report failed: {state.get('report_error_code')}")
                break
            time.sleep(15)
        if not report_ready:
            failures.append("the report did not finish in time")
            return report(failures, project_id)
        analysis = a.get(f"/api/projects/{project_id}/analysis", params={"pipeline_id": pipeline_id}).json()
        payload = analysis
        if not payload.get("candidates") or not payload.get("assessments"):
            failures.append("the visitor's analysis has no candidate or assessment")
        if b.get(f"/api/projects/{project_id}/analysis", params={"pipeline_id": pipeline_id}).status_code != 404:
            failures.append("the second visitor could read the first visitor's frozen analysis")
        report_path = payload.get("report", {}).get("download_path")
        report_bytes = 0
        if report_path:
            download = a.get(report_path)
            if download.status_code == 200 and download.content.startswith(b"PK"):
                report_bytes = len(download.content)
            else:
                failures.append(f"the visitor could not download the report: {download.status_code}")
            if b.get(report_path).status_code != 404:
                failures.append("the second visitor could download the first visitor's report")
        else:
            failures.append("the visitor's report is not downloadable")
        summary = payload.get("summary") or {}
        return report(failures, project_id, {
            "project_id": project_id, "pipeline_id": pipeline_id, "run_id": run_id,
            "demand_revision": revision, "candidates": len(payload.get("candidates", [])),
            "assessments": len(payload.get("assessments", [])), "decisions": len(payload.get("decisions", [])),
            "decision_version": payload.get("decision_version"), "report_bytes": report_bytes,
            "summary": summary,
        })


def report(failures: list[str], project_id: str | None, extra: dict | None = None) -> int:
    print(json.dumps({"status": "PASS" if not failures else "FAIL", "failures": failures,
                      "project_id": project_id, **(extra or {})}, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
