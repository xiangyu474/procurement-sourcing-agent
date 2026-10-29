"""M3-A2: evaluate every requirement against every candidate.

The pipeline is: the research claims are typed, the constraints are aligned
with the typed claims, and the pure calculator turns the result into PASS,
FAIL, or UNKNOWN. The model never decides a verdict.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from langchain_core.language_models import BaseChatModel

from procurement_agent.domain.requirements import Requirement
from procurement_agent.domain.sourcing import ClaimDraft, ResearchCandidate
from procurement_agent.domain.spec_alignment import (
    ProductAttributeClaim,
    SemanticAlignment,
    SpecAssessment,
)
from procurement_agent.services.spec_alignment import align_requirement
from procurement_agent.services.spec_calculator import evaluate_requirement_product
from procurement_agent.services.spec_typing import type_claims


def _candidate_model_ref(candidate: ResearchCandidate, model_by_product: Mapping[str, str]) -> str | None:
    """The exact model code of a candidate, when the research recorded one."""
    if not candidate.product_id:
        return None
    return model_by_product.get(candidate.product_id)


def _claims_for_candidate(
    candidate: ResearchCandidate,
    typed_claims: Sequence[ProductAttributeClaim],
    product_model_ref: str | None,
) -> list[ProductAttributeClaim]:
    """The typed claims that belong to one candidate.

    The claims are copied with the candidate and the model code they belong to,
    so the calculator compares a claim with the model it was read from.
    """
    subjects = {candidate.candidate_id}
    if candidate.product_id:
        subjects.add(candidate.product_id)
    return [
        claim.model_copy(
            update={
                "product_candidate_id": candidate.candidate_id,
                "product_model_ref": product_model_ref,
            }
        )
        for claim in typed_claims
        if claim.product_ref in subjects
    ]


def evaluate_candidates(
    *,
    requirements: Sequence[Requirement],
    candidates: Sequence[ResearchCandidate],
    claims: Sequence[ClaimDraft],
    model: BaseChatModel | None = None,
    model_by_product: Mapping[str, str] | None = None,
    evidence: Mapping[str, str] | None = None,
    unresolved_demand: Mapping[str, Sequence[str]] | None = None,
    evaluated_at: datetime | None = None,
) -> list[SpecAssessment]:
    """Evaluate every requirement against every candidate that belongs to it.

    The model is asked to type the claims and to propose the pairings. The
    calculator decides every status.
    """
    if not requirements or not candidates:
        return []
    moment = evaluated_at or datetime.now(UTC)
    product_models = dict(model_by_product or {})

    typed_claims: list[ProductAttributeClaim] = []
    target_attributes = sorted(
        {constraint.attribute_key for requirement in requirements for constraint in requirement.constraints}
    )
    if model is not None:
        typed_claims = type_claims(
            claims=claims,
            target_attributes=target_attributes,
            model=model,
            evidence=evidence,
        )

    assessments: list[SpecAssessment] = []
    for requirement in requirements:
        own_candidates = [candidate for candidate in candidates if candidate.requirement_id == requirement.requirement_id]
        if not own_candidates:
            continue
        # The unit of the technical check is the requirement and the product
        # model. Several candidate rows can point at the same model, so the
        # alignment is done once per model and the verdicts are shared.
        groups: dict[str, list[ResearchCandidate]] = {}
        for candidate in own_candidates:
            product_ref = _candidate_model_ref(candidate, product_models)
            key = product_ref or candidate.product_id or candidate.candidate_id
            groups.setdefault(key, []).append(candidate)

        for group_key, group in groups.items():
            model_ref = _candidate_model_ref(group[0], product_models)
            typed = _claims_for_candidate(
                group[0],
                typed_claims,
                model_ref,
            )
            representative = group[0].candidate_id
            alignments: dict[tuple[str, str], SemanticAlignment] = {}
            if model is not None:
                alignments = align_requirement(
                    constraints=requirement.constraints,
                    candidates=[(representative, typed)],
                    model=model,
                )
            candidate_alignments = [
                alignments[(constraint.constraint_id, representative)]
                for constraint in requirement.constraints
                if (constraint.constraint_id, representative) in alignments
            ]
            for candidate in group:
                assessments.append(
                    evaluate_requirement_product(
                        requirement=requirement,
                        product_candidate_id=candidate.candidate_id,
                        product_model_ref=model_ref,
                        claims=typed,
                        alignments=candidate_alignments,
                        unresolved_demand=(unresolved_demand or {}).get(requirement.requirement_id, ()),
                        evaluated_at=moment,
                    )
                )
    return assessments


def summarize(assessments: Sequence[SpecAssessment]) -> dict[str, Any]:
    """Count the assessments by their overall status."""
    counts: dict[str, int] = {}
    for assessment in assessments:
        key = assessment.hard_spec_overall.value
        counts[key] = counts.get(key, 0) + 1
    return {
        "assessments": len(assessments),
        "by_overall": counts,
        "requirements": sorted({assessment.requirement_id for assessment in assessments}),
        "models": sorted({assessment.product_model_ref or "" for assessment in assessments}),
    }
