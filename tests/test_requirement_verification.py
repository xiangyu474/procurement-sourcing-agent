"""Tests for the deterministic verification of the numbers the compiler read."""

from __future__ import annotations

from decimal import Decimal

from procurement_agent.domain.requirements import (
    ConflictValue,
    ConstraintOperator,
    ConstraintOrigin,
    DataConflict,
    Importance,
    ParseStatus,
    PlannedAmount,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    RequirementSourceType,
    SourceFragment,
    ValueType,
)
from procurement_agent.services.requirement_verification import (
    apply_source_verification,
    verify_project_total,
)

LOCATOR = "pptx:project=p1:source=s1:file=demo.pptx:slide=1:shape=0:paragraph=1"


def fragment(text: str, locator: str = LOCATOR) -> SourceFragment:
    return SourceFragment(
        source_id="s1",
        source_type=RequirementSourceType.INTERNAL_PPTX,
        locator=locator,
        text=text,
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
        "source_ref": LOCATOR,
        "source_quote": "5MP 工业网络摄像机",
    }
    fields.update(overrides)
    return RequirementConstraint(**fields)


def requirement(**overrides) -> Requirement:
    fields = {
        "requirement_id": "r1",
        "project_id": "p1",
        "product_name": "5MP 工业网络摄像机",
        "quantity": "10",
        "quantity_unit": "套",
        "source_refs": [LOCATOR],
    }
    fields.update(overrides)
    return Requirement(**fields)


def compilation(*requirements: Requirement, **kwargs) -> RequirementCompilation:
    return RequirementCompilation(project_id="p1", requirements=list(requirements), **kwargs)


def _check(result, scope: str, reference: str):
    """Find one check by scope and reference."""
    for check in result.number_checks:
        if check.scope == scope and check.reference == reference:
            return check
    raise AssertionError(f"no {scope} check for {reference}")


# --- constraint numbers -----------------------------------------------------


def test_a_quote_that_states_the_value_keeps_the_constraint_resolved():
    result = apply_source_verification(
        compilation(requirement(constraints=[constraint()])),
        [fragment("采购需求：5MP 工业网络摄像机，采购数量 10 套。")],
    )
    check = _check(result, "constraint", "c1")
    assert check.verified
    assert result.compilation.requirements[0].constraints[0].parse_status == ParseStatus.RESOLVED
    assert not result.unverifiable


def test_a_value_the_quote_does_not_state_marks_the_constraint_ambiguous():
    result = apply_source_verification(
        compilation(requirement(constraints=[constraint(value="4")])),
        [fragment("采购需求：5MP 工业网络摄像机，采购数量 10 套。")],
    )
    item = result.compilation.requirements[0].constraints[0]
    assert item.parse_status == ParseStatus.AMBIGUOUS
    assert item.validation_issues
    assert any("AMBIGUOUS" in issue for issue in result.compilation.issues)


def test_a_quote_that_is_not_in_the_source_marks_the_constraint_ambiguous():
    result = apply_source_verification(
        compilation(requirement(constraints=[constraint(source_quote="8MP 工业网络摄像机")])),
        [fragment("采购需求：5MP 工业网络摄像机，采购数量 10 套。")],
    )
    item = result.compilation.requirements[0].constraints[0]
    assert item.parse_status == ParseStatus.AMBIGUOUS
    assert "not found in the cited fragment" in item.validation_issues[0]


def test_the_same_number_in_another_unit_is_confirmed():
    result = apply_source_verification(
        compilation(requirement(constraints=[constraint(source_quote="分辨率不低于500万像素")])),
        [fragment("分辨率不低于500万像素")],
    )
    assert _check(result, "constraint", "c1").verified
    assert result.compilation.requirements[0].constraints[0].parse_status == ParseStatus.RESOLVED


def test_a_range_with_a_negative_bound_is_confirmed():
    item = constraint(
        constraint_id="c2",
        attribute_key="operating_temperature",
        value_type=ValueType.RANGE,
        operator=ConstraintOperator.RANGE_COVERS,
        value={"lower": "-20", "upper": "80", "lower_inclusive": True, "upper_inclusive": True},
        unit="degC",
        source_quote="工作温度 -20℃ ~ 80℃",
    )
    result = apply_source_verification(
        compilation(requirement(constraints=[item])),
        [fragment("工作温度 -20℃ ~ 80℃")],
    )
    assert _check(result, "constraint", "c2").verified


def test_a_boolean_constraint_is_not_treated_as_a_number():
    item = constraint(
        value_type=ValueType.BOOLEAN,
        operator=ConstraintOperator.EQ,
        value=True,
        unit=None,
        source_quote="接入 OneNET",
    )
    result = apply_source_verification(
        compilation(requirement(constraints=[item])),
        [fragment("接入 OneNET | 是")],
    )
    assert _check(result, "constraint", "c1").verified
    assert result.compilation.requirements[0].constraints[0].parse_status == ParseStatus.RESOLVED


