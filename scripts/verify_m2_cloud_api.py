"""Authenticated post-deploy M2 acceptance for bounded real sourcing runs.

Reads the bearer token from the ignored local .demo_access_token file and never
prints it. Each run is capped at four Tavily searches, four fetches, two
researcher tasks and two plan revisions. Use only after migration 0005 and the
M2 Container image have been deployed.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

DEFAULT_BASE_URL = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"
DEMAND = (
    "寻找工业网络摄像机，要求图像分辨率至少 5MP；请发现潜在供应商和可追溯的具体产品型号，"
    "不指定采购区域。"
)
BUDGET = {
    "max_search_calls": 4,
    "max_fetches": 4,
    "max_tasks": 2,
    "max_rounds": 2,
    "max_model_calls": 15,
}


def _request(client: httpx.Client, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    response = client.request(method, path, **kwargs)
    if not response.is_success:
        raise RuntimeError(f"M2 API {method} {path} returned HTTP {response.status_code}")
    if response.headers.get("content-type", "").startswith("application/json"):
        return response.json()
    raise RuntimeError(f"M2 API {method} {path} did not return JSON")


def _create_compiled_project(client: httpx.Client, title: str) -> str:
    created = _request(
        client,
        "POST",
        "/api/projects",
        json={"title": title, "requirement_text": DEMAND},
    )
    project_id = str(created["project_id"])
    _request(client, "POST", f"/api/projects/{project_id}/requirement-compile")
    readback = _request(client, "GET", f"/api/projects/{project_id}/requirements")
    if not readback.get("compilation", {}).get("requirements"):
        raise RuntimeError("text demand did not compile into a structured Requirement")
    return project_id


def _run_project(client: httpx.Client, project_id: str, label: str) -> dict[str, Any]:
    started = _request(
        client,
        "POST",
        f"/api/projects/{project_id}/runs",
        json={
            "mode": "SOURCING",
            "idempotency_key": f"m2-acceptance-{label}-{time.time_ns()}",
            "research_budget": BUDGET,
        },
    )
    run_id = str(started["run_id"])
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        run = _request(client, "GET", f"/api/runs/{run_id}")
        if run.get("status") in {"COMPLETED", "PARTIAL", "FAILED"}:
            break
        time.sleep(3)
    else:
        raise RuntimeError(f"run {label} exceeded the 15-minute M2 acceptance timeout")
    if run.get("status") == "FAILED":
        raise RuntimeError(
            f"run {label} failed: {run.get('last_error') or 'no structured error reason stored'}; "
            "inspect the associated LangSmith project trace and Cloudflare run events"
        )
    research = _request(client, "GET", f"/api/runs/{run_id}/research")
    candidates_response = _request(client, "GET", f"/api/projects/{project_id}/candidates", params={"run_id": run_id})
    candidates = candidates_response.get("candidates", [])
    return {
        "label": label,
        "project_id": project_id,
        "run_id": run_id,
        "status": run.get("status"),
        "research": research,
        "candidates": candidates,
    }


def _verify_first_run(client: httpx.Client, result: dict[str, Any]) -> None:
    research = result["research"]
    candidates = result["candidates"]
    metrics = research.get("metrics", {})
    if not candidates or not metrics.get("candidate_count"):
        raise RuntimeError(
            "cold start produced no persisted Longlist candidate; "
            f"status={metrics.get('status')}, stop_reason={metrics.get('stop_reason_code')}, metrics={json.dumps(metrics, ensure_ascii=True)}"
        )
    if metrics.get("search_calls", 0) > BUDGET["max_search_calls"] or metrics.get("fetch_calls", 0) > BUDGET["max_fetches"]:
        raise RuntimeError("run exceeded its shared Tavily budget")
    if metrics.get("researcher_tasks", 0) > BUDGET["max_tasks"]:
        raise RuntimeError("run exceeded the configured researcher task cap")
    if metrics.get("model_calls", 0) > BUDGET["max_model_calls"]:
        raise RuntimeError("run exceeded the shared model-call budget")
    if not metrics.get("langsmith_tracing_enabled") or not metrics.get("trace_run_ids", {}).get("SUPERVISOR"):
        raise RuntimeError("LangSmith tracing or the Supervisor trace ID was not recorded")
    plan = research.get("plan") or {}
    if plan.get("target_markets"):
        raise RuntimeError("research plan invented a target market that was not in the demand")
    if any(candidate.get("stage") != "DISCOVERED_LONG_LIST" for candidate in candidates):
        raise RuntimeError("M2 improperly promoted a candidate beyond the discovery Longlist")
    identity_keys = [
        (candidate.get("supplier", {}).get("supplier_id"), (candidate.get("product") or {}).get("product_id"))
        for candidate in candidates
    ]
    if len(identity_keys) != len(set(identity_keys)):
        raise RuntimeError("duplicate supplier/product ProjectCandidate rows were returned")
    if not any(candidate.get("product", {}).get("model") for candidate in candidates if candidate.get("product")):
        raise RuntimeError("cold start produced no evidence-backed exact product model")

    evidence_cache: dict[str, str] = {}
    findings = [task.get("findings") for task in research.get("tasks", []) if task.get("findings")]
    for finding in findings:
        for candidate in finding.get("candidate_claims", []):
            for claim in [*candidate.get("supplier_claims", []), *candidate.get("product_claims", [])]:
                evidence_id = claim.get("evidence_id")
                quote = claim.get("source_quote")
                if not evidence_id or not quote:
                    raise RuntimeError("a claim was persisted without its evidence ID or quote")
                if evidence_id not in evidence_cache:
                    evidence = _request(client, "GET", f"/api/evidence/{evidence_id}").get("evidence", {})
                    snapshot = evidence.get("snapshot_text", "")
                    actual_hash = hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
                    if actual_hash != evidence.get("content_sha256"):
                        raise RuntimeError("R2 source snapshot hash does not match D1 evidence metadata")
                    evidence_cache[evidence_id] = snapshot
                if " ".join(quote.split()).casefold() not in " ".join(evidence_cache[evidence_id].split()).casefold():
                    raise RuntimeError("persisted claim quote is not present in its R2 source snapshot")


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    token_path = Path(os.getenv("DEMO_ACCESS_TOKEN_FILE", str(repo / ".demo_access_token")))
    if not token_path.exists():
        raise SystemExit("Missing ignored local .demo_access_token file; refusing to print or request without it.")
    token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("Local demo token file is empty.")
    base_url = os.getenv("PROCUREMENT_AGENT_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    headers = {"authorization": f"Bearer {token}"}

    with httpx.Client(base_url=base_url, headers=headers, timeout=httpx.Timeout(60)) as client:
        # 1. Cold-start public research and exact evidence/source-snapshot checks.
        cold_project = _create_compiled_project(client, "M2 cold-start acceptance")
        cold = _run_project(client, cold_project, "cold")
        _verify_first_run(client, cold)

        # 2. Same-project repeat: require an explicit reuse or refresh decision.
        repeat = _run_project(client, cold_project, "repeat")
        repeat_plan = repeat["research"].get("plan") or {}
        all_project_candidates = _request(client, "GET", f"/api/projects/{cold_project}/candidates").get("candidates", [])
        all_candidate_ids = [candidate.get("candidate_id") for candidate in all_project_candidates]
        if len(all_candidate_ids) != len(set(all_candidate_ids)):
            raise RuntimeError("repeat run created duplicate project candidate rows")
        repeat_decisions = {
            "reused": repeat_plan.get("reuse_intelligence_ids", []),
            "refreshed": repeat_plan.get("refresh_intelligence_ids", []),
            "ignored": repeat_plan.get("ignored_intelligence_ids", []),
        }
        if not any(repeat_decisions.values()):
            raise RuntimeError("same-demand rerun did not explain reuse, refresh, or ignore decisions")

        # 3. Similar demand in a different project: prior public intelligence may
        # seed a new project candidate but must not transfer the old decision.
        other_project = _create_compiled_project(client, "M2 cross-project reuse acceptance")
        cross = _run_project(client, other_project, "cross-project")
        first_product_ids = {
            candidate.get("product", {}).get("product_id")
            for candidate in cold["candidates"] if candidate.get("product")
        }
        cross_product_ids = {
            candidate.get("product", {}).get("product_id")
            for candidate in cross["candidates"] if candidate.get("product")
        }
        cross_decisions = cross["research"].get("plan") or {}
        if not first_product_ids.intersection(cross_product_ids) and not cross_decisions.get("reuse_intelligence_ids"):
            raise RuntimeError("different project did not reuse a prior public product lead")
        if {candidate["candidate_id"] for candidate in cold["candidates"]} & {
            candidate["candidate_id"] for candidate in cross["candidates"]
        }:
            raise RuntimeError("different projects unexpectedly share project-specific candidate IDs")

    summary = {
        "status": "PASS",
        "cold_start": {
            "project_id": cold["project_id"],
            "run_id": cold["run_id"],
            "candidate_count": len(cold["candidates"]),
            "evidence_count": (cold["research"].get("metrics") or {}).get("evidence_count", 0),
            "metrics": cold["research"].get("metrics"),
            "langsmith_tracing_enabled": (cold["research"].get("metrics") or {}).get("langsmith_tracing_enabled"),
            "trace_run_ids": (cold["research"].get("metrics") or {}).get("trace_run_ids", {}),
            "model_call_details": (cold["research"].get("metrics") or {}).get("model_call_details", []),
        },
        "same_project_repeat": {
            "run_id": repeat["run_id"],
            "reuse_refresh_ignore": repeat_decisions,
        },
        "cross_project_reuse": {
            "project_id": cross["project_id"],
            "run_id": cross["run_id"],
            "candidate_count": len(cross["candidates"]),
            "reused_intelligence_ids": cross_decisions.get("reuse_intelligence_ids", []),
        },
        "budgets_per_run": BUDGET,
    }
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
