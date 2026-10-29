"""Tests for the M3-A2 evaluation orchestration.

The model is replaced by a fake that answers with fixed payloads, so the test
shows that the verdicts come from the calculator and not from the model.
"""

from __future__ import annotations

from datetime import UTC, datetime

from procurement_agent.domain.requirements import (
    ConstraintOperator,
    ConstraintOrigin,
    Importance,
    Requirement,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.domain.sourcing import (
    CandidateStage,
    ClaimDraft,
    ClaimStatus,
    ResearchCandidate,
    SubjectType,
)
from procurement_agent.domain.spec_alignment import (
    ConstraintReasonCode,
    ConstraintStatus,
)
from procurement_agent.services.spec_evaluation import evaluate_candidates, summarize

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

    def bind_tools(self, tools, tool_choice=None):
        return self

    def stream(self, messages, config=None):
        payload = self.payloads[min(self.calls, len(self.payloads) - 1)]
        self.calls += 1
        yield _FakeChunk(payload)


def requirement(*constraints: RequirementConstraint) -> Requirement:
    return Requirement(
        requirement_id="r1",
        project_id="p1",
        product_name="5MP 工业网络摄像机",
        constraints=list(constraints),
    )


def constraint(**overrides) -> RequirementConstraint:
    fields = {
        "constraint_id": "c1",
        "requirement_id": "r1",
        "attribute_key": "output_resolution",
        "attribute_definition": "视频输出像素数",
        "value_type": ValueType.NUMBER,
        "operator": ConstraintOperator.GTE,
        "value": "5",
        "unit": "MP",
        "importance": Importance.HARD,
        "origin": ConstraintOrigin.PPT_EXPLICIT,
        "source_ref": "pptx:slide=1:shape=0:paragraph=1",
        "source_quote": "5MP 工业网络摄像机",
    }
    fields.update(overrides)
    return RequirementConstraint(**fields)


def candidate(candidate_id: str, product_id: str, model: str | None = "TRI055N") -> ResearchCandidate:
    return ResearchCandidate(
        candidate_id=candidate_id,
        requirement_id="r1",
        supplier_id="sup1",
        product_id=product_id,
        stage=CandidateStage.DISCOVERED_LONG_LIST,
        rationale="the source states the model and its resolution",
        evidence_ids=["ev1"],
    )


def draft(claim_id: str, subject_ref: str, value: str, quote: str) -> ClaimDraft:
    return ClaimDraft(
        claim_id=claim_id,
        subject_type=SubjectType.PRODUCT_MODEL,
        subject_ref=subject_ref,
        attribute="resolution",
        value=value,
        unit="MP",
        evidence_id="ev1",
        source_quote=quote,
        status=ClaimStatus.SUPPORTED_BY_SOURCE,
    )


def typing_payload(value: str) -> dict:
    return {
        "claims": [
            {
                "claim_id": "clm1",
                "attribute_key": "output_resolution",
                "attribute_definition": "Video output pixel count",
                "value_type": "NUMBER",
                "value": value,
                "unit": "MP",
            }
        ]
    }


def alignment_payload() -> dict:
    return {
        "alignments": [
            {
                "constraint_id": "c1",
                "product_candidate_id": "cand1",
                "claim_ids": ["clm1"],
                "status": "ALIGNED",
                "method": "EXACT_ATTRIBUTE_KEY",
                "reason": "both sides state the video output pixel count",
            }
        ]
    }


def test_a_typed_claim_that_meets_the_requirement_passes():
    model = ScriptedModel([typing_payload("5"), alignment_payload()])
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1")],
        claims=[draft("clm1", "prod1", "5MP", "5MP resolution")],
        model=model,
        model_by_product={"prod1": "TRI055N"},
        evidence={"ev1": "5MP resolution"},
        evaluated_at=NOW,
    )
    assert len(assessments) == 1
    assert assessments[0].hard_spec_overall == ConstraintStatus.PASS
    assert assessments[0].checks[0].operation == "5 MP GTE 5 MP"
    assert assessments[0].checks[0].reason_code == ConstraintReasonCode.VERIFIED_COMPARISON


def test_a_typed_claim_that_misses_the_requirement_fails():
    model = ScriptedModel([typing_payload("4"), alignment_payload()])
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1")],
        claims=[draft("clm1", "prod1", "4MP", "4MP resolution")],
        model=model,
        model_by_product={"prod1": "TRI055N"},
        evidence={"ev1": "4MP resolution"},
        evaluated_at=NOW,
    )
    assert assessments[0].hard_spec_overall == ConstraintStatus.FAIL
    assert assessments[0].checks[0].operation == "4 MP GTE 5 MP"


def test_a_claim_whose_number_is_not_in_its_quotation_is_not_used():
    model = ScriptedModel([typing_payload("5"), alignment_payload()])
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1")],
        claims=[draft("clm1", "prod1", "5MP", "the source says 2560 x 1920")],
        model=model,
        model_by_product={"prod1": "TRI055N"},
        evidence={"ev1": "the source says 2560 x 1920"},
        evaluated_at=NOW,
    )
    check = assessments[0].checks[0]
    assert check.status == ConstraintStatus.UNKNOWN
    assert check.reason_code == ConstraintReasonCode.UNVERIFIED_CLAIM
    assert assessments[0].hard_spec_overall == ConstraintStatus.UNKNOWN


