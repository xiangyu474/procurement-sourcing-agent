"""M3-C decision contracts: what the Supervisor decided, and what it may claim.

The Supervisor proposes. The gate decides whether the proposal may stand. The
contract separates the recommendation from the technical verdict so that a
model cannot turn an unknown into a verified pass by wording: the verdict is a
field with three values, and the gate compares it with the assessment that
was actually computed.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class TechnicalVerdict(StrEnum):
    """What the decision says about the technical check.

    `VERIFIED_PASS` means the check was computed and passed. `UNVERIFIED`
    means the check could not be made, and nothing else may be said about it.
    """

    VERIFIED_PASS = "VERIFIED_PASS"
    VERIFIED_FAIL = "VERIFIED_FAIL"
    UNVERIFIED = "UNVERIFIED"


class CandidateRecommendation(StrEnum):
    """What the Supervisor recommends for one candidate."""

    SHORTLIST = "SHORTLIST"
    INVESTIGATE = "INVESTIGATE"
    EXCLUDE = "EXCLUDE"


class GateViolationCode(StrEnum):
    """Why a decision was not accepted."""

    ASSESSMENT_MISSING = "ASSESSMENT_MISSING"
    VERDICT_MISMATCH = "VERDICT_MISMATCH"
    UNKNOWN_CLAIMED_AS_VERIFIED = "UNKNOWN_CLAIMED_AS_VERIFIED"
    HARD_FAIL_IN_SHORTLIST = "HARD_FAIL_IN_SHORTLIST"
    UNKNOWN_SHORTLISTED_WITHOUT_GAP = "UNKNOWN_SHORTLISTED_WITHOUT_GAP"
    UNKNOWN_SHORTLISTED = "UNKNOWN_SHORTLISTED"
    UNKNOWN_EVIDENCE_ID = "UNKNOWN_EVIDENCE_ID"
    PRICE_CONCLUSION_WITHOUT_OBSERVATION = "PRICE_CONCLUSION_WITHOUT_OBSERVATION"
    PRICE_SAVING_MISMATCH = "PRICE_SAVING_MISMATCH"
    PRICE_CLAIMED_WITHOUT_COMPARISON = "PRICE_CLAIMED_WITHOUT_COMPARISON"
    STAGE_NOT_ALLOWED = "STAGE_NOT_ALLOWED"


class DecisionProposal(BaseModel):
    """What the Supervisor proposes for one requirement and one candidate."""

    model_config = ConfigDict(extra="ignore")

    requirement_id: str
    product_candidate_id: str
    recommendation: CandidateRecommendation
    technical_verdict: TechnicalVerdict = TechnicalVerdict.UNVERIFIED
    rationale: str = Field(min_length=8, max_length=1200)
    evidence_ids: list[str] = Field(default_factory=list, max_length=40)
    price_observation_ids: list[str] = Field(default_factory=list, max_length=40)
    claimed_lowest_observation_id: str | None = None
    claimed_saving: str | None = None
    gaps: list[str] = Field(default_factory=list, max_length=20)
    next_actions: list[str] = Field(default_factory=list, max_length=20)
    priority_rank: int | None = Field(default=None, ge=1, le=100)


class GateViolation(BaseModel):
    """One reason a decision was not accepted."""

    model_config = ConfigDict(extra="forbid")

    code: GateViolationCode
    subject: str
    message: str = Field(min_length=4, max_length=800)


class SourcingDecision(BaseModel):
    """The decision for one requirement and one candidate, after the gate."""

    model_config = ConfigDict(extra="forbid")

    decision_id: str
    project_id: str
    requirement_id: str
    product_candidate_id: str
    product_model_ref: str | None = None
    recommendation: CandidateRecommendation
    technical_verdict: TechnicalVerdict
    hard_spec_overall: str
    rationale: str = Field(min_length=4, max_length=1200)
    evidence_ids: list[str] = Field(default_factory=list)
    price_observation_ids: list[str] = Field(default_factory=list)
    price_conclusion: str | None = None
    gaps: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)
    priority_rank: int | None = None
    accepted: bool = True
    violations: list[GateViolation] = Field(default_factory=list)
    decided_at: datetime
    decision_source: str = "supervisor"

    @field_validator("decided_at")
    @classmethod
    def aware_decision_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("decided_at must be timezone-aware")
        return value

    @model_validator(mode="after")
    def an_accepted_decision_has_no_violation(self) -> SourcingDecision:
        if self.accepted and self.violations:
            raise ValueError("an accepted decision carries no violation")
        if not self.accepted and not self.violations:
            raise ValueError("a rejected decision names at least one violation")
        return self


class DecisionBatch(BaseModel):
    """The Supervisor's answer for one requirement and its candidates."""

    model_config = ConfigDict(extra="ignore")

    decisions: list[DecisionProposal] = Field(default_factory=list, max_length=300)
