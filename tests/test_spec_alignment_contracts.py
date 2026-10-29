"""Tests for the M3-A contracts and the unit whitelist."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from procurement_agent.domain.requirements import ValueType
from procurement_agent.domain.spec_alignment import (
    AlignmentMethod,
    AlignmentStatus,
    ConstraintCheck,
    ConstraintReasonCode,
    ConstraintStatus,
    ProductAttributeClaim,
    SemanticAlignment,
    SpecAssessment,
)
from procurement_agent.domain.units import (
    UnitDimension,
    convert_between,
    normalize_unit,
    unit_spec,
    units_compatible,
)

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)


def claim(**overrides) -> ProductAttributeClaim:
    fields = {
        "claim_id": "clm1",
        "product_candidate_id": "cand1",
        "product_model_ref": "TRI055N",
        "attribute_key": "output_resolution",
        "attribute_definition": "Video output pixel count",
        "value_type": ValueType.NUMBER,
        "value": "5",
        "unit": "MP",
        "evidence_ids": ["ev1"],
        "source_quote": "5MP resolution",
    }
    fields.update(overrides)
    return ProductAttributeClaim(**fields)


def check(**overrides) -> ConstraintCheck:
    fields = {
        "constraint_id": "c1",
        "requirement_id": "r1",
        "status": ConstraintStatus.PASS,
        "reason_code": ConstraintReasonCode.VERIFIED_COMPARISON,
        "explanation": "the product meets the requirement",
        "importance": "HARD",
    }
    fields.update(overrides)
    return ConstraintCheck(**fields)


def test_a_source_supported_claim_must_cite_evidence():
    with pytest.raises(ValidationError):
        claim(evidence_ids=[])


def test_a_claim_attribute_key_is_a_plain_identifier():
    assert claim(attribute_key="output_resolution").attribute_key == "output_resolution"
    with pytest.raises(ValidationError):
        claim(attribute_key="Output Resolution")
    with pytest.raises(ValidationError):
        claim(attribute_key=" output_resolution ")


def test_a_claim_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        claim(extra_field="x")


def test_an_aligned_alignment_must_name_its_claims():
    with pytest.raises(ValidationError):
        SemanticAlignment(
            constraint_id="c1",
            claim_ids=[],
            status=AlignmentStatus.ALIGNED,
            method=AlignmentMethod.EXACT_ATTRIBUTE_KEY,
            reason="same attribute",
        )
    assert (
        SemanticAlignment(
            constraint_id="c1",
            claim_ids=[],
            status=AlignmentStatus.NOT_ALIGNED,
            method=AlignmentMethod.LLM_PROPOSED_REVIEWED,
            reason="different measurement",
        ).status
        == AlignmentStatus.NOT_ALIGNED
    )


def test_an_assessment_needs_an_aware_timestamp():
    with pytest.raises(ValidationError):
        SpecAssessment(
            requirement_id="r1",
            product_candidate_id="cand1",
            hard_spec_overall=ConstraintStatus.UNKNOWN,
            evaluated_at=datetime(2026, 10, 28, 12, 0),
        )


def test_the_assessment_counts_the_hard_checks_it_carries():
    with pytest.raises(ValidationError):
        SpecAssessment(
            requirement_id="r1",
            product_candidate_id="cand1",
            checks=[check()],
            hard_spec_overall=ConstraintStatus.PASS,
            hard_constraint_count=0,
            evaluated_at=NOW,
        )


def test_a_hard_failure_must_reach_the_overall_status():
    with pytest.raises(ValidationError):
        SpecAssessment(
            requirement_id="r1",
            product_candidate_id="cand1",
            checks=[check(status=ConstraintStatus.FAIL)],
            hard_spec_overall=ConstraintStatus.UNKNOWN,
            hard_constraint_count=1,
            evaluated_at=NOW,
        )


def test_a_preference_failure_may_not_make_the_overall_fail():
    assessment = SpecAssessment(
        requirement_id="r1",
        product_candidate_id="cand1",
        checks=[check(status=ConstraintStatus.FAIL, importance="PREFERENCE")],
        hard_spec_overall=ConstraintStatus.UNKNOWN,
        hard_constraint_count=0,
        evaluated_at=NOW,
    )
    assert assessment.hard_spec_overall == ConstraintStatus.UNKNOWN


def test_a_check_needs_an_explanation():
    with pytest.raises(ValidationError):
        check(explanation="")


# --- the unit whitelist -----------------------------------------------------


def test_units_are_recognised_by_their_spelling():
    assert normalize_unit("µm") == "um"
    assert normalize_unit("Megapixels") == "mp"
    assert normalize_unit("  kW ") == "kw"
    assert normalize_unit(None) is None
    assert normalize_unit("") is None


def test_a_megapixel_is_a_million_pixels():
    assert unit_spec("MP").dimension == UnitDimension.PIXEL_COUNT
    assert convert_between(Decimal5(), "MP", "px") == 5_000_000


def Decimal5():
    from decimal import Decimal

    return Decimal("5")


def test_decimal_and_binary_storage_are_different_measurements():
    assert not units_compatible("GB", "GiB")
    assert units_compatible("GB", "TB")
    assert units_compatible("GiB", "TiB")


def test_a_megapixel_and_a_pixel_are_the_same_quantity():
    assert units_compatible("MP", "px")
    assert unit_spec("MP").dimension == unit_spec("px").dimension


def test_a_frame_rate_is_not_a_frequency():
    assert not units_compatible("fps", "Hz")


def test_two_identical_unknown_units_still_compare():
    assert units_compatible("furlong", "furlong")
    assert not units_compatible("furlong", "smoot")


def test_a_unit_that_is_not_known_cannot_be_converted():
    assert convert_between(Decimal5(), "furlong", "smoot") is None
    assert unit_spec("furlong") is None


def test_a_missing_unit_on_one_side_is_not_compatible():
    assert not units_compatible("MP", None)
    assert units_compatible(None, None)
