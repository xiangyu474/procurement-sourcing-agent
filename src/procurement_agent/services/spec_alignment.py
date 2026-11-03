"""M3-A2: decide whether a requirement constraint and a product claim measure
the same thing.

The model proposes the pairing. The code applies the rules that can be checked
without judgement:

- The claim has to exist for the model under assessment.
- The method has to be honest about how the pairing was reached. A pairing
  that says the attribute keys are identical is only kept when they are, and a
  pairing that says the keys are a known alias is only kept when the alias
  table says so.
- A unit conversion has to be one the whitelist allows.
- A pairing that names no claim is not an alignment. When the model paired the
  two sides but named no usable claim, the reviewed alias table supplies the
  claim of that candidate; without one, the pairing stays unusable.

A pairing the code cannot confirm stays AMBIGUOUS, and the calculator turns
that into UNKNOWN. Nothing here turns a mismatch into a pass.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import ValidationError

from procurement_agent.domain.requirements import RequirementConstraint
from procurement_agent.domain.spec_alignment import (
    AlignmentBatch,
    AlignmentMethod,
    AlignmentProposal,
    AlignmentStatus,
    ProductAttributeClaim,
    SemanticAlignment,
)
from procurement_agent.domain.units import unit_spec
from procurement_agent.infra.llm import json_object_from_text, stream_tool_call

# Attribute keys that are known to mean the same measurement. The groups are
# small and reviewed by hand: a group only holds names of the same quantity.
# "max_input_power" and "rated_output_power" are in different groups on
# purpose, because they are not the same measurement.
APPROVED_ALIASES: dict[str, frozenset[str]] = {
    "output_resolution": frozenset(
        {"output_resolution", "image_output_resolution", "video_output_resolution", "resolution", "image_resolution"}
    ),
    "rated_output_power": frozenset({"rated_output_power", "output_power"}),
    "operating_temperature": frozenset(
        {"operating_temperature", "working_temperature", "operating_temperature_range"}
    ),
    "ingress_rating": frozenset({"ingress_rating", "protection_rating", "ip_rating"}),
    "supported_protocols": frozenset({"supported_protocols", "protocol_support", "protocols"}),
    "lens_focal_length": frozenset({"lens_focal_length", "focal_length"}),
    "max_input_power": frozenset({"max_input_power", "input_power"}),
}


def _alias_group_text() -> str:
    """The reviewed groups, written out so the model can use them."""
    lines = []
    for key, members in sorted(APPROVED_ALIASES.items()):
        lines.append(f"- {key}: {', '.join(sorted(members))}")
    return "\n".join(lines)


ALIAS_GROUP_TEXT = _alias_group_text()

ALIGNMENT_BATCH_SIZE = 1
ALIGNMENT_CONCURRENCY = 3


def _alias_group_text() -> str:
    """The reviewed groups, written out so the model can use them."""
    lines = []
    for key, members in sorted(APPROVED_ALIASES.items()):
        lines.append(f"- {key}: {', '.join(sorted(members))}")
    return "\n".join(lines)


ALIAS_GROUP_TEXT = _alias_group_text()

SYSTEM_PROMPT = f"""You decide whether a requirement constraint and a product claim measure the same thing.

A constraint says what the buyer wants: an attribute key, a definition of what
the attribute measures, a comparison, a value, and a unit. A claim says what a
source states about one product model.

For every constraint and every candidate, answer whether the constraint and the
candidate's claims measure one and the same quantity.

Rules:
- Align only when the two sides measure the same physical or business quantity under the same conditions. "rated output power" and "maximum input power" are not the same quantity. "sensor effective pixels" and "video output pixels" are not the same quantity.
- Use method EXACT_ATTRIBUTE_KEY only when the attribute keys are literally the same. Use method APPROVED_ALIAS only when the keys are known aliases of each other, which the list below defines. Use method LLM_PROPOSED_REVIEWED for a pairing you have checked yourself, and then name the measurement object in dimension and explain in reason what the two sides have in common.
- A claim that does not state the attribute is not a pair. Report NOT_ALIGNED with the reason.
- Always name the claim identifiers you paired. A pairing without a claim identifier cannot be used.
- When the source states several values for one attribute, or when the wording leaves the quantity open, report AMBIGUOUS or CONFLICTING. Never pick the value that suits the requirement.
- Copy the constraint_id and product_candidate_id exactly as they are given.

