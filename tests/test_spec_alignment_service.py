"""Tests for the M3-A2 claim typing and semantic alignment."""

from __future__ import annotations

from datetime import UTC, datetime

from procurement_agent.domain.requirements import (
    ConstraintOperator,
    ConstraintOrigin,
    Importance,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.domain.sourcing import ClaimDraft, ClaimStatus
from procurement_agent.domain.spec_alignment import (
    AlignmentMethod,
    AlignmentProposal,
    AlignmentStatus,
    ProductAttributeClaim,
)
from procurement_agent.services.spec_alignment import (
    _approved_pair,
    canonical_alignment,
)
from procurement_agent.services.spec_typing import _value_is_quoted

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)


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


def typed_claim(**overrides) -> ProductAttributeClaim:
    fields = {
        "claim_id": "clm1",
        "product_ref": "cand1",
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


def proposal(**overrides) -> AlignmentProposal:
    fields = {
        "constraint_id": "c1",
        "product_candidate_id": "cand1",
        "claim_ids": ["clm1"],
        "status": AlignmentStatus.ALIGNED,
        "method": AlignmentMethod.EXACT_ATTRIBUTE_KEY,
        "reason": "both sides state the video output pixel count",
    }
    fields.update(overrides)
    return AlignmentProposal(**fields)


# --- typing: the quotation has to state the value ---------------------------


def test_a_number_the_quotation_states_is_typed():
    assert _value_is_quoted(5, ValueType.NUMBER, "MP", "5MP resolution at 30 fps")


def test_a_number_the_quotation_does_not_state_is_refused():
    assert not _value_is_quoted(4, ValueType.NUMBER, "MP", "5MP resolution at 30 fps")


def test_a_number_in_another_scale_of_the_same_unit_is_typed():
    assert _value_is_quoted(5, ValueType.NUMBER, "MP", "分辨率 500万像素")


def test_a_text_value_has_to_appear_in_the_quotation():
    assert _value_is_quoted("IP66/67", ValueType.STRING, None, "Outdoor bullet rated IP66/67, IK10")
    assert not _value_is_quoted("IP68", ValueType.STRING, None, "Outdoor bullet rated IP66/67, IK10")


def test_a_set_value_needs_every_token_in_the_quotation():
    assert _value_is_quoted(["ONVIF"], ValueType.SET, None, "Conforms to ONVIF Profile S")
    assert not _value_is_quoted(["ONVIF", "Modbus"], ValueType.SET, None, "Conforms to ONVIF Profile S")


def test_a_boolean_has_to_match_a_word_in_the_quotation():
    assert _value_is_quoted(True, ValueType.BOOLEAN, None, "接入 OneNET | 是")
    assert not _value_is_quoted(True, ValueType.BOOLEAN, None, "GigE Vision connector: M12")


def test_a_range_needs_both_bounds_in_the_quotation():
    value = {"lower": "-20", "upper": "80"}
    assert _value_is_quoted(value, ValueType.RANGE, "degC", "工作温度 -20℃ ~ 80℃")
    assert not _value_is_quoted(value, ValueType.RANGE, "degC", "工作温度 -20℃")


# --- alignment: the code checks what it can ----------------------------------


def test_an_exact_key_pairing_is_kept():
    alignment = canonical_alignment(
        proposal(),
        constraint=constraint(),
        claims={"clm1": typed_claim()},
    )
    assert alignment.status == AlignmentStatus.ALIGNED
    assert alignment.claim_ids == ["clm1"]


def test_a_pairing_that_claims_an_exact_key_it_does_not_have_is_refused():
    alignment = canonical_alignment(
        proposal(),
        constraint=constraint(),
        claims={"clm1": typed_claim(attribute_key="sensor_model")},
    )
    assert alignment.status == AlignmentStatus.NOT_ALIGNED
    assert "attribute keys are the same" in alignment.reason


def test_an_approved_alias_pairing_is_kept():
    alignment = canonical_alignment(
        proposal(method=AlignmentMethod.APPROVED_ALIAS),
        constraint=constraint(),
        claims={"clm1": typed_claim(attribute_key="video_output_resolution")},
    )
    assert alignment.status == AlignmentStatus.ALIGNED


def test_an_alias_pairing_that_is_not_approved_is_refused():
    alignment = canonical_alignment(
        proposal(method=AlignmentMethod.APPROVED_ALIAS),
        constraint=constraint(),
        claims={"clm1": typed_claim(attribute_key="sensor_resolution")},
    )
    assert alignment.status == AlignmentStatus.NOT_ALIGNED


def test_a_wrong_method_label_is_repaired_from_the_curated_table():
    """The model said "same measurement" but labelled the pair wrongly."""
    alignment = canonical_alignment(
        proposal(method=AlignmentMethod.EXACT_ATTRIBUTE_KEY),
        constraint=constraint(),
        claims={"clm1": typed_claim(attribute_key="video_output_resolution")},
    )
    assert alignment.status == AlignmentStatus.ALIGNED
    assert alignment.method == AlignmentMethod.APPROVED_ALIAS
    assert alignment.claim_ids == ["clm1"]
    assert "alias table" in alignment.reason


def test_a_wrong_method_label_is_not_repaired_outside_the_curated_table():
    alignment = canonical_alignment(
        proposal(method=AlignmentMethod.EXACT_ATTRIBUTE_KEY),
        constraint=constraint(),
        claims={"clm1": typed_claim(attribute_key="sensor_total_pixels")},
    )
    assert alignment.status == AlignmentStatus.NOT_ALIGNED
    assert alignment.method != AlignmentMethod.APPROVED_ALIAS


def test_the_model_may_still_refuse_a_pairing_the_curated_table_allows():
    """A refusal is a semantic judgement and is not overridden by the code."""
    alignment = canonical_alignment(
        proposal(status=AlignmentStatus.NOT_ALIGNED, method=AlignmentMethod.LLM_PROPOSED_REVIEWED, reason="the source states the sensor size"),
        constraint=constraint(),
        claims={"clm1": typed_claim(attribute_key="video_output_resolution")},
    )
    assert alignment.status == AlignmentStatus.NOT_ALIGNED
    assert alignment.claim_ids == ["clm1"]


def test_rated_output_power_and_max_input_power_are_not_aliases():
    assert not _approved_pair("rated_output_power", "max_input_power")
    assert _approved_pair("max_input_power", "input_power")


def test_a_pairing_that_names_no_claim_is_not_an_alignment():
    alignment = canonical_alignment(
        proposal(claim_ids=[]),
        constraint=constraint(),
        claims={"clm1": typed_claim()},
    )
    assert alignment.status == AlignmentStatus.NOT_ALIGNED


def test_a_pairing_that_names_a_missing_claim_is_refused():
    alignment = canonical_alignment(
        proposal(claim_ids=["clm1", "clm9"]),
        constraint=constraint(),
        claims={"clm1": typed_claim()},
    )
    assert alignment.status == AlignmentStatus.NOT_ALIGNED
    assert "clm9" in alignment.reason


def test_a_reviewed_pairing_needs_a_measurement_object():
    alignment = canonical_alignment(
        proposal(method=AlignmentMethod.LLM_PROPOSED_REVIEWED, dimension=None),
        constraint=constraint(),
        claims={"clm1": typed_claim()},
    )
    assert alignment.status == AlignmentStatus.AMBIGUOUS


def test_a_reviewed_pairing_with_a_measurement_object_is_kept():
    alignment = canonical_alignment(
        proposal(
            method=AlignmentMethod.LLM_PROPOSED_REVIEWED,
            dimension="video output pixel count",
            reason="both sides state the video output pixel count",
        ),
        constraint=constraint(),
        claims={"clm1": typed_claim(attribute_key="camera_resolution")},
    )
    assert alignment.status == AlignmentStatus.ALIGNED
    assert alignment.dimension == "video output pixel count"


def test_a_pairing_across_two_units_is_ambiguous():
    alignment = canonical_alignment(
        proposal(),
        constraint=constraint(unit="MP"),
        claims={"clm1": typed_claim(unit="mm")},
    )
    assert alignment.status == AlignmentStatus.AMBIGUOUS
    assert "one scale" in alignment.reason


def test_a_pairing_for_an_unknown_constraint_is_refused():
    alignment = canonical_alignment(
        proposal(),
        constraint=None,
        claims={"clm1": typed_claim()},
    )
    assert alignment.status == AlignmentStatus.NOT_ALIGNED


def test_a_conflicting_pairing_keeps_its_status():
    alignment = canonical_alignment(
        proposal(status=AlignmentStatus.CONFLICTING, method=AlignmentMethod.LLM_PROPOSED_REVIEWED),
        constraint=constraint(),
        claims={"clm1": typed_claim()},
    )
    assert alignment.status == AlignmentStatus.CONFLICTING


# --- the research claim shape the typer reads --------------------------------


def test_a_research_claim_carries_the_quotation_the_typer_checks():
    draft = ClaimDraft(
        claim_id="clm1",
        subject_type="PRODUCT_MODEL",
        subject_ref="cand1",
        attribute="resolution",
        value="5MP megapixels",
        unit="MP",
        evidence_id="ev1",
        source_quote="5MP resolution",
        status=ClaimStatus.SUPPORTED_BY_SOURCE,
    )
    assert draft.source_quote == "5MP resolution"
    assert draft.status == ClaimStatus.SUPPORTED_BY_SOURCE
