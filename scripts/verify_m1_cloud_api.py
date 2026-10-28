"""Cloud M1 API acceptance smoke against the deployed Worker.

Reads the competition materials from outside this repository. The private
files are uploaded only to the authenticated private R2 bucket for this
acceptance run and are never printed or written into the repository.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

DEFAULT_GATEWAY = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"
DEFAULT_MATERIALS = (
    Path(__file__).resolve().parents[2]
    / "参赛要求与官方资料"
    / "命题赛道素材_已解压"
    / "命题赛道素材"
    / "寻价比源素材"
)


def compile_and_wait(session, headers, project_id, *, gateway, timeout=900):
    """Start a compilation and wait for the workflow to store the result."""
    started = session.post(
        f"{gateway}/api/projects/{project_id}/requirement-compile",
        headers=headers,
        json={},
        timeout=60,
    )
    started.raise_for_status()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        read = session.get(
            f"{gateway}/api/projects/{project_id}/requirements", headers=headers, timeout=60
        )
        if read.status_code == 200:
            return read.json()
        time.sleep(5)
    raise RuntimeError(f"project {project_id} was not compiled within {timeout} seconds")


ATTEMPTS = 3


def _attempt(session, headers, args) -> tuple[dict[str, object], bool, str]:
    # Public data routes must reject anonymous access.
    anonymous = session.post(f"{args.gateway}/api/projects", json={"title": "auth-check"}, timeout=45)
    results: dict[str, object] = {}
    results["anonymous_project_create"] = "PASS" if anonymous.status_code == 401 else f"FAIL:{anonymous.status_code}"

    # Text-only: create -> compile -> readback, no history required.
    text_response = session.post(
        f"{args.gateway}/api/projects",
        headers=headers,
        json={
            "title": "M1 Cloud text-only acceptance",
            "requirement_text": "采购电源模块100台，视频输出额定功率至少7.5kW，最好支持CAN接口。",
        },
        timeout=45,
    )
    text_response.raise_for_status()
    text_project = text_response.json()["project_id"]
    text_body = compile_and_wait(session, headers, text_project, gateway=args.gateway)
    text_items = text_body["compilation"].get("requirements", [])
    text_read = session.get(f"{args.gateway}/api/projects/{text_project}/requirements", headers=headers, timeout=45)
    text_read.raise_for_status()
    text_read_body = text_read.json()
    results["text_only_compile_and_readback"] = (
        "PASS"
        if text_items
        and text_body["compilation"].get("history_availability") == "NOT_PROVIDED"
        and text_read_body["compilation"] == text_body["compilation"]
        else "FAIL"
    )
    results["text_project_id"] = text_project
    results["text_requirement_count"] = len(text_items)

    # PPT-only: upload a source PPTX and compile. History must remain optional.
    pptx_path = args.materials / "2" / "智能视觉感知探头生产采购项目_v2.pptx"
    ppt_project_resp = session.post(
        f"{args.gateway}/api/projects",
        headers=headers,
        json={"title": "M1 official PPT-only acceptance"},
        timeout=45,
    )
    ppt_project_resp.raise_for_status()
    ppt_project = ppt_project_resp.json()["project_id"]
    with pptx_path.open("rb") as stream:
        upload = session.post(
            f"{args.gateway}/api/projects/{ppt_project}/upload-sessions",
            headers=headers,
            data={"purpose": "REQUIREMENT"},
            files={"file": (pptx_path.name, stream, "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
            timeout=300,
        )
    upload.raise_for_status()
    ppt_body = compile_and_wait(session, headers, ppt_project, gateway=args.gateway)
    ppt_items = ppt_body["compilation"].get("requirements", [])
    results["ppt_only_compile"] = (
        "PASS"
        if len(ppt_items) == 14
        and ppt_body["compilation"].get("history_availability") == "NOT_PROVIDED"
        else f"FAIL:requirements={len(ppt_items)}"
    )
    results["ppt_project_id"] = ppt_project

    # Case A's executive summary contains two differently sourced total-
    # quantity claims (58 and 63 万台). They must remain an unresolved conflict.
    conflict_project_resp = session.post(
        f"{args.gateway}/api/projects",
        headers=headers,
        json={"title": "M1 Case A summary conflict acceptance"},
        timeout=45,
    )
    conflict_project_resp.raise_for_status()
    conflict_project = conflict_project_resp.json()["project_id"]
    case_a_pptx = args.materials / "1" / "智能视频采集终端生产采购项目_v1.pptx"
    with case_a_pptx.open("rb") as stream:
        case_a_upload = session.post(
            f"{args.gateway}/api/projects/{conflict_project}/upload-sessions",
            headers=headers,
            data={"purpose": "REQUIREMENT"},
            files={"file": (case_a_pptx.name, stream, "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
            timeout=300,
        )
    case_a_upload.raise_for_status()
    case_a_data = compile_and_wait(session, headers, conflict_project, gateway=args.gateway)["compilation"]
    # The model states each value with the place it came from, so the two
    # quantities are looked for inside the reported values.
    conflict_values = [
        str(value.get("value") or "")
        for conflict in case_a_data.get("conflicts", [])
        for value in conflict.get("values_with_source", [])
    ]
    results["case_a_summary_conflict"] = (
        "PASS"
        if any("58万台" in value for value in conflict_values)
        and any("63万台" in value for value in conflict_values)
        else f"FAIL:{conflict_values}"
    )
    results["case_a_conflict_project_id"] = conflict_project

    # Optional history import: upload XLSX independently, verify the official
    # 1,000 x 38 layout and simulated supplier namespace, then verify idempotency.
    xlsx_path = args.materials / "1" / "智能视频采集终端_历史采购明细_v1.xlsx"
    history_project_resp = session.post(
        f"{args.gateway}/api/projects",
        headers=headers,
        json={
            "title": "M1 optional history acceptance",
            "requirement_text": "采购视频采集终端，具体数量以采购计划为准。",
        },
        timeout=45,
    )
    history_project_resp.raise_for_status()
    history_project = history_project_resp.json()["project_id"]
    with xlsx_path.open("rb") as stream:
        history_upload = session.post(
            f"{args.gateway}/api/projects/{history_project}/upload-sessions",
            headers=headers,
            data={"purpose": "HISTORY"},
            files={"file": (xlsx_path.name, stream, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            timeout=300,
        )
    history_upload.raise_for_status()
    source_id = history_upload.json()["source_id"]
    imported_response = session.post(
        f"{args.gateway}/api/projects/{history_project}/history-imports",
        headers=headers,
        json={"source_id": source_id},
        timeout=420,
    )
    imported_response.raise_for_status()
    imported = imported_response.json()
    duplicate_response = session.post(
        f"{args.gateway}/api/projects/{history_project}/history-imports",
        headers=headers,
        json={"source_id": source_id},
        timeout=300,
    )
    duplicate_response.raise_for_status()
    duplicate = duplicate_response.json()
    project_state = session.get(f"{args.gateway}/api/projects/{history_project}", headers=headers, timeout=45)
    project_state.raise_for_status()
    project_state_body = project_state.json()
    results["history_import"] = (
        "PASS"
        if imported.get("row_count") == 1000
        and imported.get("column_count") == 38
        and imported.get("header_row") == 8
        and imported.get("is_synthetic") is True
        and imported.get("supplier_namespace") == "HISTORICAL_SUPPLIER_SIMULATED"
        else "FAIL"
    )
    results["history_duplicate_dedup"] = "PASS" if duplicate.get("duplicate_import") is True else "FAIL"
    results["history_status"] = project_state_body.get("history_availability")
    results["history_analysis_version"] = project_state_body.get("analysis_version")
    results["history_project_id"] = history_project

    checks = [value for key, value in results.items() if key in {
        "anonymous_project_create", "text_only_compile_and_readback", "ppt_only_compile",
        "case_a_summary_conflict", "history_import", "history_duplicate_dedup",
    }]
    status = "PASS" if all(value == "PASS" for value in checks) else "FAIL"
    passed = status == "PASS"
    return results, passed, status

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gateway", default=DEFAULT_GATEWAY)
    parser.add_argument("--materials", type=Path, default=DEFAULT_MATERIALS)
    parser.add_argument("--token-file", type=Path, default=Path(".demo_access_token"))
    args = parser.parse_args()

    load_dotenv()
    if not args.token_file.exists():
        print(json.dumps({"status": "BLOCKED", "reason": "demo access token file is missing"}))
        return 2
    token = args.token_file.read_text(encoding="utf-8").strip()
    if not token:
        print(json.dumps({"status": "BLOCKED", "reason": "demo access token is empty"}))
        return 2

    session = requests.Session()
    session.trust_env = True
    headers = {"Authorization": f"Bearer {token}"}

    attempts = []
    for attempt in range(ATTEMPTS):
        results, passed, status = _attempt(session, headers, args)
        attempts.append({"attempt": attempt, "passed": passed, "status": status, "results": results})
        if passed:
            break
        print(f"attempt {attempt} did not pass every stage: {results}")

    passed_attempts = [item for item in attempts if item["passed"]]
    summary = {
        "status": "PASS" if passed_attempts else "FAIL",
        "attempts": len(attempts),
        "passed_attempts": len(passed_attempts),
        "pass_rate": round(len(passed_attempts) / len(attempts), 3) if attempts else 0.0,
        "stage_results": [
            {"attempt": item["attempt"], "passed": item["passed"], "status": item["status"]}
            for item in attempts
        ],
        "detail": passed_attempts[0]["results"] if passed_attempts else attempts[-1]["results"],
    }
    print(json.dumps(summary, ensure_ascii=True, indent=2))
    return 0 if passed_attempts else 1



if __name__ == "__main__":
    raise SystemExit(main())