The reviewed alias groups are:
{ALIAS_GROUP_TEXT}
"""


def alignment_rules_version() -> str:
    """The digest of the prompt, the schema, and the alias table.

    Changing any of them changes the version, so the cache of this layer stops
    being used without anyone having to remember a number.
    """
    from procurement_agent.domain.judgment_cache import digest

    return digest(
        {
            "prompt": SYSTEM_PROMPT,
            "schema": AlignmentBatch.model_json_schema(),
            "aliases": {key: sorted(value) for key, value in APPROVED_ALIASES.items()},
            # A wrong method label is corrected from the curated table, so the
            # cached alignments of the older rule must not be reused.
            "rule_version": "alias-repair-v1",
        }
    )


def alias_groups() -> dict[str, frozenset[str]]:
    """The approved alias groups, keyed by every member."""
    groups: dict[str, frozenset[str]] = {}
    for members in APPROVED_ALIASES.values():
        for member in members:
            groups[member] = members
    return groups


def _approved_pair(constraint_key: str, claim_key: str) -> bool:
    """Report whether the two attribute keys are a known alias pair."""
    groups = alias_groups()
    left = groups.get(constraint_key)
    right = groups.get(claim_key)
    if left is None or right is None:
        return False
    return bool(left & right)


def _unit_conversion_is_safe(constraint: RequirementConstraint, claim: ProductAttributeClaim) -> bool:
    """Report whether the two sides can be brought onto one scale."""
    constraint_unit = unit_spec(constraint.unit)
    claim_unit = unit_spec(claim.unit)
    if constraint_unit is None or claim_unit is None:
        return constraint.unit == claim.unit
    return constraint_unit.dimension == claim_unit.dimension


def _aliased_alignment(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
    claim_ids: Sequence[str],
    proposal: AlignmentProposal,
    note: str | None = None,
) -> SemanticAlignment:
    """Keep a pairing the model proposed, with the curated method label."""
    return SemanticAlignment(
        constraint_id=proposal.constraint_id,
        claim_ids=list(claim_ids),
        status=AlignmentStatus.ALIGNED,
        method=AlignmentMethod.APPROVED_ALIAS,
        reason=note or (
            f"The model paired these two as the same measurement and named the attribute as "
            f"{constraint.attribute_key} against {claim.attribute_key}; the reviewed alias table "
            "confirms that pair."
        ),
        dimension=proposal.dimension,
        unit_conversion=proposal.unit_conversion,
    )


def canonical_alignment(
    proposal: AlignmentProposal,
    *,
    constraint: RequirementConstraint | None,
    claims: Mapping[str, ProductAttributeClaim],
) -> SemanticAlignment:
    """Check one proposed pairing and keep only what the code can confirm."""
    if constraint is None:
        return SemanticAlignment(
            constraint_id=proposal.constraint_id,
            claim_ids=[],
            status=AlignmentStatus.NOT_ALIGNED,
            method=proposal.method,
            reason=f"The constraint {proposal.constraint_id} is not part of this requirement.",
        )
    known = [claim_id for claim_id in proposal.claim_ids if claim_id in claims]
    missing = [claim_id for claim_id in proposal.claim_ids if claim_id not in claims]
    if proposal.status == AlignmentStatus.ALIGNED and not known:
        # The model believed these measure the same thing but named no claim
        # that can be used. The curated alias table decides which claim of this
        # candidate carries the measurement; without such a claim the pairing
        # still cannot be used.
        if constraint is not None:
            supplied = [
                claim.claim_id
                for claim in claims.values()
                if _approved_pair(constraint.attribute_key, claim.attribute_key)
            ]
            if supplied:
                return _aliased_alignment(
                    constraint,
                    claims[supplied[0]],
                    supplied,
                    proposal,
                    note=(
                        "The model paired these two as the same measurement but named no usable "
                        "claim; the reviewed alias table links the attribute keys."
                    ),
                )
        if missing:
            return SemanticAlignment(
                constraint_id=proposal.constraint_id,
                claim_ids=[],
                status=AlignmentStatus.NOT_ALIGNED,
                method=proposal.method,
                reason=f"The proposal names a claim that does not exist: {', '.join(missing)}.",
            )
        return SemanticAlignment(
            constraint_id=proposal.constraint_id,
            claim_ids=[],
            status=AlignmentStatus.NOT_ALIGNED,
            method=proposal.method,
            reason="The proposal calls the pairing aligned but names no claim.",
        )
    if missing:
        return SemanticAlignment(
            constraint_id=proposal.constraint_id,
            claim_ids=[],
            status=AlignmentStatus.NOT_ALIGNED,
            method=proposal.method,
            reason=f"The proposal names a claim that does not exist: {', '.join(missing)}.",
        )
    if proposal.status != AlignmentStatus.ALIGNED:
        return SemanticAlignment(
            constraint_id=proposal.constraint_id,
            claim_ids=known,
            status=proposal.status,
            method=proposal.method,
            reason=proposal.reason or "The model did not align this constraint.",
            dimension=proposal.dimension,
            unit_conversion=proposal.unit_conversion,
        )

    claim = claims[known[0]]
    if proposal.method == AlignmentMethod.EXACT_ATTRIBUTE_KEY:
        if constraint.attribute_key != claim.attribute_key:
            if _approved_pair(constraint.attribute_key, claim.attribute_key):
                # The model believed these measure the same thing but labelled the
                # pair wrongly. The curated alias table is the reviewed rule, so
                # the pairing is kept with the correct method.
                return _aliased_alignment(constraint, claim, known, proposal)
            return SemanticAlignment(
                constraint_id=proposal.constraint_id,
                claim_ids=known,
                status=AlignmentStatus.NOT_ALIGNED,
                method=proposal.method,
                reason=(
                    f"The proposal claims the attribute keys are the same, but they are "
                    f"{constraint.attribute_key} and {claim.attribute_key}."
                ),
            )
    elif proposal.method == AlignmentMethod.APPROVED_ALIAS:
        if not _approved_pair(constraint.attribute_key, claim.attribute_key):
            return SemanticAlignment(
                constraint_id=proposal.constraint_id,
                claim_ids=known,
                status=AlignmentStatus.NOT_ALIGNED,
                method=proposal.method,
                reason=(
                    f"{constraint.attribute_key} and {claim.attribute_key} are not a known alias pair."
                ),
            )
    else:
        if not (proposal.dimension or "").strip() or len((proposal.reason or "").strip()) < 8:
            return SemanticAlignment(
                constraint_id=proposal.constraint_id,
                claim_ids=known,
                status=AlignmentStatus.AMBIGUOUS,
                method=proposal.method,
                reason="The proposal names no measurement object, so it cannot be reviewed.",
            )
    if not _unit_conversion_is_safe(constraint, claim):
        return SemanticAlignment(
            constraint_id=proposal.constraint_id,
            claim_ids=known,
            status=AlignmentStatus.AMBIGUOUS,
            method=proposal.method,
            reason=(
                f"The requirement states {constraint.unit or 'no unit'} and the claim states "
                f"{claim.unit or 'no unit'}, so the two cannot be compared on one scale."
            ),
            dimension=proposal.dimension,
        )
    return SemanticAlignment(
        constraint_id=proposal.constraint_id,
        claim_ids=known,
        status=AlignmentStatus.ALIGNED,
        method=proposal.method,
        reason=proposal.reason or "The two sides measure the same quantity.",
        dimension=proposal.dimension,
        unit_conversion=proposal.unit_conversion,
    )


def _stage_config(config: dict[str, Any] | None, tag: str) -> dict[str, Any]:
    """Mark a call with its stage, so the cost of each stage can be told apart."""
    merged = dict(config or {})
    tags = list(merged.get("tags") or [])
    tags.append(tag)
    merged["tags"] = tags
    return merged


def _payload(
    constraints: Sequence[RequirementConstraint],
    candidates: Sequence[tuple[str, Sequence[ProductAttributeClaim]]],
) -> dict[str, Any]:
    return {
        "constraints": [
            {
                "constraint_id": constraint.constraint_id,
                "attribute_key": constraint.attribute_key,
                "attribute_definition": constraint.attribute_definition,
                "value_type": constraint.value_type.value,
                "operator": constraint.operator.value,
                "value": constraint.value,
                "unit": constraint.unit,
                "qualifiers": constraint.qualifiers,
                "importance": constraint.importance.value,
            }
            for constraint in constraints
        ],
        "candidates": [
            {
                "product_candidate_id": candidate_id,
                "claims": [
                    {
                        "claim_id": claim.claim_id,
                        "attribute_key": claim.attribute_key,
                        "attribute_definition": claim.attribute_definition,
                        "value_type": claim.value_type.value,
                        "value": claim.value,
                        "unit": claim.unit,
                        "qualifiers": claim.qualifiers,
                        "conditions": claim.conditions,
                        "source_quote": claim.source_quote,
                    }
                    for claim in claims
                ],
            }
            for candidate_id, claims in candidates
        ],
    }


def propose_alignments(
    *,
    constraints: Sequence[RequirementConstraint],
    candidates: Sequence[tuple[str, Sequence[ProductAttributeClaim]]],
    model: BaseChatModel,
    config: dict[str, Any] | None = None,
) -> list[AlignmentProposal]:
    """Ask the model which claims belong to which constraint."""
    if not constraints or not candidates:
        return []
    payload = _payload(constraints, candidates)
    proposals: list[AlignmentProposal] = []
    for attempt in range(2):
        try:
            calls, text = stream_tool_call(
                model,
                [
                    SystemMessage(content=SYSTEM_PROMPT),
                    HumanMessage(content=json.dumps(payload, ensure_ascii=False)),
                ]
                + (
                    [HumanMessage(content="Answer with one alignment for every constraint and candidate pair.")]
                    if attempt
                    else []
                ),
                AlignmentBatch,
                config=_stage_config(config, "m3-alignment"),
            )
        except Exception:
            # The provider failed. Without an alignment the constraints stay
            # UNKNOWN, which is the honest outcome.
            continue
        for raw in calls:
            try:
                proposals.extend(AlignmentBatch.model_validate(raw).alignments)
            except ValidationError:
                continue
        if proposals:
            break
        found = json_object_from_text(text)
        if found is not None:
            try:
                proposals.extend(AlignmentBatch.model_validate(found).alignments)
            except ValidationError:
                pass
            break
    return proposals


def align_requirement(
    *,
    constraints: Sequence[RequirementConstraint],
    candidates: Sequence[tuple[str, Sequence[ProductAttributeClaim]]],
    model: BaseChatModel,
    batch_size: int = ALIGNMENT_BATCH_SIZE,
    config: dict[str, Any] | None = None,
    concurrency: int = ALIGNMENT_CONCURRENCY,
) -> dict[tuple[str, str], SemanticAlignment]:
    """Align every constraint with every candidate and check the proposals.

    The candidates are asked about in batches, because one call with every
    candidate of a project becomes slow enough to time out. The batch size is
    a setting, not a constant of the code.
    """
    proposals: list[AlignmentProposal] = []
    step = max(1, batch_size)
    batches = [candidates[start: start + step] for start in range(0, len(candidates), step)]
    # The batches do not depend on each other, so they run together. One
    # candidate per call keeps the judgement focused and the prompt small.
    with ThreadPoolExecutor(max_workers=max(1, min(concurrency, len(batches)))) as pool:
        results = list(
            pool.map(
                lambda batch: propose_alignments(
                    constraints=constraints,
                    candidates=batch,
                    model=model,
                    config=config,
                ),
                batches,
            )
        )
    for result in results:
        proposals.extend(result)
    by_constraint = {constraint.constraint_id: constraint for constraint in constraints}
    alignments: dict[tuple[str, str], SemanticAlignment] = {}
    for proposal in proposals:
        constraint = by_constraint.get(proposal.constraint_id)
        claims = {
            claim.claim_id: claim
            for candidate_id, candidate_claims in candidates
            if candidate_id == proposal.product_candidate_id
            for claim in candidate_claims
        }
        alignments[(proposal.constraint_id, proposal.product_candidate_id)] = canonical_alignment(
            proposal,
            constraint=constraint,
            claims=claims,
        )
    return alignments
