"""Run the M3-A2 evaluation live against the real M2 research output.

The script reads one finished M2 run from the cloud, takes the requirements it
compiled and the product claims the researcher recorded, and then runs the
typing, the alignment, and the calculator with the real model. It prints the
verdicts with their operation and their evidence, and it writes nothing.

Usage:
    uv run --python 3.11 python scripts/live_m3_spec_evaluation.py --run <run_id>
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

from procurement_agent.domain.requirements import Requirement
from procurement_agent.domain.sourcing import (
    CandidateStage,
    ClaimDraft,
    ClaimStatus,
    ResearchCandidate,
    SubjectType,
)
from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.ingestion.pptx import extract_pptx_fragments
from procurement_agent.services.demand_intake import build_demand_intake
from procurement_agent.services.spec_evaluation import evaluate_candidates, summarize

DEFAULT_BASE_URL = "https://procurement-sourcing-gateway.xiangyu474.workers.dev"


def _request(client: httpx.Client, method: str, path: str) -> dict:
    response = client.request(method, path, timeout=300)
    response.raise_for_status()
    return response.json()


def _requirements(body: dict) -> list[Requirement]:
    compilation = body.get("compilation") or body
    raw = compilation.get("requirements") or []
    return [Requirement.model_validate(item) for item in raw]


def _candidates(body: dict) -> list[ResearchCandidate]:
    raw = body.get("candidates") or []
    candidates: list[ResearchCandidate] = []
    for item in raw:
        supplier = item.get("supplier") or {}
        product = item.get("product") or {}
        evidence_ids = [
            entry.get("evidence_id")
            for entry in item.get("evidence") or []
            if entry.get("evidence_id")
        ]
        candidates.append(
            ResearchCandidate(
                candidate_id=item["candidate_id"],
                requirement_id=item["requirement_id"],
                supplier_id=supplier.get("supplier_id", "supplier-unknown"),
                product_id=product.get("product_id"),
                stage=CandidateStage(item.get("stage", "DISCOVERED_LONG_LIST")),
                rationale=item.get("rationale", "the source states this candidate"),
                evidence_ids=evidence_ids or ["evidence-unknown"],
            )
        )
    return candidates


def _claims_from_d1(project_id: str) -> list[ClaimDraft]:
    """Read the product claims the researcher recorded for this project's candidates.

    The claims live in D1. The script only reads them.
    """
    sql = (
        "SELECT cc.id AS claim_id, cc.subject_type, cc.subject_id, cc.attribute, cc.value, cc.unit, "
        "cc.status, ce.evidence_id, ce.source_quote "
        "FROM research_claims cc JOIN claim_evidence_links ce "
        "ON ce.workspace_id = cc.workspace_id AND ce.claim_id = cc.id "
        "WHERE cc.workspace_id = 'default' AND cc.subject_type = 'PRODUCT_MODEL' "
        "AND cc.subject_id IN (SELECT DISTINCT product_id FROM project_candidates "
        "WHERE workspace_id = 'default' AND project_id = '"
        + project_id
        + "')"
    )
    npx = "npx.cmd" if os.name == "nt" else "npx"
    completed = subprocess.run(
        [npx, "wrangler", "d1", "execute", "DB", "--remote", "--command", sql, "--json"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    rows = json.loads(completed.stdout)[0]["results"]
    return [
        ClaimDraft(
            claim_id=row["claim_id"],
            subject_type=SubjectType(row["subject_type"]),
            subject_ref=row["subject_id"],
            attribute=row["attribute"],
            value=row["value"],
            unit=row.get("unit"),
            evidence_id=row["evidence_id"],
            source_quote=row["source_quote"],
            status=ClaimStatus(row.get("status", "SUPPORTED_BY_SOURCE")),
            evaluation_method="EXCERPT_MATCH",
        )
        for row in rows
    ]


def _models(bundle: dict) -> dict[str, str]:
    return {
        product["product_id"]: product["model"]
        for product in bundle.get("products") or []
        if product.get("model")
    }



def _local_requirements(model) -> list[Requirement]:
    """Compile the same 5MP material the M2 acceptance uses, with the current compiler."""
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
    textbox.text_frame.text = (
        "采购需求：5MP 工业网络摄像机，支持ONVIF协议，采购数量 10 套，预计采购单价 100 元/套。"
    )
    table = slide.shapes.add_table(2, 3, Inches(1), Inches(2), Inches(6), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "采购数量（套）"
    table.cell(0, 2).text = "预计采购单价（元/套）"
    table.cell(1, 0).text = "5MP 工业网络摄像机"
    table.cell(1, 1).text = "10"
    table.cell(1, 2).text = "100"
    buffer = Path("m3-live-requirement.pptx")
    presentation.save(buffer)
    data = buffer.read_bytes()
    buffer.unlink()
    fragments = extract_pptx_fragments(
        data,
        project_id="m3-live",
        source_id="m3-live",
        filename="m3-live-requirement.pptx",
    )
    intake = build_demand_intake(project_id="m3-live", fragments=fragments, model=model)
    return intake.requirements


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True, help="a finished M2 run ID")
    parser.add_argument("--base-url", default=os.getenv("PROCUREMENT_AGENT_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--token-file", type=Path, default=Path(".demo_access_token"))
    parser.add_argument(
        "--local-requirement",
        action="store_true",
        help="compile the 5MP test material locally instead of reading the cloud requirement",
    )
    args = parser.parse_args()

    load_dotenv()
    settings = load_settings()
    if not settings.has_llm:
        print(json.dumps({"status": "BLOCKED", "reason": "GENESIS_* is not configured"}))
        return 2
    if not args.token_file.exists():
        print(json.dumps({"status": "BLOCKED", "reason": "the demo access token file is missing"}))
        return 2
    token = args.token_file.read_text(encoding="utf-8").strip()

    with httpx.Client(
        base_url=args.base_url.rstrip("/"),
        headers={"authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(300),
    ) as client:
        run = _request(client, "GET", f"/api/runs/{args.run}")
        project_id = run.get("project_id")
        requirements_body = _request(client, "GET", f"/api/projects/{project_id}/requirements")
        candidates_body = _request(client, "GET", f"/api/projects/{project_id}/candidates")

    requirements = _requirements(requirements_body)
    candidates = _candidates(candidates_body)
    claims = _claims_from_d1(project_id)
    models = {
        candidate["product"]["product_id"]: candidate["product"]["model"]
        for candidate in candidates_body.get("candidates") or []
        if (candidate.get("product") or {}).get("model")
    }

    model = build_chat_model(settings, timeout=600)
    if args.local_requirement:
        requirements = _local_requirements(model)
    assessments = evaluate_candidates(
        requirements=requirements,
        candidates=candidates,
        claims=claims,
        model=model,
        model_by_product=models,
    )

    report = {
        "status": "OK",
        "run_id": args.run,
        "project_id": project_id,
        "requirements": len(requirements),
        "candidates": len(candidates),
        "claims": len(claims),
        "summary": summarize(assessments),
        "assessments": [
            {
                "requirement_id": assessment.requirement_id,
                "product_candidate_id": assessment.product_candidate_id,
                "product_model_ref": assessment.product_model_ref,
                "hard_spec_overall": assessment.hard_spec_overall.value,
                "overall_reason_codes": [code.value for code in assessment.overall_reason_codes],
                "checks": [
                    {
                        "constraint_id": check.constraint_id,
                        "status": check.status.value,
                        "reason_code": check.reason_code.value,
                        "operation": check.operation,
                        "explanation": check.explanation,
                        "evidence_ids": check.evidence_ids,
                    }
                    for check in assessment.checks
                ],
            }
            for assessment in assessments
        ],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
