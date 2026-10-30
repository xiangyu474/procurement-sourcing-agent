"""Tests for the M3-C decision orchestration.

The model is replaced by a fake, so the test shows that the verdicts come
from the gate and not from the model, and that the Supervisor reads a summary
instead of the raw sources.
"""

from __future__ import annotations

from datetime import UTC, datetime

from procurement_agent.domain.decision import (
    CandidateRecommendation,
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
from procurement_agent.services.sourcing_decision import (
    build_decision_context,
    decide,
    decision_summary,
)

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)


class _FakeChunk:
    def __init__(self, arguments):
        self.tool_calls = [{"name": "answer", "args": arguments}]
        self.content = ""

    def __add__(self, other):
        return self


class ScriptedModel:
    """Answers each call with the next payload in the script."""

    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = 0
        self.messages: list[list] = []

    def bind_tools(self, tools, tool_choice=None):
        return self

    def stream(self, messages, config=None):
        self.messages.append(messages)
        payload = self.payloads[min(self.calls, len(self.payloads) - 1)]
        self.calls += 1
        yield _FakeChunk(payload)


def assessment(
    candidate_id: str,
    overall: ConstraintStatus,
    *,
    quote: str = "5MP resolution",
) -> SpecAssessment:
    return SpecAssessment(
        requirement_id="r1",
        product_candidate_id=candidate_id,
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
                evidence_ids=["ev1"],
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


def decision_payload(**overrides) -> dict:
    fields = {
        "requirement_id": "r1",
        "product_candidate_id": "cand1",
        "recommendation": "SHORTLIST",
        "technical_verdict": "VERIFIED_PASS",
        "rationale": "the check passed and the evidence is on file",
        "evidence_ids": ["ev1"],
    }
    fields.update(overrides)
    return {"decisions": [fields]}


def test_the_decision_of_a_passing_candidate_is_accepted():
    model = ScriptedModel([decision_payload()])
    decisions = decide(
        project_id="p1",
        assessments=[assessment("cand1", ConstraintStatus.PASS)],
        model=model,
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert len(decisions) == 1
    assert decisions[0].accepted is True
    assert decisions[0].recommendation == CandidateRecommendation.SHORTLIST
    assert decisions[0].technical_verdict == TechnicalVerdict.VERIFIED_PASS


def test_a_model_that_shortlists_a_failed_candidate_is_blocked():
    model = ScriptedModel(
        [
            decision_payload(
                recommendation="SHORTLIST",
                technical_verdict="VERIFIED_FAIL",
            )
        ]
    )
    decisions = decide(
        project_id="p1",
        assessments=[assessment("cand1", ConstraintStatus.FAIL)],
        model=model,
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decisions[0].accepted is False
    codes = {violation.code.value for violation in decisions[0].violations}
    assert "HARD_FAIL_IN_SHORTLIST" in codes


def test_a_model_that_calls_an_unknown_a_pass_is_blocked():
    model = ScriptedModel([decision_payload(technical_verdict="VERIFIED_PASS")])
    decisions = decide(
        project_id="p1",
        assessments=[assessment("cand1", ConstraintStatus.UNKNOWN)],
        model=model,
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decisions[0].accepted is False
    codes = {violation.code.value for violation in decisions[0].violations}
    assert "UNKNOWN_CLAIMED_AS_VERIFIED" in codes


def test_a_model_that_invents_an_evidence_id_is_blocked():
    model = ScriptedModel([decision_payload(evidence_ids=["ev-fake"])])
    decisions = decide(
        project_id="p1",
        assessments=[assessment("cand1", ConstraintStatus.PASS)],
        model=model,
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    assert decisions[0].accepted is False
    codes = {violation.code.value for violation in decisions[0].violations}
    assert "UNKNOWN_EVIDENCE_ID" in codes


def test_the_price_conclusion_comes_from_the_analysis():
    finding = PriceFinding(
        requirement_id="r1",
        comparability=ComparabilityStatus.COMPARABLE,
        lowest_observation_id="obs1",
        lowest_value="90",
        lowest_basis=PriceBasis.FORMAL_QUOTATION,
        saving="10",
        saving_percent="10",
        explanation="the quotation is 90 against a budget of 100",
    )
    model = ScriptedModel(
        [
            decision_payload(
                claimed_lowest_observation_id="obs1",
                claimed_saving="10",
            )
        ]
    )
    decisions = decide(
        project_id="p1",
        assessments=[assessment("cand1", ConstraintStatus.PASS)],
        model=model,
        known_evidence_ids=["ev1"],
        price_findings={"r1": [finding]},
        decided_at=NOW,
    )
    assert decisions[0].accepted is True
    assert decisions[0].price_conclusion == finding.explanation


def test_the_supervisor_reads_a_summary_and_not_the_sources():
    """The context is a small record per candidate, without the quotations."""
    model = ScriptedModel([decision_payload()])
    decide(
        project_id="p1",
        assessments=[assessment("cand1", ConstraintStatus.PASS, quote="a very long source quotation")],
        model=model,
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    sent = model.messages[0][-1].content
    assert "a very long source quotation" not in sent
    assert "5 MP GTE 5 MP" in sent
    assert len(sent) < 2000


def test_the_context_carries_the_price_and_the_evidence():
    finding = PriceFinding(
        requirement_id="r1",
        comparability=ComparabilityStatus.COMPARABLE,
        lowest_observation_id="obs1",
        lowest_value="90",
        lowest_basis=PriceBasis.FORMAL_QUOTATION,
        saving="10",
        explanation="the quotation is 90",
    )
    context = build_decision_context(
        assessments=[assessment("cand1", ConstraintStatus.PASS)],
        price_findings={"r1": [finding]},
        known_evidence_ids=["ev1", "ev2"],
    )
    entry = context[0]
    assert entry["hard_spec_overall"] == "PASS"
    assert entry["checks"][0]["status"] == "PASS"
    assert entry["prices"][0]["lowest_value"] == "90"
    assert context[-1]["known_evidence_ids"] == ["ev1", "ev2"]


def test_the_summary_counts_the_outcomes():
    model = ScriptedModel([decision_payload()])
    decisions = decide(
        project_id="p1",
        assessments=[assessment("cand1", ConstraintStatus.PASS)],
        model=model,
        known_evidence_ids=["ev1"],
        decided_at=NOW,
    )
    summary = decision_summary(decisions)
    assert summary["decisions"] == 1
    assert summary["accepted"] == 1
    assert summary["rejected"] == 0
    assert summary["by_recommendation"] == {"SHORTLIST": 1}
