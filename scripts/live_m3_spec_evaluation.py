"""Run the M3-A2 evaluation live against the real M2 research output.

The script reads one finished M2 run from D1, takes the requirements it
compiled and the product claims the researcher recorded, and then runs the
typing, the alignment, and the calculator with the real model. It prints the
verdicts with their operation and their evidence, and it writes nothing.

Usage:
    uv run --python 3.11 python scripts/live_m3_spec_evaluation.py --run <run_id>
    uv run --python 3.11 python scripts/live_m3_spec_evaluation.py --run <run_id> --local-requirement
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

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


def _d1(sql: str, attempts: int = 3) -> list[dict[str, Any]]:
    """Run a read-only query against the remote D1 database.

    The network to Cloudflare drops occasionally, so a failed query is tried
    again before it is reported.
    """
    npx = "npx.cmd" if os.name == "nt" else "npx"
    last = ""
    for attempt in range(attempts):
        completed = subprocess.run(
            [npx, "wrangler", "d1", "execute", "DB", "--remote", "--command", sql, "--json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if completed.returncode == 0:
            try:
                return json.loads(completed.stdout)[0]["results"]
            except (json.JSONDecodeError, KeyError, IndexError) as exc:
                last = f"the D1 answer could not be read: {exc}"
        else:
            last = completed.stderr[:300]
        time.sleep(5)
    raise RuntimeError(f"the D1 query failed: {last}")


def _run_project(run_id: str) -> str:
    rows = _d1(f"SELECT project_id FROM runs WHERE id = '{run_id}'")
    if not rows:
        raise SystemExit(f"the run {run_id} is not in D1")
    return str(rows[0]["project_id"])


def _candidates(project_id: str) -> list[ResearchCandidate]:
    """Read the project candidates and the model code of their product."""
    rows = _d1(
        "SELECT c.id AS candidate_id, c.requirement_id, c.stage, c.rationale, c.supplier_id, c.product_id, "
        "p.model AS product_model, "
        "(SELECT group_concat(e.evidence_id) FROM project_candidate_evidence e "
        "WHERE e.workspace_id = c.workspace_id AND e.candidate_id = c.id) AS evidence_ids "
        "FROM project_candidates c LEFT JOIN intelligence_products p "
        "ON p.workspace_id = c.workspace_id AND p.id = c.product_id "
        f"WHERE c.workspace_id = 'default' AND c.project_id = '{project_id}'"
    )
    candidates: list[ResearchCandidate] = []
    for row in rows:
        evidence_ids = [item for item in str(row.get("evidence_ids") or "").split(",") if item]
        candidates.append(
            ResearchCandidate(
                candidate_id=str(row["candidate_id"]),
                requirement_id=str(row["requirement_id"]),
                supplier_id=str(row["supplier_id"]),
                product_id=str(row["product_id"]) if row.get("product_id") else None,
                stage=CandidateStage(str(row.get("stage", "DISCOVERED_LONG_LIST"))),
                rationale=str(row.get("rationale") or "the source states this candidate"),
                evidence_ids=evidence_ids or ["evidence-unknown"],
            )
        )
    return candidates


def _claims(project_id: str) -> list[ClaimDraft]:
    """Read the product claims the researcher recorded for this project."""
    rows = _d1(
        "SELECT cc.id AS claim_id, cc.subject_type, cc.subject_id, cc.attribute, cc.value, cc.unit, "
        "cc.status, ce.evidence_id, ce.source_quote "
        "FROM research_claims cc JOIN claim_evidence_links ce "
        "ON ce.workspace_id = cc.workspace_id AND ce.claim_id = cc.id "
        "WHERE cc.workspace_id = 'default' AND cc.subject_type = 'PRODUCT_MODEL' "
        "AND cc.subject_id IN (SELECT DISTINCT product_id FROM project_candidates "
        f"WHERE workspace_id = 'default' AND project_id = '{project_id}')"
    )
    return [
        ClaimDraft(
            claim_id=str(row["claim_id"]),
            subject_type=SubjectType(str(row["subject_type"])),
            subject_ref=str(row["subject_id"]),
            attribute=str(row["attribute"]),
            value=str(row["value"]),
            unit=row.get("unit"),
            evidence_id=str(row["evidence_id"]),
            source_quote=str(row["source_quote"]),
            status=ClaimStatus(str(row.get("status", "SUPPORTED_BY_SOURCE"))),
            evaluation_method="EXCERPT_MATCH",
        )
        for row in rows
    ]


def _models(project_id: str) -> dict[str, str]:
    rows = _d1(
        "SELECT c.product_id AS product_id, p.model AS model FROM project_candidates c "
        "JOIN intelligence_products p ON p.workspace_id = c.workspace_id AND p.id = c.product_id "
        f"WHERE c.workspace_id = 'default' AND c.project_id = '{project_id}' AND p.model IS NOT NULL"
    )
    return {str(row["product_id"]): str(row["model"]) for row in rows}


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
    parser.add_argument(
        "--local-requirement",
        action="store_true",
        help="compile the 5MP test material locally instead of reading the cloud requirement",
    )
    args = parser.parse_args()

    load_dotenv(".env")
    settings = load_settings()
    if not settings.has_llm:
        print(json.dumps({"status": "BLOCKED", "reason": "GENESIS_* is not configured"}))
        return 2

    project_id = _run_project(args.run)
    candidates = _candidates(project_id)
    claims = _claims(project_id)
    models = _models(project_id)

    model = build_chat_model(settings, timeout=600)
    requirements = _local_requirements(model) if args.local_requirement else []
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
