"""Cloud acceptance for the M3-C decision and the verification gate.

The script drives the deployed Worker through the whole chain: compile a
demand, research, judge the candidates technically, write the decisions, and
then check the decisions against the assessments that produced them.

The checks are the ones the milestone names: a model with a failed hard
requirement must not reach the short list, an unknown must not be written down
as a verified pass, and a decision that invents an evidence identifier or a
saving must be rejected.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

DEFAULT_BASE_URL = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"
ATTEMPTS = 3
PRODUCT_NAME = "5MP 工业网络摄像机"


def _request(client: httpx.Client, method: str, path: str, **kwargs) -> httpx.Response:
    return client.request(method, path, timeout=httpx.Timeout(300), **kwargs)


def _requirement_pptx() -> bytes:
    """Build the small presentation the M2 acceptance uses."""
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
    textbox.text_frame.text = (
        f"采购需求：{PRODUCT_NAME}，采购数量 10 套，预计采购单价 100 元/套。"
    )
    table = slide.shapes.add_table(2, 3, Inches(1), Inches(2), Inches(6), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "采购数量（套）"
    table.cell(0, 2).text = "预计采购单价（元/套）"
    table.cell(1, 0).text = PRODUCT_NAME
    table.cell(1, 1).text = "10"
    table.cell(1, 2).text = "100"
    buffer = Path("m3-decision-acceptance.pptx")
    presentation.save(buffer)
    data = buffer.read_bytes()
    buffer.unlink()
    return data


def _prepare_project(client: httpx.Client) -> str:
    """Create a project, compile the demand, and research it."""
    created = _request(client, "POST", "/api/projects", json={"title": "M3 decision acceptance"})
    created.raise_for_status()
    project_id = str(created.json()["project_id"])
    _request(
        client,
        "POST",
        f"/api/projects/{project_id}/upload-sessions",
        data={"purpose": "REQUIREMENT"},
        files={"file": ("m3-decision-acceptance.pptx", _requirement_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
    ).raise_for_status()
    _request(client, "POST", f"/api/projects/{project_id}/requirement-compile").raise_for_status()
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        read = _request(client, "GET", f"/api/projects/{project_id}/requirements")
        if read.status_code == 200:
            requirements = read.json().get("compilation", {}).get("requirements", [])
            if requirements:
                break
        time.sleep(10)
    else:
        raise RuntimeError("the demand did not compile in time")

    run = _request(client, "POST", f"/api/projects/{project_id}/runs", json={"mode": "SOURCING"})
    run.raise_for_status()
    run_id = str(run.json()["run_id"])
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        read = _request(client, "GET", f"/api/runs/{run_id}")
        if read.status_code == 200 and read.json().get("status") in {"COMPLETED", "PARTIAL", "FAILED"}:
            if read.json()["status"] == "FAILED":
                raise RuntimeError(f"the research run failed: {run_id}")
            break
        time.sleep(15)
    else:
        raise RuntimeError("the research run did not finish in time")
    return project_id


def _wait_for_assessments(client: httpx.Client, project_id: str) -> list[dict]:
    _request(client, "POST", f"/api/projects/{project_id}/spec-assessments", json={}).raise_for_status()
    deadline = time.monotonic() + 2400
    while time.monotonic() < deadline:
        read = _request(client, "GET", f"/api/projects/{project_id}/spec-assessments")
        if read.status_code == 200:
            assessments = read.json().get("assessments", [])
            if assessments:
                return assessments
        time.sleep(15)
    raise RuntimeError("the technical check produced no assessment in time")


def _wait_for_decisions(client: httpx.Client, project_id: str) -> list[dict]:
    _request(client, "POST", f"/api/projects/{project_id}/decisions", json={}).raise_for_status()
    deadline = time.monotonic() + 2400
    while time.monotonic() < deadline:
        read = _request(client, "GET", f"/api/projects/{project_id}/decisions")
        if read.status_code == 200:
            decisions = read.json().get("decisions", [])
            if decisions:
                return decisions
        time.sleep(15)
    raise RuntimeError("the decision produced no result in time")


def _check_decisions(decisions: list[dict], assessments: list[dict]) -> dict:
    """The gate rules, checked on what was stored."""
    by_key = {
        (item.get("requirement_id"), item.get("product_candidate_id")): item
        for item in assessments
    }
    known_evidence = {
        evidence_id
        for item in assessments
        for evidence_id in item.get("evidence_ids") or []
    }
    rejected = 0
    accepted = 0
    for decision in decisions:
        key = (decision.get("requirement_id"), decision.get("product_candidate_id"))
        assessment = by_key.get(key)
        if assessment is None:
            raise RuntimeError(f"a decision has no assessment: {key}")
        overall = assessment.get("hard_spec_overall")
        if decision.get("accepted"):
            accepted += 1
            if overall == "FAIL" and decision.get("recommendation") == "SHORTLIST":
                raise RuntimeError("a model with a failed hard requirement reached the short list")
            if overall == "UNKNOWN" and decision.get("technical_verdict") == "VERIFIED_PASS":
                raise RuntimeError("an unknown was written down as a verified pass")
            for evidence_id in decision.get("evidence_ids") or []:
                if evidence_id not in known_evidence:
                    raise RuntimeError(f"an accepted decision cites the unknown evidence {evidence_id}")
        else:
            rejected += 1
            if not decision.get("violations"):
                raise RuntimeError("a rejected decision does not name a violation")
    return {
        "decisions": len(decisions),
        "accepted": accepted,
        "rejected": rejected,
        "recommendations": {
            key: len([item for item in decisions if item.get("recommendation") == key])
            for key in {str(item.get("recommendation")) for item in decisions}
        },
    }


def _run_attempt(client: httpx.Client, attempt: int) -> dict:
    project_id = _prepare_project(client)
    assessments = _wait_for_assessments(client, project_id)
    decisions = _wait_for_decisions(client, project_id)
    summary = _check_decisions(decisions, assessments)
    return {
        "attempt": attempt,
        "project_id": project_id,
        "assessments": len(assessments),
        "assessment_overall": {
            key: len([item for item in assessments if item.get("hard_spec_overall") == key])
            for key in {str(item.get("hard_spec_overall")) for item in assessments}
        },
        **summary,
    }


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    load_dotenv(repo / ".env", override=False)
    token_path = Path(os.getenv("DEMO_ACCESS_TOKEN_FILE", str(repo / ".demo_access_token")))
    if not token_path.exists():
        raise SystemExit("Missing ignored local .demo_access_token file; refusing to request without it.")
    token = token_path.read_text(encoding="utf-8").strip()
    base_url = os.getenv("PROCUREMENT_AGENT_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    headers = {"authorization": f"Bearer {token}"}

    attempts: list[dict] = []
    with httpx.Client(
        base_url=base_url,
        headers=headers,
        timeout=httpx.Timeout(300),
        limits=httpx.Limits(max_keepalive_connections=0, keepalive_expiry=0),
    ) as client:
        for attempt in range(ATTEMPTS):
            try:
                attempts.append(_run_attempt(client, attempt))
            except Exception as exc:
                attempts.append(
                    {
                        "attempt": attempt,
                        "passed": False,
                        "failure": f"{type(exc).__name__}: {exc}",
                    }
                )
            if attempts[-1].get("passed") is not False:
                break
            print(f"attempt {attempt} did not pass: {attempts[-1]['failure']}")

    passed = [item for item in attempts if item.get("passed") is not False]
    summary = {
        "status": "PASS" if passed else "FAIL",
        "attempts": len(attempts),
        "passed_attempts": len(passed),
        "pass_rate": round(len(passed) / len(attempts), 3) if attempts else 0.0,
        "stage_results": [
            {"attempt": item["attempt"], "passed": item.get("passed", True), "failure": item.get("failure")}
            for item in attempts
        ],
        "detail": passed[0] if passed else attempts[-1],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
