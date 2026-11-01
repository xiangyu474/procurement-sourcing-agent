"""The identity of a cached judgement.

A cache entry is found by the content that produced it, not by a project, a
model name, or a piece of text. Three layers are cached separately:

- the typing of a claim, which depends on the claim, the evidence it came
  from, and the rules that typed it;
- the alignment of a constraint with a typed claim, which depends on the
  constraint, the typed claim, the attribute definitions, and the rules that
  aligned them;
- the assessment of a requirement against a model, which depends on the
  alignment, the typed claim, the calculator, and the aggregation rule.

The rule versions are digests of the prompt and the schema that produced
them, so changing a prompt or a schema invalidates the layer it belongs to
without anyone having to remember to bump a number.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from pydantic import BaseModel

from procurement_agent.domain.requirements import RequirementConstraint
from procurement_agent.domain.sourcing import ClaimDraft
from procurement_agent.domain.spec_alignment import ProductAttributeClaim, SemanticAlignment


class CacheLayer(StrEnum):
    """The layer a cached judgement belongs to."""

    TYPING = "TYPING"
    ALIGNMENT = "ALIGNMENT"
    ASSESSMENT = "ASSESSMENT"


def canonical_json(payload: Any) -> str:
    """A stable text for any content, so the same content always digests the same."""
    return json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    )


def digest(payload: Any) -> str:
    """The digest of any content."""
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class JudgmentVersions:
    """The versions that decide whether two judgements are comparable."""

    typing_rules: str
    alignment_rules: str
    model_config: str
    calculator: str
    aggregation: str

    def as_dict(self) -> dict[str, str]:
        return {
            "typing_rules": self.typing_rules,
            "alignment_rules": self.alignment_rules,
            "model_config": self.model_config,
            "calculator": self.calculator,
            "aggregation": self.aggregation,
        }


def claim_identity(claim: ClaimDraft, evidence_hash: str | None) -> dict[str, Any]:
    """The content of a claim, with the evidence it rests on."""
    return {
        "claim_id": claim.claim_id,
        "subject_ref": claim.subject_ref,
        "attribute": claim.attribute,
        "value": claim.value,
        "unit": claim.unit,
        "source_quote": claim.source_quote,
        "evidence_id": claim.evidence_id,
        "evidence_hash": evidence_hash,
    }


def typing_cache_key(
    *,
    claim: ClaimDraft,
    evidence_hash: str | None,
    versions: JudgmentVersions,
    attribute_definitions: Mapping[str, str] | None = None,
) -> str:
    """The key of the typed form of one claim.

    The definitions of the attributes the buyer asks for are part of the key:
    they decide which words a quotation has to use, so a different definition
    has to be judged again.
    """
    return digest(
        {
            "layer": CacheLayer.TYPING.value,
            "claim": claim_identity(claim, evidence_hash),
            "attribute_definitions": dict(sorted((attribute_definitions or {}).items())),
            "typing_rules": versions.typing_rules,
            "model_config": versions.model_config,
        }
    )


def constraint_identity(constraint: RequirementConstraint) -> dict[str, Any]:
    """The content of a constraint."""
    return {
        "constraint_id": constraint.constraint_id,
        "requirement_id": constraint.requirement_id,
        "attribute_key": constraint.attribute_key,
        "attribute_definition": constraint.attribute_definition,
        "value_type": constraint.value_type.value,
        "operator": constraint.operator.value,
        "value": constraint.value,
        "unit": constraint.unit,
        "qualifiers": constraint.qualifiers,
        "importance": constraint.importance.value,
        "parse_status": constraint.parse_status.value,
    }


def typed_claim_identity(claim: ProductAttributeClaim) -> dict[str, Any]:
    """The content of a typed claim."""
    return {
        "claim_id": claim.claim_id,
        "attribute_key": claim.attribute_key,
        "attribute_definition": claim.attribute_definition,
        "value_type": claim.value_type.value,
        "value": claim.value,
        "unit": claim.unit,
        "qualifiers": claim.qualifiers,
        "evidence_ids": sorted(claim.evidence_ids),
        "source_quote": claim.source_quote,
        "conditions": claim.conditions,
    }


def alignment_cache_key(
    *,
    constraint: RequirementConstraint,
    typed_claim: ProductAttributeClaim,
    versions: JudgmentVersions,
) -> str:
    """The key of the alignment of one constraint with one typed claim."""
    return digest(
        {
            "layer": CacheLayer.ALIGNMENT.value,
            "constraint": constraint_identity(constraint),
            "typed_claim": typed_claim_identity(typed_claim),
            "alignment_rules": versions.alignment_rules,
            "model_config": versions.model_config,
        }
    )


def alignment_group_cache_key(
    *,
    constraint: RequirementConstraint,
    typed_claims: Sequence[ProductAttributeClaim],
    versions: JudgmentVersions,
) -> str:
    """The key of the alignment of one constraint with one candidate.

    The candidate is identified by the typed claims it carries, so a candidate
    whose claims changed gets a different key and is judged again.
    """
    return digest(
        {
            "layer": CacheLayer.ALIGNMENT.value,
            "constraint": constraint_identity(constraint),
            "typed_claims": [
                typed_claim_identity(claim) for claim in sorted(typed_claims, key=lambda item: item.claim_id)
            ],
            "alignment_rules": versions.alignment_rules,
            "model_config": versions.model_config,
        }
    )


def assessment_group_cache_key(
    *,
    constraint_ids: Sequence[str],
    constraint_identities: Sequence[dict[str, Any]],
    typed_claims: Sequence[ProductAttributeClaim],
    alignments: Sequence[SemanticAlignment],
    versions: JudgmentVersions,
) -> str:
    """The key of the assessment of one requirement against one candidate."""
    return digest(
        {
            "layer": CacheLayer.ASSESSMENT.value,
            "constraint_ids": list(constraint_ids),
            "constraints": list(constraint_identities),
            "typed_claims": [
                typed_claim_identity(claim) for claim in sorted(typed_claims, key=lambda item: item.claim_id)
            ],
            "alignments": [alignment_identity(item) for item in alignments],
            "calculator": versions.calculator,
            "aggregation": versions.aggregation,
        }
    )


def alignment_identity(alignment: SemanticAlignment) -> dict[str, Any]:
    """The content of an alignment."""
    return {
        "constraint_id": alignment.constraint_id,
        "claim_ids": list(alignment.claim_ids),
        "status": alignment.status.value,
        "method": alignment.method.value,
        "reason": alignment.reason,
        "dimension": alignment.dimension,
        "unit_conversion": alignment.unit_conversion,
        "unresolved_qualifiers": list(alignment.unresolved_qualifiers),
    }


def assessment_cache_key(
    *,
    alignment: SemanticAlignment,
    typed_claim: ProductAttributeClaim,
    versions: JudgmentVersions,
) -> str:
    """The key of the assessment of one alignment."""
    return digest(
        {
            "layer": CacheLayer.ASSESSMENT.value,
            "alignment": alignment_identity(alignment),
            "typed_claim": typed_claim_identity(typed_claim),
            "calculator": versions.calculator,
            "aggregation": versions.aggregation,
        }
    )


class CacheEntry(BaseModel):
    """One stored judgement."""

    layer: CacheLayer
    input_digest: str
    payload: dict[str, Any]
    versions: dict[str, str]
    model_config: dict[str, Any] = {}
    evidence_hashes: list[str] = []
    source_run_id: str | None = None
    source_project_id: str | None = None
    verdict: str | None = None
    reason_codes: list[str] = []
