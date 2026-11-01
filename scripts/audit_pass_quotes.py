"""Audit the quotes that the passing technical checks rest on.

A verdict is only as good as the quotation it rests on. This script reads the
assessments of a project, takes the claims behind every passing check, and
prints the quotation each one rests on, so a reader can see whether the source
stated a specification or only a product name.
"""

from __future__ import annotations

import json
import subprocess
import sys


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
    project_id = sys.argv[1] if len(sys.argv) > 1 else ""
    if not project_id:
        print("usage: audit_pass_quotes.py <project_id>")
        return 2

    assessments = query(
        "SELECT product_model_ref, assessment_json FROM spec_assessments "
        f"WHERE project_id='{project_id}' AND hard_spec_overall='PASS'"
    )
    claim_ids: list[str] = []
    model_of: dict[str, str] = {}
    for row in assessments:
        assessment = json.loads(row["assessment_json"])
        for check in assessment.get("checks", []):
            for claim_id in check.get("claim_ids", []):
                if claim_id not in model_of:
                    claim_ids.append(claim_id)
                    model_of[claim_id] = row["product_model_ref"] or "?"

    print(f"passing assessments: {len(assessments)}, claims behind them: {len(claim_ids)}")
    if not claim_ids:
        return 0

    ids = ",".join(f"'{claim_id}'" for claim_id in claim_ids)
    claims = query(
        "SELECT cc.id, cc.attribute, cc.value, cc.unit, ce.source_quote "
        "FROM research_claims cc JOIN claim_evidence_links ce "
        "ON ce.workspace_id=cc.workspace_id AND ce.claim_id=cc.id "
        f"WHERE cc.id IN ({ids})"
    )
    seen: dict[str, dict] = {}
    for claim in claims:
        seen.setdefault(claim["id"], claim)

    for claim_id, claim in seen.items():
        print(f"[{model_of.get(claim_id, '?')}] attribute={claim['attribute']!r} unit={claim['unit']!r}")
        print(f"    value : {claim['value'][:160]!r}")
        print(f"    quote : {claim['source_quote'][:200]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
