"""Tests for the M3-C verification gate.

The gate is what stands between a model's decision and the record of it, so
the tests are written from the acceptance requirements: a failed hard
requirement cannot reach the short list, an unknown cannot be written down as
a verified pass, and a decision that invents an evidence identifier or a
saving is rejected.
"""

from __future__ import annotations

from datetime import UTC, datetime

from procurement_agent.domain.decision import (
    CandidateRecommendation,
    DecisionProposal,
    GateViolationCode,
    TechnicalVerdict,
)
from procurement_agent.domain.pricing import (
    ComparabilityStatus,
    PriceBasis,
    PriceFinding,
)
from procurement_agent.domain.spec_alignment import (
    ConstraintCheck,
    ConstraintReasonCode,
    ConstraintStatus,
    SpecAssessment,
)
from procurement_agent.services.decision_gate import verify_decision

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)


def assessment(overall: ConstraintStatus = ConstraintStatus.PASS) -> SpecAssessment:
    return SpecAssessment(
        requirement_id="r1",
        product_candidate_id="cand1",
        product_model_ref="TRI055N",
        checks=[
            ConstraintCheck(
                constraint_id="c1",
                requirement_id="r1",
                status=overall,
                reason_code=(
                    ConstraintReasonCode.VERIFIED_COMPARISON
                    if overall != ConstraintStatus.UNKNOWN
                    else ConstraintReasonCode.ATTRIBUTE_NOT_ALIGNED
                ),
                operation="5 MP GTE 5 MP" if overall != ConstraintStatus.UNKNOWN else None,
                explanation="the check that was computed",
                importance="HARD",
            )
        ],
        hard_spec_overall=overall,
        overall_reason_codes=[
            ConstraintReasonCode.VERIFIED_COMPARISON
            if overall != ConstraintStatus.UNKNOWN
            else ConstraintReasonCode.ATTRIBUTE_NOT_ALIGNED
        ],
        hard_constraint_count=1,
        evaluated_at=NOW,
    )


def proposal(**overrides) -> DecisionProposal:
    fields = {
        "requirement_id": "r1",
        "product_candidate_id": "cand1",
        "recommendation": CandidateRecommendation.SHORTLIST,
        "technical_verdict": TechnicalVerdict.VERIFIED_PASS,
        "rationale": "the check passed and the evidence is on file",
        "evidence_ids": ["ev1"],
    }
    fields.update(overrides)
    return DecisionProposal(**fields)


def price_finding(**overrides) -> PriceFinding:
    fields = {
        "requirement_id": "r1",
        "comparability": ComparabilityStatus.COMPARABLE,
        "lowest_observation_id": "obs1",
        "lowest_value": "90",
        "lowest_basis": PriceBasis.FORMAL_QUOTATION,
        "saving": "10",
        "saving_percent": "10",
        "explanation": "the quotation is 90 against a budget of 100",
    }
    fields.update(overrides)
    return PriceFinding(**fields)


# --- the acceptance requirements -------------------------------------------


