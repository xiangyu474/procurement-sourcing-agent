"""M3-C verification gate: what a decision may not say.

The Supervisor writes the decision. The gate checks it against the material
that was actually computed, and a decision that does not hold up is not
written down as accepted.

The gate checks four things:

- the technical verdict against the assessment that was computed, so an
  unknown cannot be written down as a verified pass;
- the recommendation against that assessment, so a model with a failed hard
  requirement cannot reach the short list;
- the evidence references against the evidence ledger, so a model cannot
  invent a source;
- the price conclusion against the price finding, so a model cannot invent a
  saving.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime

from procurement_agent.domain.decision import (
    CandidateRecommendation,
    DecisionProposal,
    GateViolation,
    GateViolationCode,
    SourcingDecision,
    TechnicalVerdict,
)
from procurement_agent.domain.pricing import PriceFinding
from procurement_agent.domain.spec_alignment import ConstraintStatus, SpecAssessment


def _verdict_for(overall: str) -> TechnicalVerdict:
    """The only technical verdict an assessment allows."""
    if overall == ConstraintStatus.PASS.value:
        return TechnicalVerdict.VERIFIED_PASS
    if overall == ConstraintStatus.FAIL.value:
        return TechnicalVerdict.VERIFIED_FAIL
    return TechnicalVerdict.UNVERIFIED


def verify_decision(
    proposal: DecisionProposal,
    *,
    project_id: str,
    assessment: SpecAssessment | None,
    known_evidence_ids: Sequence[str],
    price_findings: Sequence[PriceFinding] = (),
    decided_at: datetime | None = None,
) -> SourcingDecision:
    """Check one proposed decision and return the decision that may stand."""
    violations: list[GateViolation] = []
    subject = f"{proposal.requirement_id}/{proposal.product_candidate_id}"
    known_evidence = set(known_evidence_ids)

    if assessment is None:
        violations.append(
            GateViolation(
                code=GateViolationCode.ASSESSMENT_MISSING,
                subject=subject,
                message="There is no technical assessment for this candidate, so nothing may be decided about it.",
            )
        )
        overall = "UNKNOWN"
        model_ref = None
    else:
        overall = assessment.hard_spec_overall.value
        model_ref = assessment.product_model_ref

    allowed_verdict = _verdict_for(overall)
    if proposal.technical_verdict != allowed_verdict:
        if proposal.technical_verdict == TechnicalVerdict.VERIFIED_PASS and overall == ConstraintStatus.UNKNOWN.value:
            violations.append(
                GateViolation(
                    code=GateViolationCode.UNKNOWN_CLAIMED_AS_VERIFIED,
                    subject=subject,
                    message=(
                        "The decision calls the candidate a verified pass, but the technical check "
                        "could not be made. An unknown stays unknown."
                    ),
                )
            )
        else:
            violations.append(
                GateViolation(
                    code=GateViolationCode.VERDICT_MISMATCH,
                    subject=subject,
                    message=(
                        f"The decision says {proposal.technical_verdict.value}, but the technical check "
                        f"produced {overall}."
                    ),
                )
            )

    if proposal.recommendation == CandidateRecommendation.SHORTLIST:
        if overall == ConstraintStatus.FAIL.value:
            violations.append(
                GateViolation(
                    code=GateViolationCode.HARD_FAIL_IN_SHORTLIST,
                    subject=subject,
                    message=(
                        "A model with a failed hard requirement cannot reach the short list. It stays "
                        "on the long list and the failure is reported."
                    ),
                )
            )
        elif overall == ConstraintStatus.UNKNOWN.value and not proposal.gaps:
            violations.append(
                GateViolation(
                    code=GateViolationCode.UNKNOWN_SHORTLISTED_WITHOUT_GAP,
                    subject=subject,
                    message=(
                        "The candidate may be shortlisted while the check is unknown, but the decision "
                        "has to name what is missing."
                    ),
                )
            )

    for evidence_id in proposal.evidence_ids:
        if evidence_id not in known_evidence:
            violations.append(
                GateViolation(
                    code=GateViolationCode.UNKNOWN_EVIDENCE_ID,
                    subject=subject,
                    message=f"The decision cites the evidence {evidence_id}, which is not in the ledger.",
                )
            )

    findings = {
        finding.lowest_observation_id: finding
        for finding in price_findings
        if finding.lowest_observation_id
    }
    if proposal.claimed_lowest_observation_id:
        finding = findings.get(proposal.claimed_lowest_observation_id)
        if finding is None:
            violations.append(
                GateViolation(
                    code=GateViolationCode.PRICE_CONCLUSION_WITHOUT_OBSERVATION,
                    subject=subject,
                    message=(
                        f"The decision names the price {proposal.claimed_lowest_observation_id}, which no "
                        "price analysis produced."
                    ),
                )
            )
        else:
            if proposal.claimed_saving is not None and proposal.claimed_saving != (finding.saving or ""):
                violations.append(
                    GateViolation(
                        code=GateViolationCode.PRICE_SAVING_MISMATCH,
                        subject=subject,
                        message=(
                            f"The decision claims a saving of {proposal.claimed_saving}, but the analysis "
                            f"found {finding.saving or 'none'}."
                        ),
                    )
                )
    if proposal.claimed_saving is not None and not proposal.claimed_lowest_observation_id:
        violations.append(
            GateViolation(
                code=GateViolationCode.PRICE_CLAIMED_WITHOUT_COMPARISON,
                subject=subject,
                message="The decision claims a saving without naming the price it comes from.",
            )
        )

    accepted = not violations
    price_conclusion: str | None = None
    if proposal.claimed_lowest_observation_id:
        finding = findings.get(proposal.claimed_lowest_observation_id)
        if finding is not None:
            price_conclusion = finding.explanation
    return SourcingDecision(
        decision_id=f"dec:{proposal.requirement_id}:{proposal.product_candidate_id}",
        project_id=project_id,
        requirement_id=proposal.requirement_id,
        product_candidate_id=proposal.product_candidate_id,
        product_model_ref=model_ref,
        recommendation=proposal.recommendation,
        technical_verdict=proposal.technical_verdict,
        hard_spec_overall=overall,
        rationale=proposal.rationale,
        evidence_ids=[evidence_id for evidence_id in proposal.evidence_ids if evidence_id in known_evidence],
        price_observation_ids=proposal.price_observation_ids,
        price_conclusion=price_conclusion,
        gaps=proposal.gaps,
        next_actions=proposal.next_actions,
        priority_rank=proposal.priority_rank,
        accepted=accepted,
        violations=violations,
        decided_at=decided_at or datetime.now(UTC),
    )


def verify_batch(
    proposals: Sequence[DecisionProposal],
    *,
    project_id: str,
    assessments: Mapping[tuple[str, str], SpecAssessment],
    known_evidence_ids: Sequence[str],
    price_findings: Mapping[str, Sequence[PriceFinding]] | None = None,
    decided_at: datetime | None = None,
) -> list[SourcingDecision]:
    """Check every proposed decision of a batch."""
    findings_by_requirement = price_findings or {}
    decisions: list[SourcingDecision] = []
    for proposal in proposals:
        key = (proposal.requirement_id, proposal.product_candidate_id)
        decisions.append(
            verify_decision(
                proposal,
                project_id=project_id,
                assessment=assessments.get(key),
                known_evidence_ids=known_evidence_ids,
                price_findings=findings_by_requirement.get(proposal.requirement_id, ()),
                decided_at=decided_at,
            )
        )
    return decisions
