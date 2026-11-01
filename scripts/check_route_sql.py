"""Check the statements of the new gateway routes against the real database.

A statement with a wrong column name fails at the moment it runs, and the
gateway answers with an error page. This script runs every statement of the
new routes against the deployed database with a literal value, so a mistake
shows up before a browser meets it.

Usage: python scripts/check_route_sql.py [project_id]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def query(sql: str) -> tuple[bool, str]:
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
    # The command prints a banner before the answer, so the answer is read
    # from the first bracket that starts the document.
    text = completed.stdout
    start = text.find("[")
    try:
        payload = json.loads(text[start:]) if start >= 0 else json.loads(text)
    except json.JSONDecodeError:
        return False, "the command returned no answer" 
    if isinstance(payload, list) and payload and payload[0].get("success"):
        return True, f"{len(payload[0].get('results') or [])} rows"
    notes = (payload.get("error") or {}).get("notes") if isinstance(payload, dict) else None
    return False, json.dumps(notes or payload)[:220]


def main() -> int:
    project_id = sys.argv[1] if len(sys.argv) > 1 else ""
    if not project_id:
        try:
            project_id = json.loads(
                subprocess.run(
                    [
                        "npx.cmd",
                        "wrangler",
                        "d1",
                        "execute",
                        "DB",
                        "--remote",
                        "--command",
                        "SELECT id FROM projects ORDER BY created_at DESC LIMIT 1",
                        "--json",
                    ],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                ).stdout
            )[0]["results"][0]["id"]
        except Exception:
            print("could not read a project to test with")
            return 2

    def one_line(statement: str) -> str:
        return " ".join(part for part in statement.split() if part)

    statements = {
        "projects list": f"""
			SELECT p.id, p.title, p.history_availability, p.demand_revision, p.analysis_version,
			       p.created_at,
			       (SELECT r.id FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_id,
			       (SELECT r.status FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_status,
			       (SELECT r.current_stage FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_stage,
			       (SELECT r.updated_at FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_updated_at
			FROM projects p
			ORDER BY p.created_at DESC LIMIT 5""",
        "project runs": f"""
			SELECT r.id, r.status, r.current_stage, r.last_error, r.artifact_key, r.created_at, r.updated_at,
			       (SELECT c.stop_reason_code FROM research_run_costs c WHERE c.run_id = r.id) AS stop_reason_code
			FROM runs r
			WHERE r.project_id = '{project_id}'
			ORDER BY r.created_at DESC LIMIT 100""",
        "requirement text": f"""
			SELECT id, revision, text_content FROM source_inputs
			WHERE project_id = '{project_id}' AND purpose = 'REQUIREMENT' AND source_type = 'USER_TEXT'
			ORDER BY revision DESC LIMIT 1""",
        "compile status": f"""
			SELECT id, job_type, status, error, detail_json, created_at, updated_at
			FROM project_jobs
			WHERE workspace_id = 'default' AND project_id = '{project_id}' AND id = 'none' AND job_type = 'COMPILE'""",
        "job status": f"""
			SELECT id, status, error, detail_json, created_at, updated_at
			FROM project_jobs
			WHERE workspace_id = 'default' AND project_id = '{project_id}' AND job_type = 'DECISION'
			ORDER BY created_at DESC LIMIT 1""",
        "reports list": f"""
			SELECT id, run_id, status, decision_version, byte_size, sha256, error, created_at, updated_at
			FROM project_reports
			WHERE workspace_id = 'default' AND project_id = '{project_id}'
			ORDER BY created_at DESC LIMIT 100""",
        "report status": f"""
			SELECT id, run_id, status, decision_version, byte_size, sha256, error, created_at, updated_at
			FROM project_reports
			WHERE workspace_id = 'default' AND project_id = '{project_id}' AND id = 'none'""",
        "report candidates": f"""
			SELECT c.id AS candidate_id, c.requirement_id, c.stage, c.rationale,
			       c.open_questions_json, s.display_name AS supplier_name,
			       p.model AS product_model, p.product_name,
			       (SELECT group_concat(e.evidence_id) FROM project_candidate_evidence e
			        WHERE e.workspace_id = c.workspace_id AND e.candidate_id = c.id) AS evidence_ids
			FROM project_candidates c
			LEFT JOIN intelligence_suppliers s ON s.workspace_id = c.workspace_id AND s.id = c.supplier_id
			LEFT JOIN intelligence_products p ON p.workspace_id = c.workspace_id AND p.id = c.product_id
			WHERE c.workspace_id = 'default' AND c.project_id = '{project_id}'
			ORDER BY c.updated_at DESC LIMIT 600""",
        "report assessments": f"""
			SELECT s.requirement_id, s.product_candidate_id, s.product_model_ref,
			       s.hard_spec_overall, s.overall_reason_codes_json, s.assessment_json,
			       s.judgment_version, s.evaluated_at
			FROM spec_assessments s
			WHERE s.workspace_id = 'default' AND s.project_id = '{project_id}'
			  AND s.judgment_version = (
			    SELECT MAX(inner_s.judgment_version) FROM spec_assessments inner_s
			    WHERE inner_s.workspace_id = s.workspace_id AND inner_s.project_id = s.project_id
			      AND inner_s.requirement_id = s.requirement_id
			      AND inner_s.product_candidate_id = s.product_candidate_id
			      AND inner_s.demand_revision = s.demand_revision)
			ORDER BY s.requirement_id, s.product_candidate_id""",
        "report decisions": f"""
			SELECT d.requirement_id, d.product_candidate_id, d.product_model_ref, d.recommendation,
			       d.technical_verdict, d.hard_spec_overall, d.accepted, d.rationale, d.gaps_json,
			       d.next_actions_json, d.evidence_ids_json, d.priority_rank, d.decision_json,
			       d.violations_json, d.decided_at
			FROM sourcing_decisions d
			WHERE d.workspace_id = 'default' AND d.project_id = '{project_id}'
			ORDER BY d.requirement_id, d.product_candidate_id""",
        "report history": f"""
			SELECT normalized_r2_key FROM history_datasets WHERE project_id = '{project_id}'
			ORDER BY imported_at DESC LIMIT 1""",
        "report evidence": f"""
			SELECT id, title, source_url, excerpt, content_sha256 FROM research_evidence
			WHERE workspace_id = 'default' AND id IN ('none')""",
    }

    failures = 0
    for name, statement in statements.items():
        ok, detail = query(one_line(statement))
        print(f"{'ok  ' if ok else 'FAIL'}  {name}: {detail}")
        if not ok:
            failures += 1
    print(f"\n{len(statements) - failures} of {len(statements)} statements work")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
