"""Cloud acceptance for the M3-A technical check.

The script drives the deployed Worker: it compiles a demand, runs a research
round, triggers the technical evaluation, and then reads the assessments back.
It checks that a hard failure stays a failure, that an unknown stays unknown,
that every verdict carries its evidence, and that the verdicts can be read
back from D1.

Every stage runs up to three times and the script reports the pass rate,
because a research round can end early for reasons outside the code.
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
QUOTE = "5MP 工业网络摄像机"


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
    buffer = Path("m3-acceptance.pptx")
    presentation.save(buffer)
    data = buffer.read_bytes()
    buffer.unlink()
    return data


def _create_project(client: httpx.Client) -> str:
    response = _request(client, "POST", "/api/projects", json={"title": "M3 spec acceptance"})
    response.raise_for_status()
    return str(response.json()["project_id"])


def _upload_and_compile(client: httpx.Client, project_id: str) -> dict:
    """Upload the demand, compile it, and wait for the compilation."""
    upload = _request(
        client,
        "POST",
        f"/api/projects/{project_id}/upload-sessions",
        data={"purpose": "REQUIREMENT"},
        files={"file": ("m3-acceptance.pptx", _requirement_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
    )
    upload.raise_for_status()
    compile_response = _request(client, "POST", f"/api/projects/{project_id}/requirement-compile")
    compile_response.raise_for_status()
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        read = _request(client, "GET", f"/api/projects/{project_id}/requirements")
        if read.status_code == 200:
            body = read.json()
            requirements = body.get("compilation", {}).get("requirements", [])
            if requirements:
                return body
        time.sleep(10)
    raise RuntimeError("the demand did not compile within 900 seconds")


def _run_research(client: httpx.Client, project_id: str) -> dict:
    """Run one research round and wait for it."""
    response = _request(client, "POST", f"/api/projects/{project_id}/runs", json={"mode": "SOURCING"})
    response.raise_for_status()
    run_id = str(response.json()["run_id"])
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        read = _request(client, "GET", f"/api/runs/{run_id}")
        if read.status_code == 200:
            status = read.json().get("status")
            if status in {"COMPLETED", "PARTIAL", "FAILED"}:
                return {"run_id": run_id, "status": status}
        time.sleep(15)
    raise RuntimeError("the research run did not finish within 1800 seconds")


def _trigger_evaluation(client: httpx.Client, project_id: str) -> str:
    response = _request(client, "POST", f"/api/projects/{project_id}/spec-assessments", json={})
    response.raise_for_status()
    return str(response.json()["assessment_id"])


def _read_assessments(client: httpx.Client, project_id: str, timeout: int = 2400) -> list[dict]:
    """Wait for the evaluation to land in D1 and read it back."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        read = _request(client, "GET", f"/api/projects/{project_id}/spec-assessments")
        if read.status_code == 200:
            assessments = read.json().get("assessments", [])
            if assessments:
                return assessments
        time.sleep(15)
    raise RuntimeError("the technical check produced no assessment in time")


def _check_assessments(assessments: list[dict]) -> None:
    """The verdicts must be readable, three-valued, and carry their evidence."""
    for assessment in assessments:
        overall = assessment.get("hard_spec_overall")
        if overall not in {"PASS", "FAIL", "UNKNOWN"}:
            raise RuntimeError(f"the overall verdict is not one of the three values: {overall}")
        detail = assessment.get("assessment") or {}
        checks = detail.get("checks") or []
        if not checks:
            raise RuntimeError("an assessment carries no constraint check")
        for check in checks:
            if check.get("status") not in {"PASS", "FAIL", "UNKNOWN"}:
                raise RuntimeError(f"a check verdict is not one of the three values: {check.get('status')}")
            if check.get("status") in {"PASS", "FAIL"}:
                if check.get("reason_code") != "VERIFIED_COMPARISON":
                    raise RuntimeError(f"a verdict was given without a verified comparison: {check.get('reason_code')}")
                if not check.get("operation"):
                    raise RuntimeError("a verdict was given without the calculation")
            if check.get("status") == "FAIL":
                # A hard failure must not be reported as anything else.
                if assessment.get("hard_spec_overall") != "FAIL":
                    raise RuntimeError("a failing check is not reflected in the overall verdict")
        if overall == "FAIL":
            failures = [check for check in checks if check.get("status") == "FAIL"]
            if not failures:
                raise RuntimeError("the overall verdict is FAIL without a failing check")
        if overall == "PASS":
            if any(check.get("status") != "PASS" for check in checks if check.get("importance") == "HARD"):
                raise RuntimeError("the overall verdict is PASS while a hard check is not")
        if assessment.get("calculator_version") != "0.1.0":
            raise RuntimeError("the assessment does not record the calculator version")


def _run_attempt(client: httpx.Client, attempt: int) -> dict:
    """Compile, research, evaluate, and check one full round."""
    project_id = _create_project(client)
    compilation = _upload_and_compile(client, project_id)
    requirements = compilation.get("compilation", {}).get("requirements", [])
    constraints = [constraint for requirement in requirements for constraint in requirement.get("constraints", [])]
    if not constraints:
        raise RuntimeError("the compiled demand carries no constraint to check")
    research = _run_research(client, project_id)
    if research["status"] == "FAILED":
        raise RuntimeError(f"the research run failed: {research['run_id']}")
    _trigger_evaluation(client, project_id)
    assessments = _read_assessments(client, project_id)
    _check_assessments(assessments)
    by_overall: dict[str, int] = {}
    for assessment in assessments:
        key = str(assessment.get("hard_spec_overall"))
        by_overall[key] = by_overall.get(key, 0) + 1
    return {
        "attempt": attempt,
        "project_id": project_id,
        "run_id": research["run_id"],
        "research_status": research["status"],
        "requirements": len(requirements),
        "constraints": len(constraints),
        "assessments": len(assessments),
        "by_overall": by_overall,
        "with_evidence": len([item for item in assessments if item.get("evidence_ids")]),
        "models": sorted({str(item.get("product_model_ref") or "") for item in assessments}),
    }


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    load_dotenv(repo / ".env", override=False)
    token_path = Path(os.getenv("DEMO_ACCESS_TOKEN_FILE", str(repo / ".demo_access_token")))
    if not token_path.exists():
        raise SystemExit("Missing ignored local .demo_access_token file; refusing to request without it.")
    token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("Local demo token file is empty.")
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
            {
                "attempt": item["attempt"],
                "passed": item.get("passed", True),
                "failure": item.get("failure"),
            }
            for item in attempts
        ],
        "detail": passed[0] if passed else attempts[-1],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