def test_a_hard_failure_cannot_enter_the_short_list():
    decision = verify_decision(
        proposal(
            recommendation=CandidateRecommendation.SHORTLIST,
            technical_verdict=TechnicalVerdict.VERIFIED_FAIL,
        ),
        project_id="p1",
        assessment=assessment(ConstraintStatus.FAIL),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.HARD_FAIL_IN_SHORTLIST in codes


def test_an_unknown_cannot_be_written_down_as_a_verified_pass():
    decision = verify_decision(
        proposal(technical_verdict=TechnicalVerdict.VERIFIED_PASS),
        project_id="p1",
        assessment=assessment(ConstraintStatus.UNKNOWN),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.UNKNOWN_CLAIMED_AS_VERIFIED in codes


def test_a_fabricated_evidence_id_is_rejected():
    decision = verify_decision(
        proposal(evidence_ids=["ev1", "ev-does-not-exist"]),
        project_id="p1",
        assessment=assessment(ConstraintStatus.PASS),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.UNKNOWN_EVIDENCE_ID in codes
    # The evidence that does exist is still kept.
    assert decision.evidence_ids == ["ev1"]


def test_a_fabricated_saving_is_rejected():
    decision = verify_decision(
        proposal(
            claimed_lowest_observation_id="obs1",
            claimed_saving="999",
        ),
        project_id="p1",
        assessment=assessment(ConstraintStatus.PASS),
        known_evidence_ids=["ev1"],
        price_findings=[price_finding()],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.PRICE_SAVING_MISMATCH in codes


def test_a_saving_that_no_analysis_produced_is_rejected():
    decision = verify_decision(
        proposal(
            claimed_lowest_observation_id="obs-not-there",
            claimed_saving="10",
        ),
        project_id="p1",
        assessment=assessment(ConstraintStatus.PASS),
        known_evidence_ids=["ev1"],
        price_findings=[price_finding()],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.PRICE_CONCLUSION_WITHOUT_OBSERVATION in codes


def test_a_saving_without_a_price_is_rejected():
    decision = verify_decision(
        proposal(claimed_saving="10"),
        project_id="p1",
        assessment=assessment(ConstraintStatus.PASS),
        known_evidence_ids=["ev1"],
        price_findings=[price_finding()],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.PRICE_CLAIMED_WITHOUT_COMPARISON in codes


# --- the other rules --------------------------------------------------------


def test_a_passing_candidate_may_be_shortlisted():
    decision = verify_decision(
        proposal(),
        project_id="p1",
        assessment=assessment(ConstraintStatus.PASS),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is True
    assert decision.recommendation == CandidateRecommendation.SHORTLIST
    assert decision.violations == []


def test_an_unknown_candidate_stays_off_the_short_list_even_with_a_gap():
    """Only a candidate that passed the hard requirements may be shortlisted.

    The rule is written down in the report's reading notes and on the page:
    the short list is what passed the hard requirements. A candidate whose
    check is unknown stays for further evidence, and the reason is kept.
    """
    decision = verify_decision(
        proposal(
            recommendation=CandidateRecommendation.SHORTLIST,
            technical_verdict=TechnicalVerdict.UNVERIFIED,
            gaps=["the source does not state the video output resolution"],
        ),
        project_id="p1",
        assessment=assessment(ConstraintStatus.UNKNOWN),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.recommendation == CandidateRecommendation.INVESTIGATE
    assert decision.accepted is False
    assert GateViolationCode.UNKNOWN_SHORTLISTED in {v.code for v in decision.violations}


def test_an_unknown_candidate_may_not_be_shortlisted_without_a_gap():
    decision = verify_decision(
        proposal(
            recommendation=CandidateRecommendation.SHORTLIST,
            technical_verdict=TechnicalVerdict.UNVERIFIED,
            gaps=[],
        ),
        project_id="p1",
        assessment=assessment(ConstraintStatus.UNKNOWN),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.UNKNOWN_SHORTLISTED_WITHOUT_GAP in codes


def test_a_candidate_without_an_assessment_is_not_decided():
    decision = verify_decision(
        proposal(),
        project_id="p1",
        assessment=None,
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.ASSESSMENT_MISSING in codes


def test_a_verdict_that_contradicts_the_check_is_rejected():
    decision = verify_decision(
        proposal(technical_verdict=TechnicalVerdict.VERIFIED_PASS),
        project_id="p1",
        assessment=assessment(ConstraintStatus.FAIL),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is False
    codes = {violation.code for violation in decision.violations}
    assert GateViolationCode.VERDICT_MISMATCH in codes


def test_an_excluding_decision_for_a_failed_candidate_is_accepted():
    decision = verify_decision(
        proposal(
            recommendation=CandidateRecommendation.EXCLUDE,
            technical_verdict=TechnicalVerdict.VERIFIED_FAIL,
        ),
        project_id="p1",
        assessment=assessment(ConstraintStatus.FAIL),
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decision.accepted is True
    assert decision.recommendation == CandidateRecommendation.EXCLUDE
