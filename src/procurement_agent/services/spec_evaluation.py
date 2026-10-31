"""M3-A2: evaluate every requirement against every candidate.

The pipeline has three cached layers:

1. the typing of a claim, keyed by the claim, the evidence it came from, and
   the rules that typed it;
2. the alignment of a constraint with a candidate, keyed by the constraint, the
   typed claims of the candidate, and the rules that aligned them;
3. the assessment of a requirement against a candidate, keyed by the
   alignments, the typed claims, the calculator, and the aggregation rule.

A layer that is found in the cache is not asked of the model again. A layer
that is not found is computed and then stored, with the run that produced it,
the model configuration, the versions of the rules, and the digests of the
evidence.

The calculator itself is deterministic and always runs, so a cached alignment
still produces the same verdict from the same structured input.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from langchain_core.language_models import BaseChatModel

from procurement_agent.domain.judgment_cache import (
    CacheEntry,
    CacheLayer,
    JudgmentVersions,
    alignment_group_cache_key,
    assessment_group_cache_key,
    constraint_identity,
    typing_cache_key,
)
from procurement_agent.domain.requirements import Requirement
from procurement_agent.domain.sourcing import ClaimDraft, ResearchCandidate
from procurement_agent.domain.spec_alignment import (
    ProductAttributeClaim,
    SemanticAlignment,
    SpecAssessment,
)
from procurement_agent.services.judgment_cache import JudgmentCacheClient
from procurement_agent.services.spec_alignment import (
    ALIGNMENT_BATCH_SIZE,
    ALIGNMENT_CONCURRENCY,
    align_requirement,
    alignment_rules_version,
)
from procurement_agent.services.spec_calculator import (
    AGGREGATION_RULE_VERSION,
    CALCULATOR_VERSION,
    evaluate_requirement_product,
)
from procurement_agent.services.spec_typing import (
    TYPING_BATCH_SIZE,
    TYPING_CONCURRENCY,
    type_claims,
    typing_rules_version,
)


def default_versions(model_config: Mapping[str, Any] | None = None) -> JudgmentVersions:
    """The versions that decide whether two judgements are comparable."""
    return JudgmentVersions(
        typing_rules=typing_rules_version(),
        alignment_rules=alignment_rules_version(),
        model_config=str(sorted((model_config or {}).items())),
        calculator=CALCULATOR_VERSION,
        aggregation=AGGREGATION_RULE_VERSION,
    )


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


def _typed_claims_from_cache(
    *,
    claims: Sequence[ClaimDraft],
    evidence_hashes: Mapping[str, str],
    versions: JudgmentVersions,
    cache: JudgmentCacheClient | None,
) -> tuple[list[ProductAttributeClaim], list[ClaimDraft], dict[str, str]]:
    """The typed claims that are cached, and the ones that have to be typed."""
    keys = {
        claim.claim_id: typing_cache_key(
            claim=claim,
            evidence_hash=evidence_hashes.get(claim.evidence_id),
            versions=versions,
        )
        for claim in claims
    }
    if cache is None or not claims:
        return [], list(claims), keys
    payloads, missing = cache.lookup_many(CacheLayer.TYPING, keys)
    typed: list[ProductAttributeClaim] = []
    found: list[str] = []
    for claim in claims:
        payload = payloads.get(claim.claim_id)
        if payload is None:
            continue
        found.append(claim.claim_id)
        raw = payload.get("typed") if isinstance(payload, dict) else payload
        if raw is None:
            # The claim was typed and the model gave it no comparable value.
            # That is a result, and it is kept.
            continue
        try:
            typed.append(ProductAttributeClaim.model_validate(raw))
        except Exception:
            # A cached row that cannot be read is treated as absent.
            continue
    return typed, [claim for claim in claims if claim.claim_id not in found], keys


def _alignment_from_cache(
    *,
    requirement: Requirement,
    candidates: Sequence[tuple[str, Sequence[ProductAttributeClaim]]],
    versions: JudgmentVersions,
    cache: JudgmentCacheClient | None,
) -> tuple[dict[tuple[str, str], SemanticAlignment], list[tuple[str, Sequence[ProductAttributeClaim]]]]:
    """The alignments that are cached, and the candidates that have to be aligned."""
    keys: dict[str, str] = {}
    for constraint in requirement.constraints:
        for candidate_id, typed in candidates:
            keys[f"{constraint.constraint_id}|{candidate_id}"] = alignment_group_cache_key(
                constraint=constraint,
                typed_claims=typed,
                versions=versions,
            )
    if cache is None or not keys:
        return {}, list(candidates)
    payloads, missing = cache.lookup_many(CacheLayer.ALIGNMENT, keys)
    alignments: dict[tuple[str, str], SemanticAlignment] = {}
    for constraint in requirement.constraints:
        for candidate_id, _typed in candidates:
            payload = payloads.get(f"{constraint.constraint_id}|{candidate_id}")
            if payload is None:
                continue
            try:
                alignments[(constraint.constraint_id, candidate_id)] = SemanticAlignment.model_validate(payload)
            except Exception:
                continue
    pending = [
        (candidate_id, typed)
        for candidate_id, typed in candidates
        if any((constraint.constraint_id, candidate_id) not in alignments for constraint in requirement.constraints)
    ]
    return alignments, pending


def evaluate_candidates(
    **kwargs: Any,
) -> list[SpecAssessment]:
    """Evaluate every requirement against every candidate that belongs to it."""
    assessments, _digests = evaluate_candidates_with_digests(**kwargs)
    return assessments


def evaluate_candidates_with_digests(
    *,
    requirements: Sequence[Requirement],
    candidates: Sequence[ResearchCandidate],
    claims: Sequence[ClaimDraft],
    model: BaseChatModel | None = None,
    model_by_product: Mapping[str, str] | None = None,
    evidence: Mapping[str, str] | None = None,
    evidence_hashes: Mapping[str, str] | None = None,
    unresolved_demand: Mapping[str, Sequence[str]] | None = None,
    evaluated_at: datetime | None = None,
    typing_batch_size: int | None = None,
    alignment_batch_size: int | None = None,
    config: dict[str, Any] | None = None,
    typing_model: BaseChatModel | None = None,
    typing_concurrency: int | None = None,
    alignment_concurrency: int | None = None,
    cache: JudgmentCacheClient | None = None,
    versions: JudgmentVersions | None = None,
    source_run_id: str | None = None,
    source_project_id: str | None = None,
    model_config: Mapping[str, Any] | None = None,
) -> tuple[list[SpecAssessment], dict[tuple[str, str], str]]:
    """Evaluate every requirement against every candidate that belongs to it.

    The model is asked to type the claims and to propose the pairings. The
    calculator decides every status. The digest of every assessment is returned
    with it, so the caller can record which judgement produced the verdict.
    """
    if not requirements or not candidates:
        return [], {}
    moment = evaluated_at or datetime.now(UTC)
    product_models = dict(model_by_product or {})
    hashes = dict(evidence_hashes or {})
    rules = versions or default_versions(model_config)
    target_attributes = sorted(
        {constraint.attribute_key for requirement in requirements for constraint in requirement.constraints}
    )

    # Layer one: the typing of the claims.
    cached_typed, missing_claims, typing_keys = _typed_claims_from_cache(
        claims=claims,
        evidence_hashes=hashes,
        versions=rules,
        cache=cache,
    )
    typed_claims = list(cached_typed)
    if model is not None and missing_claims:
        fresh = type_claims(
            claims=missing_claims,
            target_attributes=target_attributes,
            model=typing_model or model,
            evidence=evidence,
            batch_size=typing_batch_size or TYPING_BATCH_SIZE,
            config=config,
            concurrency=typing_concurrency or TYPING_CONCURRENCY,
            fast_model=typing_model,
        )
        typed_claims.extend(fresh)
        if cache is not None and missing_claims:
            # Every claim that was typed is remembered, including the ones the
            # model did not type. A claim with no typed form is a result too,
            # and asking again would only produce a different answer.
            typed_by_id = {typed.claim_id: typed for typed in fresh}
            cache.store(
                [
                    CacheEntry(
                        layer=CacheLayer.TYPING,
                        input_digest=typing_keys[claim.claim_id],
                        payload={
                            "claim_id": claim.claim_id,
                            "typed": (
                                typed_by_id[claim.claim_id].model_dump(mode="json")
                                if claim.claim_id in typed_by_id
                                else None
                            ),
                        },
                        versions=rules.as_dict(),
                        model_config=dict(model_config or {}),
                        evidence_hashes=[claim.evidence_id] if claim.evidence_id else [],
                        source_run_id=source_run_id,
                        source_project_id=source_project_id,
                    )
                    for claim in missing_claims
                    if claim.claim_id in typing_keys
                ]
            )

    assessments: list[SpecAssessment] = []
    digests: dict[tuple[str, str], str] = {}
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

        group_typed: list[tuple[str, list[ProductAttributeClaim]]] = []
        for group in groups.values():
            group_typed.append(
                (
                    group[0].candidate_id,
                    _claims_for_candidate(
                        group[0],
                        typed_claims,
                        _candidate_model_ref(group[0], product_models),
                    ),
                )
            )

        # Layer two: the alignment of each constraint with each candidate.
        group_alignments, pending = _alignment_from_cache(
            requirement=requirement,
            candidates=group_typed,
            versions=rules,
            cache=cache,
        )
        pending = [
            (candidate_id, typed)
            for candidate_id, typed in pending
            if typed
        ]
        if model is not None and pending:
            fresh_alignments = align_requirement(
                constraints=requirement.constraints,
                candidates=pending,
                model=model,
                batch_size=alignment_batch_size or ALIGNMENT_BATCH_SIZE,
                config=config,
                concurrency=alignment_concurrency or ALIGNMENT_CONCURRENCY,
            )
            group_alignments.update(fresh_alignments)
            if cache is not None and fresh_alignments:
                entries: list[CacheEntry] = []
                for (constraint_id, candidate_id), alignment in fresh_alignments.items():
                    constraint = next(
                        (item for item in requirement.constraints if item.constraint_id == constraint_id),
                        None,
                    )
                    typed_for_candidate = next(
                        (typed for candidate, typed in group_typed if candidate == candidate_id),
                        [],
                    )
                    if constraint is None:
                        continue
                    entries.append(
                        CacheEntry(
                            layer=CacheLayer.ALIGNMENT,
                            input_digest=alignment_group_cache_key(
                                constraint=constraint,
                                typed_claims=typed_for_candidate,
                                versions=rules,
                            ),
                            payload=alignment.model_dump(mode="json"),
                            versions=rules.as_dict(),
                            model_config=dict(model_config or {}),
                            evidence_hashes=sorted(
                                {
                                    evidence_id
                                    for claim in typed_for_candidate
                                    for evidence_id in claim.evidence_ids
                                }
                            ),
                            source_run_id=source_run_id,
                            source_project_id=source_project_id,
                            verdict=alignment.status.value,
                        )
                    )
                cache.store(entries)

        for group in groups.values():
            model_ref = _candidate_model_ref(group[0], product_models)
            typed = _claims_for_candidate(group[0], typed_claims, model_ref)
            representative = group[0].candidate_id
            candidate_alignments = [
                group_alignments[(constraint.constraint_id, representative)]
                for constraint in requirement.constraints
                if (constraint.constraint_id, representative) in group_alignments
            ]
            assessment = evaluate_requirement_product(
                requirement=requirement,
                product_candidate_id=representative,
                product_model_ref=model_ref,
                claims=typed,
                alignments=candidate_alignments,
                unresolved_demand=(unresolved_demand or {}).get(requirement.requirement_id, ()),
                evaluated_at=moment,
            )
            # Layer three: the assessment itself, keyed by the alignments it
            # rests on, the calculator, and the aggregation rule.
            digest = assessment_group_cache_key(
                constraint_ids=[item.constraint_id for item in requirement.constraints],
                constraint_identities=[constraint_identity(item) for item in requirement.constraints],
                typed_claims=typed,
                alignments=candidate_alignments,
                versions=rules,
            )
            digests[(requirement.requirement_id, representative)] = digest
            if cache is not None:
                cache.store(
                    [
                        CacheEntry(
                            layer=CacheLayer.ASSESSMENT,
                            input_digest=digest,
                            payload={
                                key: value
                                for key, value in assessment.model_dump(mode="json").items()
                                if key != "evaluated_at"
                            },
                            versions=rules.as_dict(),
                            model_config=dict(model_config or {}),
                            evidence_hashes=sorted(
                                {
                                    evidence_id
                                    for check in assessment.checks
                                    for evidence_id in check.evidence_ids
                                }
                            ),
                            source_run_id=source_run_id,
                            source_project_id=source_project_id,
                            verdict=assessment.hard_spec_overall.value,
                            reason_codes=[code.value for code in assessment.overall_reason_codes],
                        )
                    ]
                )
            for candidate in group:
                assessments.append(
                    assessment.model_copy(update={"product_candidate_id": candidate.candidate_id})
                )
                digests[(requirement.requirement_id, candidate.candidate_id)] = digest
    return assessments, digests


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