def test_without_a_model_the_result_stays_unknown():
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1")],
        claims=[draft("clm1", "prod1", "5MP", "5MP resolution")],
        model=None,
        model_by_product={"prod1": "TRI055N"},
        evidence={"ev1": "5MP resolution"},
        evaluated_at=NOW,
    )
    check = assessments[0].checks[0]
    assert check.status == ConstraintStatus.UNKNOWN
    assert check.reason_code == ConstraintReasonCode.MISSING_CLAIM


def test_a_candidate_without_an_exact_model_stays_unknown():
    model = ScriptedModel([typing_payload("5"), alignment_payload()])
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1", model=None)],
        claims=[draft("clm1", "prod1", "5MP", "5MP resolution")],
        model=model,
        model_by_product={},
        evidence={"ev1": "5MP resolution"},
        evaluated_at=NOW,
    )
    assert assessments[0].hard_spec_overall == ConstraintStatus.UNKNOWN
    assert assessments[0].checks[0].reason_code == ConstraintReasonCode.MODEL_VARIANT_UNCERTAIN


def test_two_models_of_one_supplier_are_judged_separately():
    model = ScriptedModel(
        [
            {
                "claims": [
                    {
                        "claim_id": "clm1",
                        "attribute_key": "output_resolution",
                        "attribute_definition": "Video output pixel count",
                        "value_type": "NUMBER",
                        "value": "4",
                        "unit": "MP",
                    },
                    {
                        "claim_id": "clm2",
                        "attribute_key": "output_resolution",
                        "attribute_definition": "Video output pixel count",
                        "value_type": "NUMBER",
                        "value": "5",
                        "unit": "MP",
                    },
                ]
            },
            {
                "alignments": [
                    {
                        "constraint_id": "c1",
                        "product_candidate_id": "cand1",
                        "claim_ids": ["clm1"],
                        "status": "ALIGNED",
                        "method": "EXACT_ATTRIBUTE_KEY",
                        "reason": "same attribute",
                    },
                    {
                        "constraint_id": "c1",
                        "product_candidate_id": "cand2",
                        "claim_ids": ["clm2"],
                        "status": "ALIGNED",
                        "method": "EXACT_ATTRIBUTE_KEY",
                        "reason": "same attribute",
                    },
                ]
            },
        ]
    )
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1"), candidate("cand2", "prod2")],
        claims=[
            draft("clm1", "prod1", "4MP", "4MP resolution"),
            draft("clm2", "prod2", "5MP", "5MP resolution"),
        ],
        model=model,
        model_by_product={"prod1": "TRI055N", "prod2": "TRI050S-CC"},
        evidence={"ev1": "resolution"},
        evaluated_at=NOW,
    )
    by_candidate = {assessment.product_candidate_id: assessment for assessment in assessments}
    assert by_candidate["cand1"].hard_spec_overall == ConstraintStatus.FAIL
    assert by_candidate["cand2"].hard_spec_overall == ConstraintStatus.PASS
    assert by_candidate["cand1"].product_model_ref == "TRI055N"
    assert by_candidate["cand2"].product_model_ref == "TRI050S-CC"


def test_the_summary_counts_the_outcomes():
    model = ScriptedModel([typing_payload("5"), alignment_payload()])
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1")],
        claims=[draft("clm1", "prod1", "5MP", "5MP resolution")],
        model=model,
        model_by_product={"prod1": "TRI055N"},
        evidence={"ev1": "5MP resolution"},
        evaluated_at=NOW,
    )
    summary = summarize(assessments)
    assert summary["assessments"] == 1
    assert summary["by_overall"] == {"PASS": 1}
    assert summary["requirements"] == ["r1"]


def test_an_alignment_the_code_refuses_stays_unknown():
    model = ScriptedModel(
        [
            typing_payload("5"),
            {
                "alignments": [
                    {
                        "constraint_id": "c1",
                        "product_candidate_id": "cand1",
                        "claim_ids": ["clm1"],
                        "status": "ALIGNED",
                        "method": "EXACT_ATTRIBUTE_KEY",
                        "reason": "same attribute",
                    }
                ]
            },
        ]
    )
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1")],
        claims=[draft("clm1", "prod1", "5MP", "5MP resolution")],
        model=model,
        model_by_product={"prod1": "TRI055N"},
        evidence={"ev1": "5MP resolution"},
        evaluated_at=NOW,
    )
    assert assessments[0].hard_spec_overall == ConstraintStatus.PASS


def test_an_alignment_for_another_candidate_does_not_reach_this_one():
    model = ScriptedModel(
        [
            typing_payload("5"),
            {
                "alignments": [
                    {
                        "constraint_id": "c1",
                        "product_candidate_id": "cand9",
                        "claim_ids": ["clm1"],
                        "status": "ALIGNED",
                        "method": "EXACT_ATTRIBUTE_KEY",
                        "reason": "same attribute",
                    }
                ]
            },
        ]
    )
    assessments = evaluate_candidates(
        requirements=[requirement(constraint())],
        candidates=[candidate("cand1", "prod1")],
        claims=[draft("clm1", "prod1", "5MP", "5MP resolution")],
        model=model,
        model_by_product={"prod1": "TRI055N"},
        evidence={"ev1": "5MP resolution"},
        evaluated_at=NOW,
    )
    assert assessments[0].hard_spec_overall == ConstraintStatus.UNKNOWN
    assert assessments[0].checks[0].reason_code == ConstraintReasonCode.MISSING_CLAIM
