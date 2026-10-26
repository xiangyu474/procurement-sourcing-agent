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
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
from pptx import Presentation
from pptx.util import Inches

DEFAULT_BASE_URL = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"
PRODUCT_NAME = "5MP 工业网络摄像机"
BUDGET = {
    "max_search_calls": 4,
    "max_fetches": 4,
    "max_tasks": 2,
    "max_rounds": 2,
    "max_model_calls": 15,
}


def _request(client: httpx.Client, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    try:
        response = client.request(method, path, **kwargs)
    except httpx.TransportError:
        # The edge closes idle pooled connections; one fresh attempt is enough.
        response = client.request(method, path, **kwargs)
    if not response.is_success:
        raise RuntimeError(f"M2 API {method} {path} returned HTTP {response.status_code}")
    if response.headers.get("content-type", "").startswith("application/json"):
        return response.json()
    raise RuntimeError(f"M2 API {method} {path} did not return JSON")


def _requirement_pptx() -> bytes:
    """Small deterministic M1 fixture; it contains no real buyer or supplier data."""
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = slide.shapes.add_table(2, 3, Inches(1), Inches(1), Inches(6), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "采购数量（套）"
    table.cell(0, 2).text = "预计采购单价（元/套）"
    table.cell(1, 0).text = PRODUCT_NAME
    table.cell(1, 1).text = "10"
    table.cell(1, 2).text = "100"
    output = BytesIO()
    presentation.save(output)
    return output.getvalue()


def _create_compiled_project(client: httpx.Client, title: str) -> str:
    created = _request(client, "POST", "/api/projects", json={"title": title})
    project_id = str(created["project_id"])
    _request(
        client,
        "POST",
        f"/api/projects/{project_id}/upload-sessions",
        data={"purpose": "REQUIREMENT"},
        files={"file": ("m2-test-requirement.pptx", _requirement_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
    )
    _request(client, "POST", f"/api/projects/{project_id}/requirement-compile")
    readback = _request(client, "GET", f"/api/projects/{project_id}/requirements")
    requirements = readback.get("compilation", {}).get("requirements", [])
    if not requirements or requirements[0].get("product_name") != PRODUCT_NAME:
        raise RuntimeError("deterministic PPTX input did not compile to the expected Requirement")
    return project_id


def _verify_langsmith_trace(run_id: str, research: dict[str, Any]) -> dict[str, str]:
    metrics = research.get("metrics", {})
    trace_ids = metrics.get("trace_run_ids", {})
    trace_id = trace_ids.get("SUPERVISOR")
    if not metrics.get("langsmith_tracing_enabled") or not trace_id:
        raise RuntimeError(f"run {run_id} did not record an enabled Supervisor trace")
    try:
        from langsmith import Client

        trace = Client().read_run(trace_id)
    except Exception as exc:
        raise RuntimeError(f"run {run_id} Supervisor trace is not readable from LangSmith") from exc
    metadata = (trace.extra or {}).get("metadata", {})
    if str(trace.id) != str(trace_id) or metadata.get("sourcing_run_id") != run_id:
        raise RuntimeError(f"run {run_id} trace ID does not resolve to its LangSmith run")
    return {"trace_id": str(trace.id), "trace_name": str(trace.name or "")}


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
    langsmith_trace = _verify_langsmith_trace(run_id, research)
    research_metrics = research.get("metrics", {})
    if research_metrics.get("status") != "COMPLETED" or research_metrics.get("stop_reason_code"):
        raise RuntimeError(
            f"run {label} ({run_id}) research was partial/incomplete: status={research_metrics.get('status')}, "
            f"stop_reason={research_metrics.get('stop_reason_code')}, "
            f"langsmith_trace={langsmith_trace['trace_id']}"
        )
    candidates_response = _request(client, "GET", f"/api/projects/{project_id}/candidates", params={"run_id": run_id})
    candidates = candidates_response.get("candidates", [])
    return {
        "label": label,
        "project_id": project_id,
        "run_id": run_id,
        "status": run.get("status"),
        "research": research,
        "candidates": candidates,
        "langsmith_trace": langsmith_trace,
    }


def _verify_first_run(client: httpx.Client, result: dict[str, Any]) -> None:
    research = result["research"]
    candidates = result["candidates"]
    metrics = research.get("metrics", {})
    if metrics.get("status") != "COMPLETED" or metrics.get("stop_reason_code"):
        raise RuntimeError(
            "cold-start research was not complete; "
            f"status={metrics.get('status')}, stop_reason={metrics.get('stop_reason_code')}"
        )
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
    if not result.get("langsmith_trace", {}).get("trace_id"):
        raise RuntimeError("Supervisor trace was not verified in LangSmith")
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
    try:
        from dotenv import load_dotenv

        load_dotenv(repo / ".env", override=False)
    except ImportError:
        pass
    token_path = Path(os.getenv("DEMO_ACCESS_TOKEN_FILE", str(repo / ".demo_access_token")))
    if not token_path.exists():
        raise SystemExit("Missing ignored local .demo_access_token file; refusing to print or request without it.")
    token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("Local demo token file is empty.")
    base_url = os.getenv("PROCUREMENT_AGENT_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    headers = {"authorization": f"Bearer {token}"}

    with httpx.Client(
        base_url=base_url,
        headers=headers,
        timeout=httpx.Timeout(300),
        limits=httpx.Limits(max_keepalive_connections=0, keepalive_expiry=0),
    ) as client:
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
            "langsmith_trace": cold["langsmith_trace"],
            "model_call_details": (cold["research"].get("metrics") or {}).get("model_call_details", []),
        },
        "same_project_repeat": {
            "run_id": repeat["run_id"],
            "reuse_refresh_ignore": repeat_decisions,
            "langsmith_trace": repeat["langsmith_trace"],
        },
        "cross_project_reuse": {
            "project_id": cross["project_id"],
            "run_id": cross["run_id"],
            "candidate_count": len(cross["candidates"]),
            "reused_intelligence_ids": cross_decisions.get("reuse_intelligence_ids", []),
            "langsmith_trace": cross["langsmith_trace"],
        },
        "budgets_per_run": BUDGET,
    }
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
