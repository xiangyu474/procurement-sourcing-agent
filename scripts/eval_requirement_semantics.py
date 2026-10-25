"""Run the small, gold-labelled live M1 semantics suite against the configured model.

This is a paid/live evaluation, not a unit test. It reports semantic label
accuracy separately from Pydantic schema validity and never prints secrets.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from procurement_agent.domain.requirements import RequirementConstraint
from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.ingestion.compiler import compile_requirement_fragments
from procurement_agent.ingestion.text import extract_text_fragments


def main() -> int:
    load_dotenv()
    settings = load_settings()
    if not settings.has_llm:
        print(json.dumps({"status": "BLOCKED", "missing_model_config": True}))
        return 2

    cases = json.loads(
        (Path(__file__).resolve().parents[1] / "tests/fixtures/requirement_semantics.json")
        .read_text(encoding="utf-8")
    )
    model = build_chat_model(settings, timeout=90)
    outcomes = []
    for case in cases:
        fragment = extract_text_fragments(
            project_id=f"semantic-{case['case_id']}",
            revision=1,
            source_id=f"fixture-{case['case_id']}",
            text=case["input"],
        )[0]
        try:
            result = compile_requirement_fragments(
                project_id=f"semantic-{case['case_id']}",
                fragments=[fragment],
                model=model,
                revision=1,
            )
        except Exception as exc:
            outcomes.append(
                {
                    "case_id": case["case_id"],
                    "passed": False,
                    "provider_error": type(exc).__name__,
                }
            )
            # Stop immediately on provider outage; do not repeatedly spend API
            # calls for tests that cannot execute until service recovers.
            break
        constraints: list[RequirementConstraint] = [
            constraint
            for requirement in result.compilation.requirements
            for constraint in requirement.constraints
        ]
        gold = case["gold"]
        if gold["expect"] == "constraint":
            matching = [c for c in constraints if c.attribute_key in gold["attribute_aliases"]]
            passed = bool(matching)
            if matching:
                item = matching[0]
                passed &= item.importance.value == gold["importance"]
                passed &= item.parse_status.value == gold["parse_status"]
                if "operator" in gold:
                    passed &= item.operator.value == gold["operator"]
                if "value" in gold:
                    passed &= str(item.value) == gold["value"]
                if "unit" in gold:
                    passed &= item.unit == gold["unit"]
                if gold.get("not_importance"):
                    passed &= item.importance.value != gold["not_importance"]
        elif gold["expect"] in {"ambiguous", "unsupported"}:
            passed = bool(result.compilation.unstructured_requirements) or any(
                c.parse_status.value in {"AMBIGUOUS", "UNSUPPORTED"} for c in constraints
            )
            if gold.get("must_not_have_resolved_hard_pass"):
                passed &= not any(
                    c.importance.value == "HARD" and c.parse_status.value == "RESOLVED"
                    for c in constraints
                )
            if gold.get("must_not_invent_numeric_constraint"):
                passed &= not any(c.value_type.value == "NUMBER" for c in constraints)
        else:
            passed = False

        outcomes.append(
            {
                "case_id": case["case_id"],
                "passed": bool(passed),
                "requirement_count": len(result.compilation.requirements),
                "constraint_count": len(constraints),
                "unstructured_count": len(result.compilation.unstructured_requirements),
                "issues": result.compilation.issues[:3],
            }
        )

    passed_count = sum(1 for outcome in outcomes if outcome["passed"])
    provider_errors = sum(1 for outcome in outcomes if "provider_error" in outcome)
    if provider_errors:
        status = "BLOCKED_PROVIDER"
    else:
        status = "PASS" if passed_count == len(outcomes) else "FAIL"
    print(json.dumps({"status": status, "passed": passed_count, "total": len(outcomes), "cases": outcomes}, ensure_ascii=False, indent=2))
    return 0 if status == "PASS" else (2 if status == "BLOCKED_PROVIDER" else 1)


if __name__ == "__main__":
    sys.exit(main())
