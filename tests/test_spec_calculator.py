"""Tests for the M3-A constraint calculator.

The calculator is pure, so every case here runs without a model or a network.
"""

from __future__ import annotations

import inspect
from datetime import UTC, datetime

import pytest

from procurement_agent.domain.requirements import (
    ConstraintOperator,
    ConstraintOrigin,
    Importance,
    ParseStatus,
    Requirement,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.domain.sourcing import ClaimStatus
from procurement_agent.domain.spec_alignment import (
    AlignmentMethod,
    AlignmentStatus,
    ConstraintReasonCode,
    ConstraintStatus,
    ProductAttributeClaim,
    SemanticAlignment,
)
from procurement_agent.services import spec_calculator
from procurement_agent.services.spec_calculator import (
    aggregate_hard_checks,
    evaluate_constraint,
    evaluate_requirement_product,
)

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)


def constraint(**overrides) -> RequirementConstraint:
    fields = {
        "constraint_id": "c1",
        "requirement_id": "r1",
        "attribute_key": "output_resolution",
        "attribute_definition": "Video output pixel count",
        "value_type": ValueType.NUMBER,
        "operator": ConstraintOperator.GTE,
        "value": "5",
        "unit": "MP",
        "importance": Importance.HARD,
        "origin": ConstraintOrigin.PPT_EXPLICIT,
        "source_ref": "pptx:project=p1:slide=1:shape=0:paragraph=1",
        "source_quote": "5MP 工业网络摄像机",
    }
    fields.update(overrides)
    return RequirementConstraint(**fields)


def claim(**overrides) -> ProductAttributeClaim:
    fields = {
        "claim_id": "clm1",
        "product_ref": "cand1",
        "product_model_ref": "TRI055N",
        "attribute_key": "output_resolution",
        "attribute_definition": "Video output pixel count",
        "value_type": ValueType.NUMBER,
        "value": "4",
        "unit": "MP",
        "evidence_ids": ["ev1"],
        "source_quote": "5MP resolution",
    }
    fields.update(overrides)
    return ProductAttributeClaim(**fields)


def alignment(**overrides) -> SemanticAlignment:
    fields = {
        "constraint_id": "c1",
        "claim_ids": ["clm1"],
        "status": AlignmentStatus.ALIGNED,
        "method": AlignmentMethod.EXACT_ATTRIBUTE_KEY,
        "reason": "both sides state the video output pixel count",
    }
    fields.update(overrides)
    return SemanticAlignment(**fields)


def requirement(*constraints: RequirementConstraint) -> Requirement:
    return Requirement(
        requirement_id="r1",
        project_id="p1",
        product_name="5MP 工业网络摄像机",
        constraints=list(constraints),
    )


# --- the acceptance cases the milestone names outright ------------------------


