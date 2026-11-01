"""Build the formal report locally from the deployed database.

The cloud path writes the document through the container and stores it in R2.
This script reads the same rows with the same statements and writes the same
document on the machine, so the content of a report can be read and checked
without waiting for a cloud round.

Usage: python scripts/build_local_report.py <project_id> [output.docx]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from procurement_agent.domain.requirements import HistoricalTransaction, Requirement  # noqa: E402
from procurement_agent.reports.procurement_report import ReportInput, build_procurement_docx  # noqa: E402
from procurement_agent.services.price_context import build_price_context  # noqa: E402


def query(sql: str) -> list[dict]:
    completed = subprocess.run(
        [
            "npx.cmd",
            "wrangler",
            "d1",
            "execute",
            "DB",
            "--remote",
            "--command",
            sql,
            "--json",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list) or not payload:
        return []
    return payload[0].get("results") or []


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    project_id = sys.argv[1]
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "local_report.docx"

    project = query(
        "SELECT id, title, demand_revision FROM projects WHERE id="
        f"'{project_id}'"
    )
    if not project:
        print(f"the project {project_id} is not in the database")
        return 1
    compilation = query(
        "SELECT demand_revision, compilation_json FROM demand_compilations WHERE project_id="
        f"'{project_id}' ORDER BY demand_revision DESC LIMIT 1"
    )
    if not compilation:
        print("the project has no compiled demand")
        return 1
    details = json.loads(compilation[0]["compilation_json"])

    candidates = query(
        "SELECT c.id AS candidate_id, c.requirement_id, c.stage, c.rationale, c.open_questions_json, "
        "s.display_name AS supplier_name, p.model AS product_model, p.product_name, "
        "(SELECT group_concat(e.evidence_id) FROM project_candidate_evidence e "
        " WHERE e.workspace_id=c.workspace_id AND e.candidate_id=c.id) AS evidence_ids "
        "FROM project_candidates c "
        "LEFT JOIN intelligence_suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id "
        "LEFT JOIN intelligence_products p ON p.workspace_id=c.workspace_id AND p.id=c.product_id "
        f"WHERE c.workspace_id='default' AND c.project_id='{project_id}' ORDER BY c.updated_at DESC LIMIT 600"
    )
    assessments = query(
        "SELECT s.requirement_id, s.product_candidate_id, s.product_model_ref, s.hard_spec_overall, "
        "s.overall_reason_codes_json, s.assessment_json, s.judgment_version, s.evaluated_at "
        "FROM spec_assessments s WHERE s.workspace_id='default' AND s.project_id="
        f"'{project_id}' AND s.judgment_version=(SELECT MAX(i.judgment_version) FROM spec_assessments i "
        " WHERE i.workspace_id=s.workspace_id AND i.project_id=s.project_id "
        " AND i.requirement_id=s.requirement_id AND i.product_candidate_id=s.product_candidate_id "
        " AND i.demand_revision=s.demand_revision) ORDER BY s.requirement_id, s.product_candidate_id"
    )
    decisions = query(
        "SELECT d.requirement_id, d.product_candidate_id, d.product_model_ref, d.recommendation, "
        "d.technical_verdict, d.hard_spec_overall, d.accepted, d.rationale, d.gaps_json, "
        "d.next_actions_json, d.evidence_ids_json, d.priority_rank, d.decision_json, d.violations_json, "
        f"d.decided_at FROM sourcing_decisions d WHERE d.workspace_id='default' AND d.project_id='{project_id}'"
    )
    history = query(
        "SELECT t.id, t.dataset_id, t.project_id, t.source_row_ref, t.order_id, t.line_id, t.order_date, "
        "t.sku, t.product_name, t.specification, t.supplier_code, t.supplier_display_name, "
        "t.supplier_entity_id, t.supplier_namespace, t.is_synthetic_supplier, t.quantity, "
        "t.unit_price_ex_tax, t.amount_ex_tax, t.tax_rate, t.tax_amount, t.amount_inc_tax, t.currency "
        f"FROM history_transactions t WHERE t.workspace_id='default' AND t.project_id='{project_id}' LIMIT 5000"
    )
    evidence = query(
        "SELECT e.id AS evidence_id, e.title, e.source_url AS url, e.excerpt AS quote, e.content_sha256 "
        "FROM research_evidence e JOIN project_candidate_evidence p ON p.evidence_id=e.id "
        f"JOIN project_candidates c ON c.id=p.candidate_id WHERE c.project_id='{project_id}'"
    )

    requirements = details.get("requirements") or []
    transactions = [HistoricalTransaction.model_validate(row) for row in history]
    price_contexts = []
    for requirement in requirements:
        parsed = Requirement.model_validate(requirement)
        context = build_price_context(requirement=parsed, transactions=transactions)
        price_contexts.append(
            {
                "requirement_id": parsed.requirement_id,
                "scope": context.history_scope.value,
                "scope_note": context.history.scope_note,
                "statistics": (
                    context.history.statistics.model_dump(mode="json")
                    if context.history.statistics
                    else None
                ),
                "overview_statistics": (
                    context.history_overview.statistics.model_dump(mode="json")
                    if context.history_overview and context.history_overview.statistics
                    else None
                ),
                "findings": [finding.model_dump(mode="json") for finding in context.findings],
                "notes": context.notes,
            }
        )

    report = ReportInput(
        project_id=project_id,
        project_title=project[0]["title"],
        run_id=(query(f"SELECT id FROM runs WHERE project_id='{project_id}' ORDER BY created_at DESC LIMIT 1") or [{}])[0].get("id"),
        demand_revision=int(compilation[0]["demand_revision"]),
        decision_version="local",
        requirements=requirements,
        candidates=[
            {
                "candidate_id": row["candidate_id"],
                "requirement_id": row["requirement_id"],
                "stage": row["stage"],
                "rationale": row["rationale"],
                "open_questions": json.loads(row["open_questions_json"] or "[]"),
                "supplier_name": row["supplier_name"],
                "product_model": row["product_model"],
                "product_name": row["product_name"],
                "evidence_ids": [item for item in (row["evidence_ids"] or "").split(",") if item],
            }
            for row in candidates
        ],
        assessments=[
            {
                "requirement_id": row["requirement_id"],
                "product_candidate_id": row["product_candidate_id"],
                "product_model_ref": row["product_model_ref"],
                "hard_spec_overall": row["hard_spec_overall"],
                "overall_reason_codes": json.loads(row["overall_reason_codes_json"] or "[]"),
                "checks": json.loads(row["assessment_json"] or "{}").get("checks") or [],
                "judgment_version": row["judgment_version"],
                "evaluated_at": row["evaluated_at"],
            }
            for row in assessments
        ],
        decisions=[
            {
                "requirement_id": row["requirement_id"],
                "product_candidate_id": row["product_candidate_id"],
                "product_model_ref": row["product_model_ref"],
                "recommendation": row["recommendation"],
                "technical_verdict": row["technical_verdict"],
                "hard_spec_overall": row["hard_spec_overall"],
                "accepted": row["accepted"] == 1,
                "rationale": row["rationale"],
                "gaps": json.loads(row["gaps_json"] or "[]"),
                "next_actions": json.loads(row["next_actions_json"] or "[]"),
                "evidence_ids": json.loads(row["evidence_ids_json"] or "[]"),
                "priority_rank": row["priority_rank"],
                "price_conclusion": json.loads(row["decision_json"] or "{}").get("price_conclusion"),
                "violations": json.loads(row["violations_json"] or "[]"),
                "decided_at": row["decided_at"],
            }
            for row in decisions
        ],
        price_contexts=price_contexts,
        evidence=evidence,
        open_questions=[str(issue) for issue in (details.get("issues") or [])],
    )

    output.write_bytes(build_procurement_docx(report))
    print(f"the report was written: {output} ({output.stat().st_size} bytes)")
    print(
        f"requirements={len(report.requirements)} candidates={len(report.candidates)} "
        f"assessments={len(report.assessments)} decisions={len(report.decisions)} "
        f"price_contexts={len(report.price_contexts)} evidence={len(report.evidence)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
