import pytest
from pydantic import ValidationError

from procurement_agent.domain.requirements import (
    ConstraintOrigin,
    ConstraintOperator,
    Importance,
    ParseStatus,
    RequirementConstraint,
    ValueType,
)


def constraint(**overrides):
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
        "origin": ConstraintOrigin.USER_EXPLICIT,
        "source_ref": "user_text:p1:rev_1:line_1:span_0_12",
        "source_quote": "至少 5MP",
    }
    fields.update(overrides)
    return RequirementConstraint(**fields)


def test_numeric_decimal_string_and_trace_are_valid():
    item = constraint()
    assert item.value == "5"
    assert item.source_quote == "至少 5MP"


def test_number_values_must_be_decimal_strings():
    with pytest.raises(ValidationError):
        constraint(value=5)
    with pytest.raises(ValidationError):
        constraint(value="NaN")


def test_operator_is_whitelisted_for_type():
    with pytest.raises(ValidationError):
        constraint(operator="EXEC")
    with pytest.raises(ValidationError):
        constraint(value_type=ValueType.BOOLEAN, value="true", operator=ConstraintOperator.GTE)


def test_inferred_constraint_cannot_be_hard():
    with pytest.raises(ValidationError):
        constraint(origin=ConstraintOrigin.INFERRED_FOR_REVIEW)


def test_range_requires_a_bound_and_decimal_values():
    value = {"lower": "-20", "upper": "80", "lower_inclusive": True, "upper_inclusive": True}
    item = constraint(value_type=ValueType.RANGE, operator=ConstraintOperator.RANGE_COVERS, value=value)
    assert item.value["upper"] == "80"
    with pytest.raises(ValidationError):
        constraint(value_type=ValueType.RANGE, operator=ConstraintOperator.RANGE_COVERS, value={"lower": None, "upper": None})
