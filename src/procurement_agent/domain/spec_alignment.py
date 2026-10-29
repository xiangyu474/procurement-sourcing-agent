"""M3-A contracts: typed product claims, semantic alignment, and spec assessment.

The requirement side already speaks the Requirement DSL. The product side uses
the same value types, the same operators, and the same meaning of a unit, so a
comparison never crosses two vocabularies.

Nothing in this module decides anything. The calculator in
`procurement_agent.services.spec_calculator` turns these contracts into PASS,
FAIL, or UNKNOWN.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from procurement_agent.domain.requirements import ParseStatus, ValueType
from procurement_agent.domain.sourcing import ClaimStatus


class AlignmentStatus(StrEnum):
    """Whether a requirement constraint and a product claim measure one thing."""

    ALIGNED = "ALIGNED"
    NOT_ALIGNED = "NOT_ALIGNED"
    AMBIGUOUS = "AMBIGUOUS"
    CONFLICTING = "CONFLICTING"


class AlignmentMethod(StrEnum):
    """How the alignment was reached."""

    EXACT_ATTRIBUTE_KEY = "EXACT_ATTRIBUTE_KEY"
    APPROVED_ALIAS = "APPROVED_ALIAS"
    LLM_PROPOSED_REVIEWED = "LLM_PROPOSED_REVIEWED"


class ConstraintStatus(StrEnum):
    """The three-valued outcome of one constraint check."""

    PASS = "PASS"
    FAIL = "FAIL"
    UNKNOWN = "UNKNOWN"


class ConstraintReasonCode(StrEnum):
    """Why a constraint check reached its status."""

    VERIFIED_COMPARISON = "VERIFIED_COMPARISON"
    MISSING_CLAIM = "MISSING_CLAIM"
    INCOMPLETE_SOURCE = "INCOMPLETE_SOURCE"
    AMBIGUOUS_REQUIREMENT = "AMBIGUOUS_REQUIREMENT"
    ATTRIBUTE_NOT_ALIGNED = "ATTRIBUTE_NOT_ALIGNED"
    UNIT_NOT_CONVERTIBLE = "UNIT_NOT_CONVERTIBLE"
    CONDITIONAL_MISMATCH = "CONDITIONAL_MISMATCH"
    CONFLICTING_CLAIMS = "CONFLICTING_CLAIMS"
    UNSUPPORTED_OPERATOR = "UNSUPPORTED_OPERATOR"
    UNVERIFIED_CLAIM = "UNVERIFIED_CLAIM"
    MODEL_VARIANT_UNCERTAIN = "MODEL_VARIANT_UNCERTAIN"
    UNSUPPORTED_FOR_AUTO_CHECK = "UNSUPPORTED_FOR_AUTO_CHECK"
    NO_HARD_CONSTRAINT = "NO_HARD_CONSTRAINT"
    UNRESOLVED_DEMAND = "UNRESOLVED_DEMAND"
    INVALID_INPUT = "INVALID_INPUT"


class ProductAttributeClaim(BaseModel):
    """A typed, source-attributed statement about one product model.

    The claim says what a source states, not that the statement is true.
    """

    model_config = ConfigDict(extra="forbid")

    claim_id: str
    product_candidate_id: str
    product_model_ref: str | None = None
    attribute_key: str
    attribute_definition: str = Field(min_length=1, max_length=300)
    value_type: ValueType
    value: Any
    unit: str | None = None
    qualifiers: dict[str, str | int | bool] = Field(default_factory=dict)
    evidence_ids: list[str] = Field(default_factory=list)
    source_quote: str = Field(min_length=1, max_length=1000)
    claim_status: ClaimStatus = ClaimStatus.SUPPORTED_BY_SOURCE
    extraction_status: ParseStatus = ParseStatus.RESOLVED
    observed_at: datetime | None = None
    conditions: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def supported_claim_needs_evidence(self) -> ProductAttributeClaim:
        if self.claim_status == ClaimStatus.SUPPORTED_BY_SOURCE and not self.evidence_ids:
            raise ValueError("a source-supported claim must cite at least one evidence ID")
        return self

    @field_validator("attribute_key")
    @classmethod
    def normalized_attribute_key(cls, value: str) -> str:
        if not value or value != value.strip().lower() or " " in value:
            raise ValueError("attribute_key must be a lowercase identifier without spaces")
        return value


class SemanticAlignment(BaseModel):
    """The decision that a constraint and a claim measure the same thing."""

    model_config = ConfigDict(extra="forbid")

    constraint_id: str
    claim_ids: list[str] = Field(default_factory=list)
    status: AlignmentStatus
    method: AlignmentMethod
    reason: str = Field(min_length=4, max_length=1000)
    dimension: str | None = Field(default=None, max_length=200)
    unit_conversion: str | None = Field(default=None, max_length=300)
    unresolved_qualifiers: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def aligned_alignment_needs_claims(self) -> SemanticAlignment:
        if self.status == AlignmentStatus.ALIGNED and not self.claim_ids:
            raise ValueError("an aligned constraint must name the claims it is compared with")
        return self


class ConstraintCheck(BaseModel):
    """The result of one constraint against one product model."""

    model_config = ConfigDict(extra="forbid")

    constraint_id: str
    requirement_id: str
    claim_ids: list[str] = Field(default_factory=list)
    status: ConstraintStatus
    reason_code: ConstraintReasonCode
    operation: str | None = None
    normalized_actual: str | None = None
    normalized_required: str | None = None
    unit: str | None = None
    evidence_ids: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    explanation: str = Field(min_length=4, max_length=1000)
    importance: str = "UNKNOWN"


class SpecAssessment(BaseModel):
    """Every constraint of one requirement against one product model."""

    model_config = ConfigDict(extra="forbid")

    requirement_id: str
    product_candidate_id: str
    product_model_ref: str | None = None
    calculator_version: str = "0.1.0"
    dsl_schema_version: str = "1.0"
    checks: list[ConstraintCheck] = Field(default_factory=list)
    hard_spec_overall: ConstraintStatus
    overall_reason_codes: list[ConstraintReasonCode] = Field(default_factory=list)
    hard_constraint_count: int = Field(default=0, ge=0)
    unresolved_question_ids: list[str] = Field(default_factory=list)
    evaluated_at: datetime

    @field_validator("evaluated_at")
    @classmethod
    def aware_evaluation_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("evaluated_at must be timezone-aware")
        return value

    @model_validator(mode="after")
    def overall_matches_the_checks(self) -> SpecAssessment:
        hard = [check for check in self.checks if check.importance == "HARD"]
        if self.hard_constraint_count != len(hard):
            raise ValueError("hard_constraint_count must match the HARD checks")
        failures = [check for check in hard if check.status == ConstraintStatus.FAIL]
        if failures and self.hard_spec_overall != ConstraintStatus.FAIL:
            raise ValueError("a HARD failure forces the overall status to FAIL")
        if not failures and self.hard_spec_overall == ConstraintStatus.FAIL:
            raise ValueError("the overall status may only be FAIL when a HARD check failed")
        return self