def test_four_megapixel_fails_a_five_megapixel_minimum():
    check = evaluate_constraint(
        constraint(),
        [claim(value="4", unit="MP")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.FAIL
    assert check.reason_code == ConstraintReasonCode.VERIFIED_COMPARISON
    assert check.operation == "4 MP GTE 5 MP"
    assert check.normalized_actual == "4"
    assert check.normalized_required == "5"
    assert check.evidence_ids == ["ev1"]
    assert check.source_refs == ["pptx:project=p1:slide=1:shape=0:paragraph=1"]


def test_micrometre_thickness_converts_to_millimetre():
    check = evaluate_constraint(
        constraint(
            attribute_key="housing_thickness",
            operator=ConstraintOperator.LTE,
            value="0.2",
            unit="mm",
        ),
        [claim(attribute_key="housing_thickness", value="150", unit="um")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.PASS
    assert check.operation == "0.15 mm LTE 0.2 mm"


def test_input_power_is_not_rated_output_power():
    check = evaluate_constraint(
        constraint(
            attribute_key="rated_output_power",
            operator=ConstraintOperator.GTE,
            value="7.5",
            unit="kW",
        ),
        [claim(attribute_key="max_input_power", value="8", unit="kW")],
        alignment(
            status=AlignmentStatus.NOT_ALIGNED,
            reason="the requirement asks for rated output power and the source states maximum input power",
        ),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.UNKNOWN
    assert check.reason_code == ConstraintReasonCode.ATTRIBUTE_NOT_ALIGNED
    assert check.normalized_actual is None


def test_missing_claim_is_unknown():
    check = evaluate_constraint(constraint(), [], alignment(), product_model_ref="TRI055N")
    assert check.status == ConstraintStatus.UNKNOWN
    assert check.reason_code == ConstraintReasonCode.MISSING_CLAIM


# --- aggregation ------------------------------------------------------------


def test_one_hard_failure_makes_the_overall_fail_even_with_an_unknown():
    checks = [
        evaluate_constraint(constraint(), [claim(value="4", unit="MP")], alignment(), product_model_ref="TRI055N"),
        evaluate_constraint(
            constraint(constraint_id="c2", attribute_key="ingress_rating", value_type=ValueType.STRING, operator=ConstraintOperator.EQ, value="IP66", unit=None),
            [],
            alignment(constraint_id="c2"),
            product_model_ref="TRI055N",
        ),
    ]
    overall, reasons = aggregate_hard_checks(checks)
    assert overall == ConstraintStatus.FAIL
    assert reasons == [ConstraintReasonCode.VERIFIED_COMPARISON]


def test_a_pass_and_an_unknown_give_an_unknown_overall():
    checks = [
        evaluate_constraint(constraint(), [claim(value="5", unit="MP")], alignment(), product_model_ref="TRI055N"),
        evaluate_constraint(
            constraint(constraint_id="c2", attribute_key="ingress_rating", value_type=ValueType.STRING, operator=ConstraintOperator.EQ, value="IP66", unit=None),
            [],
            alignment(constraint_id="c2"),
            product_model_ref="TRI055N",
        ),
    ]
    overall, reasons = aggregate_hard_checks(checks)
    assert overall == ConstraintStatus.UNKNOWN
    assert ConstraintReasonCode.MISSING_CLAIM in reasons


def test_a_requirement_without_hard_constraints_is_not_a_pass():
    overall, reasons = aggregate_hard_checks([])
    assert overall == ConstraintStatus.UNKNOWN
    assert reasons == [ConstraintReasonCode.NO_HARD_CONSTRAINT]


def test_unresolved_demand_keeps_the_overall_unknown():
    checks = [
        evaluate_constraint(constraint(), [claim(value="5", unit="MP")], alignment(), product_model_ref="TRI055N")
    ]
    overall, reasons = aggregate_hard_checks(checks, unresolved_demand=["工业级可靠"])
    assert overall == ConstraintStatus.UNKNOWN
    assert reasons == [ConstraintReasonCode.UNRESOLVED_DEMAND]


def test_a_preference_does_not_change_the_hard_overall():
    checks = [
        evaluate_constraint(constraint(), [claim(value="5", unit="MP")], alignment(), product_model_ref="TRI055N"),
        evaluate_constraint(
            constraint(constraint_id="c2", importance=Importance.PREFERENCE, attribute_key="brand", value_type=ValueType.STRING, operator=ConstraintOperator.EQ, value="ACME", unit=None),
            [],
            alignment(constraint_id="c2"),
            product_model_ref="TRI055N",
        ),
    ]
    overall, reasons = aggregate_hard_checks(checks)
    assert overall == ConstraintStatus.PASS
    assert reasons == [ConstraintReasonCode.VERIFIED_COMPARISON]


# --- admission gates --------------------------------------------------------


def test_a_product_without_an_exact_model_cannot_pass():
    check = evaluate_constraint(constraint(), [claim(value="5", unit="MP")], alignment(), product_model_ref=None)
    assert check.status == ConstraintStatus.UNKNOWN
    assert check.reason_code == ConstraintReasonCode.MODEL_VARIANT_UNCERTAIN


def test_an_unresolved_requirement_is_unknown():
    check = evaluate_constraint(
        constraint(parse_status=ParseStatus.AMBIGUOUS),
        [claim(value="5", unit="MP")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.reason_code == ConstraintReasonCode.AMBIGUOUS_REQUIREMENT


def test_a_claim_without_source_support_is_unknown():
    check = evaluate_constraint(
        constraint(),
        [claim(value="5", unit="MP", claim_status=ClaimStatus.UNVERIFIED)],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.reason_code == ConstraintReasonCode.UNVERIFIED_CLAIM


def test_two_sources_with_different_values_conflict():
    check = evaluate_constraint(
        constraint(),
        [claim(value="5", unit="MP"), claim(claim_id="clm2", value="4", unit="MP")],
        alignment(claim_ids=["clm1", "clm2"]),
        product_model_ref="TRI055N",
    )
    assert check.reason_code == ConstraintReasonCode.CONFLICTING_CLAIMS


def test_a_qualifier_the_claim_does_not_state_blocks_the_comparison():
    check = evaluate_constraint(
        constraint(qualifiers={"stream": "main"}),
        [claim(value="5", unit="MP")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.reason_code == ConstraintReasonCode.CONDITIONAL_MISMATCH


def test_units_from_different_measurements_do_not_compare():
    check = evaluate_constraint(constraint(), [claim(value="150", unit="um")], alignment(), product_model_ref="TRI055N")
    assert check.reason_code == ConstraintReasonCode.UNIT_NOT_CONVERTIBLE


def test_decimal_and_binary_storage_bytes_do_not_compare():
    check = evaluate_constraint(
        constraint(attribute_key="storage", operator=ConstraintOperator.GTE, value="32", unit="GB"),
        [claim(attribute_key="storage", value="32", unit="GiB")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.reason_code == ConstraintReasonCode.UNIT_NOT_CONVERTIBLE


def test_a_claim_without_a_unit_does_not_compare_with_a_unit():
    check = evaluate_constraint(constraint(), [claim(value="5", unit=None)], alignment(), product_model_ref="TRI055N")
    assert check.reason_code == ConstraintReasonCode.UNIT_NOT_CONVERTIBLE


def test_a_claim_of_another_model_is_not_used():
    check = evaluate_constraint(
        constraint(),
        [claim(product_model_ref="TRI050S-CC", value="5", unit="MP")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.reason_code == ConstraintReasonCode.MISSING_CLAIM


# --- other operators --------------------------------------------------------


def test_a_range_covers_the_required_range():
    check = evaluate_constraint(
        constraint(
            value_type=ValueType.RANGE,
            operator=ConstraintOperator.RANGE_COVERS,
            value={"lower": "-20", "upper": "80", "lower_inclusive": True, "upper_inclusive": True},
            unit="degC",
        ),
        [
            claim(
                value_type=ValueType.RANGE,
                value={"lower": "-30", "upper": "90", "lower_inclusive": True, "upper_inclusive": True},
                unit="degC",
            )
        ],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.PASS
    assert check.reason_code == ConstraintReasonCode.VERIFIED_COMPARISON


def test_a_range_that_does_not_cover_fails():
    check = evaluate_constraint(
        constraint(
            value_type=ValueType.RANGE,
            operator=ConstraintOperator.RANGE_COVERS,
            value={"lower": "-20", "upper": "80", "lower_inclusive": True, "upper_inclusive": True},
            unit="degC",
        ),
        [
            claim(
                value_type=ValueType.RANGE,
                value={"lower": "-10", "upper": "70", "lower_inclusive": True, "upper_inclusive": True},
                unit="degC",
            )
        ],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.FAIL


def test_contains_needs_a_set_and_refuses_a_bare_string():
    check = evaluate_constraint(
        constraint(
            attribute_key="supported_protocols",
            value_type=ValueType.SET,
            operator=ConstraintOperator.CONTAINS,
            value=["ONVIF"],
            unit=None,
        ),
        [claim(attribute_key="supported_protocols", value="ONVIF")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.UNKNOWN
    assert check.reason_code == ConstraintReasonCode.UNSUPPORTED_FOR_AUTO_CHECK


def test_contains_passes_when_the_product_lists_the_token():
    check = evaluate_constraint(
        constraint(
            attribute_key="supported_protocols",
            value_type=ValueType.SET,
            operator=ConstraintOperator.CONTAINS,
            value=["ONVIF"],
            unit=None,
        ),
        [claim(attribute_key="supported_protocols", value=["ONVIF", "Modbus TCP"])],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.PASS


def test_a_boolean_constraint_compares():
    check = evaluate_constraint(
        constraint(
            attribute_key="onenet_access",
            value_type=ValueType.BOOLEAN,
            operator=ConstraintOperator.EQ,
            value=True,
            unit=None,
        ),
        [claim(attribute_key="onenet_access", value=True)],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.PASS


def test_a_string_membership_compares():
    check = evaluate_constraint(
        constraint(
            attribute_key="interface_model",
            value_type=ValueType.STRING,
            operator=ConstraintOperator.IN,
            value=["RJ45", "M12"],
            unit=None,
        ),
        [claim(attribute_key="interface_model", value="m12")],
        alignment(),
        product_model_ref="TRI055N",
    )
    assert check.status == ConstraintStatus.PASS


# --- the assessment ---------------------------------------------------------


def test_the_assessment_reports_the_model_it_judged():
    assessment = evaluate_requirement_product(
        requirement(constraint()),
        "cand1",
        "TRI055N",
        [claim(value="4", unit="MP")],
        [alignment()],
        evaluated_at=NOW,
    )
    assert assessment.hard_spec_overall == ConstraintStatus.FAIL
    assert assessment.hard_constraint_count == 1
    assert assessment.calculator_version == "0.1.0"
    assert assessment.evaluated_at == NOW
    assert assessment.checks[0].status == ConstraintStatus.FAIL


def test_two_models_of_one_supplier_are_judged_separately():
    fast = evaluate_requirement_product(
        requirement(constraint()),
        "cand1",
        "TRI055N",
        [claim(value="4", unit="MP")],
        [alignment()],
        evaluated_at=NOW,
    )
    slow = evaluate_requirement_product(
        requirement(constraint()),
        "cand2",
        "TRI050S-CC",
        [claim(claim_id="clm9", product_ref="cand2", product_model_ref="TRI050S-CC", value="5", unit="MP")],
        [alignment(claim_ids=["clm9"])],
        evaluated_at=NOW,
    )
    assert fast.hard_spec_overall == ConstraintStatus.FAIL
    assert slow.hard_spec_overall == ConstraintStatus.PASS
    assert fast.product_model_ref != slow.product_model_ref


# --- the calculator stays pure ---------------------------------------------


def test_the_calculator_imports_no_provider_client():
    source = inspect.getsource(spec_calculator)
    for forbidden in ("tavily", "httpx", "requests", "build_chat_model", "openai"):
        assert forbidden not in source.lower()


# --- the same code has to work for any category ----------------------------


@pytest.mark.parametrize(
    ("attribute_key", "unit", "required", "actual"),
    [
        ("output_resolution", "MP", "5", "4"),
        ("motor_power", "kW", "7.5", "5.5"),
        ("package_weight", "kg", "2", "1.8"),
        ("server_memory", "GB", "64", "32"),
    ],
)
def test_the_same_code_judges_four_categories(attribute_key, unit, required, actual):
    check = evaluate_constraint(
        constraint(attribute_key=attribute_key, unit=unit, value=required),
        [claim(attribute_key=attribute_key, unit=unit, value=actual, product_model_ref="MODEL-1")],
        alignment(),
        product_model_ref="MODEL-1",
    )
    assert check.status == ConstraintStatus.FAIL
    assert check.reason_code == ConstraintReasonCode.VERIFIED_COMPARISON


# --- a vague demand is never satisfied by default ----------------------------


def test_a_vague_demand_is_not_a_constraint_and_not_satisfied():
    """「工业级可靠」is not a threshold, so it cannot become a passing check."""
    from procurement_agent.ingestion.compiler import SYSTEM_PROMPT

    assert '"工业级", "口碑好", "符合相关标准" are not constraints' in SYSTEM_PROMPT
    # A requirement without a hard constraint is not a pass.
    checks: list = []
    overall, reasons = aggregate_hard_checks(checks)
    assert overall == ConstraintStatus.UNKNOWN
    assert reasons == [ConstraintReasonCode.NO_HARD_CONSTRAINT]


def test_an_unresolved_demand_keeps_the_overall_unknown():
    """A demand that could not be compiled stops the overall from being a pass."""
    checks = [
        evaluate_constraint(constraint(), [claim(value="5", unit="MP")], alignment(), product_model_ref="TRI055N")
    ]
    overall, reasons = aggregate_hard_checks(checks, unresolved_demand=["工业级可靠"])
    assert overall == ConstraintStatus.UNKNOWN
    assert reasons == [ConstraintReasonCode.UNRESOLVED_DEMAND]


def test_an_unconfirmed_attribute_is_not_treated_as_standardised():
    """A web claim that only looks like the requirement does not become a value."""
    from procurement_agent.domain.spec_alignment import AlignmentMethod, AlignmentProposal
    from procurement_agent.services.spec_alignment import canonical_alignment

    proposal = AlignmentProposal(
        constraint_id="c1",
        product_candidate_id="cand1",
        claim_ids=["clm1"],
        status="ALIGNED",
        method=AlignmentMethod.EXACT_ATTRIBUTE_KEY,
        reason="the two look like the same attribute",
    )
    alignment = canonical_alignment(
        proposal,
        constraint=constraint(),
        claims={"clm1": claim(attribute_key="sensor_resolution")},
    )
    assert alignment.status.value == "NOT_ALIGNED"
    check = evaluate_constraint(constraint(), [claim(attribute_key="sensor_resolution")], alignment, product_model_ref="TRI055N")
    assert check.status == ConstraintStatus.UNKNOWN
    assert check.reason_code == ConstraintReasonCode.ATTRIBUTE_NOT_ALIGNED


def test_several_values_of_one_measurement_pass_when_every_value_satisfies():
    """The model may refuse to pick a value; the code can still answer."""
    from procurement_agent.domain.spec_alignment import AmbiguityKind

    target = constraint(value="5", unit="MP", operator=ConstraintOperator.GTE)
    claims = [
        claim(claim_id="c1", value="5", unit="MP", attribute_key="output_resolution", product_model_ref="m1", claim_status=ClaimStatus.SUPPORTED_BY_SOURCE, extraction_status=ParseStatus.RESOLVED),
        claim(claim_id="c2", value="3072x1728", unit="px", attribute_key="output_resolution", product_model_ref="m1", claim_status=ClaimStatus.SUPPORTED_BY_SOURCE, extraction_status=ParseStatus.RESOLVED),
    ]
    alignment = SemanticAlignment(
        constraint_id=target.constraint_id,
        claim_ids=["c1", "c2"],
        status=AlignmentStatus.AMBIGUOUS,
        method=AlignmentMethod.EXACT_ATTRIBUTE_KEY,
        reason="several values of the same measurement",
        ambiguity_kind=AmbiguityKind.SEVERAL_VALUES,
    )
    check = evaluate_constraint(target, claims, alignment, product_model_ref="m1")
    assert check.status == ConstraintStatus.PASS
    assert check.reason_code == ConstraintReasonCode.VERIFIED_COMPARISON
    assert check.claim_ids == ["c1", "c2"]


def test_an_unconfirmed_role_stays_unknown():
    from procurement_agent.domain.spec_alignment import AmbiguityKind

    target = constraint(value="5", unit="MP", operator=ConstraintOperator.GTE)
    claims = [claim(claim_id="c1", value="5", unit="MP", attribute_key="output_resolution", product_model_ref="m1", claim_status=ClaimStatus.SUPPORTED_BY_SOURCE, extraction_status=ParseStatus.RESOLVED)]
    alignment = SemanticAlignment(
        constraint_id=target.constraint_id,
        claim_ids=["c1"],
        status=AlignmentStatus.AMBIGUOUS,
        method=AlignmentMethod.EXACT_ATTRIBUTE_KEY,
        reason="the role of the value is not confirmed",
        ambiguity_kind=AmbiguityKind.ROLE_UNCONFIRMED,
    )
    check = evaluate_constraint(target, claims, alignment, product_model_ref="m1")
    assert check.status == ConstraintStatus.UNKNOWN


def test_a_value_that_does_not_satisfy_the_requirement_stays_unknown():
    from procurement_agent.domain.spec_alignment import AmbiguityKind

    target = constraint(value="5", unit="MP", operator=ConstraintOperator.GTE)
    claims = [
        claim(claim_id="c1", value="5", unit="MP", attribute_key="output_resolution", product_model_ref="m1", claim_status=ClaimStatus.SUPPORTED_BY_SOURCE, extraction_status=ParseStatus.RESOLVED),
        claim(claim_id="c2", value="3", unit="MP", attribute_key="output_resolution", product_model_ref="m1", claim_status=ClaimStatus.SUPPORTED_BY_SOURCE, extraction_status=ParseStatus.RESOLVED),
    ]
    alignment = SemanticAlignment(
        constraint_id=target.constraint_id,
        claim_ids=["c1", "c2"],
        status=AlignmentStatus.AMBIGUOUS,
        method=AlignmentMethod.EXACT_ATTRIBUTE_KEY,
        reason="several values",
        ambiguity_kind=AmbiguityKind.SEVERAL_VALUES,
    )
    check = evaluate_constraint(target, claims, alignment, product_model_ref="m1")
    assert check.status == ConstraintStatus.UNKNOWN
