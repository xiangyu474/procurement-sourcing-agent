"""M3-C decision orchestration: the Supervisor proposes, the gate decides.

The Supervisor sees a summary of the computed analysis, not the raw sources.
Every assessment, every check, and every price finding is already a small
record with an ID, and the evidence is referred to by ID. That is deliberate:
in M2 the supervisor consumed 77 percent of the input tokens because every
round carried the researcher's full findings and quotations in its context.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import ValidationError

from procurement_agent.domain.decision import (
    DecisionBatch,
    DecisionProposal,
    SourcingDecision,
)
from procurement_agent.domain.pricing import PriceFinding
from procurement_agent.domain.spec_alignment import SpecAssessment
from procurement_agent.infra.llm import json_object_from_text, stream_tool_call
from procurement_agent.services.decision_gate import verify_batch

SYSTEM_PROMPT = """You write the sourcing decision for one requirement, based on the analysis that was already computed.

You receive, per candidate, the technical check that was computed, the price
analysis that was computed, and the identifiers of the evidence that exists.
You do not receive the pages themselves.

Rules:
- The technical verdict must match the check. VERIFIED_PASS only when the check says PASS, VERIFIED_FAIL only when it says FAIL, UNVERIFIED when it says UNKNOWN. Never write UNKNOWN as a pass.
- A candidate whose check is FAIL must not be shortlisted. Recommend EXCLUDE and state which requirement failed.
- A candidate whose check is UNKNOWN may be shortlisted only when you name what is missing in gaps.
- Only cite evidence identifiers that are listed. Never invent an identifier.
- Only state a price conclusion when the price analysis produced one. Never state a saving that the analysis does not show.
- Recommend INVESTIGATE when a gap is worth another research round, and say what to look for in next_actions.
- Recommend SHORTLIST only for a candidate that passes the check, or whose unknown is worth confirming with the supplier.
- Keep the rationale under 200 characters. Do not repeat the whole analysis."""


def build_decision_context(
    *,
    assessments: Sequence[SpecAssessment],
    price_findings: Mapping[str, Sequence[PriceFinding]] | None = None,
    known_evidence_ids: Sequence[str] = (),
) -> list[dict[str, Any]]:
    """The compact summary the Supervisor reads."""
    findings = price_findings or {}
    context: list[dict[str, Any]] = []
    for assessment in assessments:
        entry: dict[str, Any] = {
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
                    "evidence_ids": check.evidence_ids,
                }
                for check in assessment.checks
            ],
            "prices": [
                {
                    "basis": finding.lowest_basis.value if finding.lowest_basis else None,
                    "lowest_observation_id": finding.lowest_observation_id,
                    "lowest_value": finding.lowest_value,
                    "saving": finding.saving,
                    "saving_percent": finding.saving_percent,
                    "comparability": finding.comparability.value,
                }
                for finding in findings.get(assessment.requirement_id, ())
            ],
        }
        context.append(entry)
    if known_evidence_ids:
        context.append({"known_evidence_ids": list(known_evidence_ids)[:200]})
    return context


def propose_decisions(
    *,
    context: Sequence[dict[str, Any]],
    model: BaseChatModel,
) -> list[DecisionProposal]:
    """Ask the Supervisor for one decision per candidate."""
    if not context:
        return []
    proposals: list[DecisionProposal] = []
    for attempt in range(2):
        try:
            calls, text = stream_tool_call(
                model,
                [
                    SystemMessage(content=SYSTEM_PROMPT),
                    HumanMessage(content=json.dumps(list(context), ensure_ascii=False)),
                ]
                + (
                    [HumanMessage(content="Answer with one decision for every candidate.")]
                    if attempt
                    else []
                ),
                DecisionBatch,
            )
        except Exception:
            # The provider failed. Without a proposal there is no decision,
            # and the gate would block it anyway.
            break
        for raw in calls:
            try:
                proposals.extend(DecisionBatch.model_validate(raw).decisions)
            except ValidationError:
                continue
        if proposals:
            break
        found = json_object_from_text(text)
        if found is not None:
            try:
                proposals.extend(DecisionBatch.model_validate(found).decisions)
            except ValidationError:
                pass
            break
    return proposals


def decide(
    *,
    project_id: str,
    assessments: Sequence[SpecAssessment],
    model: BaseChatModel,
    price_findings: Mapping[str, Sequence[PriceFinding]] | None = None,
    known_evidence_ids: Sequence[str] = (),
    decided_at: datetime | None = None,
) -> list[SourcingDecision]:
    """Produce the decisions of a project and put them through the gate."""
    if not assessments:
        return []
    context = build_decision_context(
        assessments=assessments,
        price_findings=price_findings,
        known_evidence_ids=known_evidence_ids,
    )
    proposals = propose_decisions(context=context, model=model)
    by_key = {
        (assessment.requirement_id, assessment.product_candidate_id): assessment
        for assessment in assessments
    }
    return verify_batch(
        proposals,
        project_id=project_id,
        assessments=by_key,
        known_evidence_ids=known_evidence_ids,
        price_findings=price_findings,
        decided_at=decided_at,
    )


def decision_summary(decisions: Sequence[SourcingDecision]) -> dict[str, Any]:
    """Count the decisions by recommendation and by acceptance."""
    summary: dict[str, Any] = {
        "decisions": len(decisions),
        "accepted": len([item for item in decisions if item.accepted]),
        "rejected": len([item for item in decisions if not item.accepted]),
        "by_recommendation": {},
        "violations": {},
    }
    for decision in decisions:
        key = decision.recommendation.value
        summary["by_recommendation"][key] = summary["by_recommendation"].get(key, 0) + 1
        for violation in decision.violations:
            summary["violations"][violation.code.value] = summary["violations"].get(violation.code.value, 0) + 1
    return summary