def test_the_verification_never_changes_the_quantity_or_the_price():
    result = apply_source_verification(
        compilation(requirement(quantity="999")),
        [fragment("采购需求：5MP 工业网络摄像机，采购数量 10 套。")],
    )
    item = result.compilation.requirements[0]
    assert item.quantity == "999"
    assert any("quantity" in issue for issue in result.compilation.issues)


def test_an_amount_the_quote_does_not_state_is_recorded():
    amount = PlannedAmount(
        kind="PLANNED_PRICE",
        value="250",
        currency="CNY",
        unit="元/套",
        source_ref=LOCATOR,
        source_quote="预计采购单价 100 元/套",
    )
    result = apply_source_verification(
        compilation(requirement(planned_unit_price=amount)),
        [fragment("采购需求：5MP 工业网络摄像机，预计采购单价 100 元/套。")],
    )
    assert any("planned_unit_price" in issue for issue in result.compilation.issues)
    assert result.compilation.requirements[0].open_questions


def test_the_verification_returns_a_copy():
    original = compilation(requirement(constraints=[constraint(value="4")]))
    result = apply_source_verification(original, [fragment("5MP 工业网络摄像机")])
    assert original.requirements[0].constraints[0].parse_status == ParseStatus.RESOLVED
    assert result.compilation.requirements[0].constraints[0].parse_status == ParseStatus.AMBIGUOUS


# --- the project total ------------------------------------------------------


def _budget(value: str, unit: str = "万元") -> PlannedAmount:
    return PlannedAmount(
        kind="PLANNED_BUDGET",
        value=value,
        currency="CNY",
        unit=unit,
        source_ref=LOCATOR,
        source_quote=value,
    )


def _conflict(*values: str) -> DataConflict:
    return DataConflict(
        conflict_id="k1",
        project_id="p1",
        field="planned_total_budget",
        values_with_source=[
            ConflictValue(value=value, source_ref=LOCATOR, source_quote=value) for value in values
        ],
    )


def test_an_exact_total_is_reported_as_exact():
    items = [
        requirement(requirement_id=f"r{index}", planned_total_budget=_budget(value))
        for index, value in enumerate(["70.62", "111.87", "2395.60"], start=1)
    ]
    result = verify_project_total(compilation(*items, conflicts=[_conflict("2578.09")]))
    assert result.computed_sum == "2578.09"
    assert result.classification == "EXACT"


def test_a_gap_inside_the_rounding_tolerance_is_a_rounding_difference():
    items = [
        requirement(requirement_id=f"r{index}", planned_total_budget=_budget(value))
        for index, value in enumerate(["70.62", "111.87", "2395.60"], start=1)
    ]
    result = verify_project_total(compilation(*items, conflicts=[_conflict("2578.11", "2578.09")]))
    assert result.classification == "ROUNDING"
    assert result.difference == "0.02"


def test_a_gap_beyond_the_rounding_tolerance_is_a_source_difference():
    items = [
        requirement(requirement_id=f"r{index}", planned_total_budget=_budget(value))
        for index, value in enumerate(["70.62", "111.87", "2395.60"], start=1)
    ]
    result = verify_project_total(compilation(*items, conflicts=[_conflict("2600.00", "2578.09")]))
    assert result.classification == "SOURCE_DIFFERENCE"


def test_a_sum_that_matches_no_stated_total_is_flagged_for_review():
    items = [
        requirement(requirement_id=f"r{index}", planned_total_budget=_budget(value))
        for index, value in enumerate(["70.62", "111.87"], start=1)
    ]
    result = verify_project_total(compilation(*items, conflicts=[_conflict("9999.99")]))
    assert result.classification == "ARITHMETIC_MISMATCH"
    assert result.computed_sum == "182.49"


def test_a_project_without_budgets_has_nothing_to_check():
    result = verify_project_total(compilation(requirement()))
    assert result.classification == "NO_TOTAL"


def test_the_rounding_tolerance_grows_with_the_number_of_rows():
    items = [
        requirement(requirement_id=f"r{index}", planned_total_budget=_budget("0.01"))
        for index in range(1, 15)
    ]
    result = verify_project_total(compilation(*items, conflicts=[_conflict("0.15", "0.14")]))
    assert result.classification == "ROUNDING"
    assert Decimal("0.01") <= Decimal(result.difference or "0") + Decimal("0.07")


# --- the compiler uses the verification --------------------------------------


def test_the_compiler_prompt_asks_for_a_specification_constraint():
    from procurement_agent.ingestion.compiler import SYSTEM_PROMPT

    assert "Never leave a stated specification only inside the product name." in SYSTEM_PROMPT
    assert "output_resolution" in SYSTEM_PROMPT
