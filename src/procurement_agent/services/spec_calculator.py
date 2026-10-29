"""M3-A constraint calculator.

Pure functions. This module does not reach the network, does not call a model,
does not write anything, and does not change its inputs. A check either
compares two values that are on one scale, or it returns UNKNOWN and names
what is missing.

The admission order follows the calculator specification: the requirement must
be parsed, the product must be a concrete model, the claim must carry evidence,
the attributes must be aligned, the units must convert, and only then is the
comparison executed.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC
from decimal import Decimal, InvalidOperation
from typing import Any

from procurement_agent.domain.requirements import (
    ConstraintOperator,
    Importance,
    ParseStatus,
    Requirement,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.domain.sourcing import ClaimStatus
from procurement_agent.domain.spec_alignment import (
    AlignmentStatus,
    ConstraintCheck,
    ConstraintReasonCode,
    ConstraintStatus,
    ProductAttributeClaim,
    SemanticAlignment,
    SpecAssessment,
)
from procurement_agent.domain.units import convert_between, normalize_unit

CALCULATOR_VERSION = "0.1.0"
DSL_SCHEMA_VERSION = "1.0"


@dataclass(frozen=True)
class _Numbers:
    """Two magnitudes brought onto the scale the requirement states."""

    actual: Decimal
    required: Decimal
    unit: str | None
    display_unit: str | None


def _decimal(value: Any, label: str) -> Decimal | None:
    """Read a decimal from the DSL's canonical string form."""
    if isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if not isinstance(value, str):
        return None
    try:
        result = Decimal(value.strip())
    except (InvalidOperation, ValueError):
        return None
    if not result.is_finite():
        return None
    return result


def _collapse(text: str) -> str:
    """Collapse case and spacing so a token comparison is about the token."""
    return " ".join(text.split()).casefold()


def _unknown(
    constraint: RequirementConstraint,
    reason: ConstraintReasonCode,
    explanation: str,
    *,
    claims: Sequence[ProductAttributeClaim] = (),
    status: ConstraintStatus = ConstraintStatus.UNKNOWN,
    operation: str | None = None,
    normalized_actual: str | None = None,
    normalized_required: str | None = None,
    unit: str | None = None,
) -> ConstraintCheck:
    """Build a check that did not reach a comparison."""
    return ConstraintCheck(
        constraint_id=constraint.constraint_id,
        requirement_id=constraint.requirement_id,
        claim_ids=[claim.claim_id for claim in claims],
        status=status,
        reason_code=reason,
        operation=operation,
        normalized_actual=normalized_actual,
        normalized_required=normalized_required,
        unit=unit,
        evidence_ids=sorted({evidence for claim in claims for evidence in claim.evidence_ids}),
        source_refs=[constraint.source_ref] if constraint.source_ref else [],
        explanation=explanation,
        importance=constraint.importance.value,
    )


def _selected_claims(
    alignment: SemanticAlignment,
    claims: Sequence[ProductAttributeClaim],
    product_model_ref: str | None,
) -> list[ProductAttributeClaim]:
    """Keep the claims the alignment named, restricted to the assessed model."""
    chosen = [claim for claim in claims if claim.claim_id in set(alignment.claim_ids)]
    if product_model_ref is None:
        return chosen
    return [claim for claim in chosen if claim.product_model_ref == product_model_ref]


def _qualifiers_compatible(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[bool, str]:
    """Check that the claim states the context the constraint asks about."""
    for key, value in constraint.qualifiers.items():
        if key not in claim.qualifiers:
            return False, f"the requirement asks for {key}={value}, and the claim does not state it"
        if _collapse(str(claim.qualifiers[key])) != _collapse(str(value)):
            return False, f"the requirement asks for {key}={value}, and the claim states {claim.qualifiers[key]}"
    return True, ""


def _numbers(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[_Numbers | None, str]:
    """Bring the claim and the requirement onto one scale."""
    required = _decimal(constraint.value, "requirement")
    actual = _decimal(claim.value, "claim")
    if required is None or actual is None:
        return None, "one of the two values is not a finite decimal"
    required_unit = normalize_unit(constraint.unit)
    actual_unit = normalize_unit(claim.unit)
    if required_unit is None and actual_unit is None:
        return _Numbers(actual=actual, required=required, unit=None, display_unit=None), ""
    if required_unit is None or actual_unit is None:
        return None, "one side states a unit and the other does not"
    if required_unit == actual_unit:
        return _Numbers(actual=actual, required=required, unit=required_unit, display_unit=constraint.unit), ""
    converted_actual = convert_between(actual, actual_unit, required_unit)
    if converted_actual is None:
        return None, f"{actual_unit} and {required_unit} are not the same measurement"
    return (
        _Numbers(
            actual=converted_actual,
            required=required,
            unit=required_unit,
            display_unit=constraint.unit,
        ),
        "",
    )


def _format_number(value: Decimal) -> str:
    """Render a decimal without an exponent and without trailing zeros."""
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _compare_number(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[ConstraintStatus | None, str, str, str | None, str | None, str]:
    """Compare a numeric constraint."""
    numbers, problem = _numbers(constraint, claim)
    if numbers is None:
        return None, "", "", None, None, problem
    actual = numbers.actual
    required = numbers.required
    operator = constraint.operator
    if operator == ConstraintOperator.GTE:
        satisfied = actual >= required
    elif operator == ConstraintOperator.LTE:
        satisfied = actual <= required
    elif operator == ConstraintOperator.EQ:
        satisfied = actual == required
    elif operator == ConstraintOperator.NE:
        satisfied = actual != required
    else:
        return None, "", "", None, None, f"{operator.value} is not a numeric operator"
    unit = numbers.display_unit
    operation = f"{_format_number(actual)}{(' ' + unit) if unit else ''} {operator.value} {_format_number(required)}{(' ' + unit) if unit else ''}"
    status = ConstraintStatus.PASS if satisfied else ConstraintStatus.FAIL
    return status, operation, unit, _format_number(actual), _format_number(required), ""


def _compare_boolean(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[ConstraintStatus | None, str, str, str | None, str | None, str]:
    """Compare a boolean constraint."""
    required = constraint.value
    actual = claim.value
    if not isinstance(required, bool):
        return None, "", "", None, None, "the requirement value is not a boolean"
    if isinstance(actual, str):
        folded = _collapse(actual)
        if folded in {"true", "yes"}:
            actual = True
        elif folded in {"false", "no"}:
            actual = False
    if not isinstance(actual, bool):
        return None, "", "", None, None, "the claim value is not a boolean"
    if constraint.operator == ConstraintOperator.EQ:
        satisfied = actual == required
    elif constraint.operator == ConstraintOperator.NE:
        satisfied = actual != required
    else:
        return None, "", "", None, None, f"{constraint.operator.value} is not a boolean operator"
    operation = f"{str(actual).lower()} {constraint.operator.value} {str(required).lower()}"
    status = ConstraintStatus.PASS if satisfied else ConstraintStatus.FAIL
    return status, operation, None, str(actual).lower(), str(required).lower(), ""


def _compare_string(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[ConstraintStatus | None, str, str, str | None, str | None, str]:
    """Compare a string constraint."""
    actual = claim.value
    if not isinstance(actual, str):
        return None, "", "", None, None, "the claim value is not text"
    if constraint.operator == ConstraintOperator.IN:
        allowed = constraint.value if isinstance(constraint.value, list) else [constraint.value]
        if not isinstance(allowed, list):
            return None, "", "", None, None, "the requirement does not list the allowed values"
        satisfied = any(_collapse(actual) == _collapse(str(item)) for item in allowed)
        operation = f"{actual} IN {allowed}"
        status = ConstraintStatus.PASS if satisfied else ConstraintStatus.FAIL
        return status, operation, None, actual, ", ".join(str(item) for item in allowed), ""
    required = constraint.value
    if not isinstance(required, str):
        return None, "", "", None, None, "the requirement value is not text"
    if constraint.operator == ConstraintOperator.EQ:
        satisfied = _collapse(actual) == _collapse(required)
        operation = f"{actual} {constraint.operator.value} {required}"
    elif constraint.operator == ConstraintOperator.NE:
        satisfied = _collapse(actual) != _collapse(required)
        operation = f"{actual} {constraint.operator.value} {required}"
    else:
        return None, "", "", None, None, f"{constraint.operator.value} is not a string operator"
    status = ConstraintStatus.PASS if satisfied else ConstraintStatus.FAIL
    return status, operation, None, actual, str(required), ""


def _as_token_set(value: Any) -> list[str] | None:
    """Read a set of tokens, refusing a bare string."""
    if isinstance(value, str):
        return None
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    return None


def _compare_set(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[ConstraintStatus | None, str, str, str | None, str | None, str]:
    """Compare a set constraint."""
    required = _as_token_set(constraint.value)
    actual = _as_token_set(claim.value)
    if required is None:
        return None, "", "", None, None, "the requirement value is not a list of tokens"
    if actual is None:
        return None, "", "", None, None, "the claim value is not a list of tokens"
    if constraint.operator == ConstraintOperator.CONTAINS:
        missing = [token for token in required if _collapse(token) not in {_collapse(item) for item in actual}]
        satisfied = not missing
        operation = f"{actual} CONTAINS {required}"
    elif constraint.operator == ConstraintOperator.IN:
        satisfied = any(_collapse(item) in {_collapse(token) for token in required} for item in actual)
        operation = f"{actual} IN {required}"
    else:
        return None, "", "", None, None, f"{constraint.operator.value} is not a set operator"
    status = ConstraintStatus.PASS if satisfied else ConstraintStatus.FAIL
    return status, operation, None, ", ".join(actual), ", ".join(required), ""


def _range_bounds(value: Any) -> tuple[Decimal | None, bool, Decimal | None, bool] | None:
    """Read a DSL range."""
    if not isinstance(value, dict):
        return None
    lower = _decimal(value.get("lower"), "range lower")
    upper = _decimal(value.get("upper"), "range upper")
    if lower is None and upper is None:
        return None
    lower_inclusive = bool(value.get("lower_inclusive", True))
    upper_inclusive = bool(value.get("upper_inclusive", True))
    return lower, lower_inclusive, upper, upper_inclusive


def _covers(
    actual: tuple[Decimal | None, bool, Decimal | None, bool],
    required: tuple[Decimal | None, bool, Decimal | None, bool],
) -> bool:
    """Report whether the actual range holds every value the required range holds."""
    actual_lower, actual_lower_inclusive, actual_upper, actual_upper_inclusive = actual
    required_lower, required_lower_inclusive, required_upper, required_upper_inclusive = required
    if required_lower is not None:
        if actual_lower is None:
            return False
        if actual_lower > required_lower:
            return False
        if actual_lower == required_lower and required_lower_inclusive and not actual_lower_inclusive:
            return False
    if required_upper is not None:
        if actual_upper is None:
            return False
        if actual_upper < required_upper:
            return False
        if actual_upper == required_upper and required_upper_inclusive and not actual_upper_inclusive:
            return False
    return True


def _compare_range(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[ConstraintStatus | None, str, str, str | None, str | None, str]:
    """Compare a range constraint."""
    required = _range_bounds(constraint.value)
    actual = _range_bounds(claim.value)
    if required is None:
        return None, "", "", None, None, "the requirement value is not a range"
    if actual is None:
        return None, "", "", None, None, "the claim value is not a range"
    required_unit = normalize_unit(constraint.unit)
    actual_unit = normalize_unit(claim.unit)
    if required_unit is None and actual_unit is None:
        unit = None
    elif required_unit == actual_unit:
        unit = required_unit
    else:
        return None, "", "", None, None, "the two ranges do not state the same unit"
    operation = f"[{_format_number(actual[0]) if actual[0] is not None else '-'}, {_format_number(actual[2]) if actual[2] is not None else '-'}] RANGE_COVERS [{_format_number(required[0]) if required[0] is not None else '-'}, {_format_number(required[2]) if required[2] is not None else '-'}]"
    satisfied = _covers(actual, required)
    status = ConstraintStatus.PASS if satisfied else ConstraintStatus.FAIL
    return status, operation, unit, operation.split(" RANGE")[0], None, ""


def _compare(
    constraint: RequirementConstraint,
    claim: ProductAttributeClaim,
) -> tuple[ConstraintStatus | None, str, str, str | None, str | None, str]:
    """Dispatch the comparison on the value type of the requirement."""
    if constraint.value_type == ValueType.NUMBER:
        return _compare_number(constraint, claim)
    if constraint.value_type == ValueType.BOOLEAN:
        return _compare_boolean(constraint, claim)
    if constraint.value_type == ValueType.STRING:
        return _compare_string(constraint, claim)
    if constraint.value_type == ValueType.SET:
        return _compare_set(constraint, claim)
    if constraint.value_type == ValueType.RANGE:
        return _compare_range(constraint, claim)
    return None, "", "", None, None, f"{constraint.value_type.value} cannot be compared automatically"


def evaluate_constraint(
    constraint: RequirementConstraint,
    claims: Sequence[ProductAttributeClaim],
    alignment: SemanticAlignment | None,
    *,
    product_model_ref: str | None,
) -> ConstraintCheck:
    """Evaluate one requirement constraint against one product model.

    The function returns PASS or FAIL only when the comparison is meaningful:
    the requirement is parsed, the product is a concrete model, the claim is
    supported by a source, the attributes are aligned, and the units convert.
    Everything else is UNKNOWN with a reason code.
    """
    if constraint.parse_status != ParseStatus.RESOLVED:
        return _unknown(
            constraint,
            ConstraintReasonCode.AMBIGUOUS_REQUIREMENT,
            f"the requirement constraint is {constraint.parse_status.value}, so it cannot be checked automatically",
        )
    if product_model_ref is None:
        return _unknown(
            constraint,
            ConstraintReasonCode.MODEL_VARIANT_UNCERTAIN,
            "the product has no exact model code, so a model-level check is not possible",
        )
    if alignment is None:
        return _unknown(
            constraint,
            ConstraintReasonCode.MISSING_CLAIM,
            "no alignment links this constraint to a product claim",
        )
    if alignment.status == AlignmentStatus.CONFLICTING:
        return _unknown(
            constraint,
            ConstraintReasonCode.CONFLICTING_CLAIMS,
            f"the sources disagree about this attribute: {alignment.reason}",
        )
    if alignment.status != AlignmentStatus.ALIGNED:
        return _unknown(
            constraint,
            ConstraintReasonCode.ATTRIBUTE_NOT_ALIGNED,
            f"the requirement attribute and the product attribute are not the same measurement: {alignment.reason}",
        )

    selected = _selected_claims(alignment, claims, product_model_ref)
    if not selected:
        return _unknown(
            constraint,
            ConstraintReasonCode.MISSING_CLAIM,
            "the aligned claim is not present for this product model",
        )
    unsupported = [claim for claim in selected if claim.claim_status != ClaimStatus.SUPPORTED_BY_SOURCE]
    if unsupported:
        return _unknown(
            constraint,
            ConstraintReasonCode.UNVERIFIED_CLAIM,
            "the product claim is not supported by a source",
            claims=selected,
        )
    incomplete = [claim for claim in selected if claim.extraction_status != ParseStatus.RESOLVED]
    if incomplete:
        return _unknown(
            constraint,
            ConstraintReasonCode.INCOMPLETE_SOURCE,
            "the product claim could not be read as a single value",
            claims=selected,
        )

    distinct: dict[str, str] = {}
    for claim in selected:
        key = f"{claim.attribute_key}|{normalize_unit(claim.unit) or ''}"
        rendered = str(claim.value)
        if key in distinct and _collapse(distinct[key]) != _collapse(rendered):
            return _unknown(
                constraint,
                ConstraintReasonCode.CONFLICTING_CLAIMS,
                f"the sources state different values for {claim.attribute_key}: {distinct[key]} and {rendered}",
                claims=selected,
            )
        distinct[key] = rendered

    for claim in selected:
        compatible, problem = _qualifiers_compatible(constraint, claim)
        if not compatible:
            return _unknown(
                constraint,
                ConstraintReasonCode.CONDITIONAL_MISMATCH,
                problem,
                claims=selected,
            )

    status, operation, unit, normalized_actual, normalized_required, problem = _compare(constraint, selected[0])
    if status is None:
        reason = (
            ConstraintReasonCode.UNIT_NOT_CONVERTIBLE
            if "not the same measurement" in problem or "states a unit" in problem
            else ConstraintReasonCode.UNSUPPORTED_FOR_AUTO_CHECK
        )
        return _unknown(constraint, reason, problem, claims=selected)
    return ConstraintCheck(
        constraint_id=constraint.constraint_id,
        requirement_id=constraint.requirement_id,
        claim_ids=[claim.claim_id for claim in selected],
        status=status,
        reason_code=ConstraintReasonCode.VERIFIED_COMPARISON,
        operation=operation,
        normalized_actual=normalized_actual,
        normalized_required=normalized_required,
        unit=unit,
        evidence_ids=sorted({evidence for claim in selected for evidence in claim.evidence_ids}),
        source_refs=[constraint.source_ref] if constraint.source_ref else [],
        explanation=(
            f"{constraint.attribute_key} is {normalized_actual}{(' ' + unit) if unit else ''} "
            f"and the requirement asks {constraint.operator.value} {normalized_required}"
            f"{(' ' + unit) if unit else ''}: {status.value}"
        ),
        importance=constraint.importance.value,
    )


def aggregate_hard_checks(
    checks: Sequence[ConstraintCheck],
    *,
    unresolved_demand: Sequence[str] = (),
) -> tuple[ConstraintStatus, list[ConstraintReasonCode]]:
    """Combine the HARD checks into one overall status.

    One reliable HARD failure is enough for FAIL. PASS needs every HARD check
    to pass and no unresolved demand, because a demand that could not be
    compiled into a constraint may still be a hard requirement.
    """
    hard = [check for check in checks if check.importance == Importance.HARD.value]
    if not hard:
        return ConstraintStatus.UNKNOWN, [ConstraintReasonCode.NO_HARD_CONSTRAINT]
    failures = [check for check in hard if check.status == ConstraintStatus.FAIL]
    if failures:
        return ConstraintStatus.FAIL, [check.reason_code for check in failures]
    if any(check.status != ConstraintStatus.PASS for check in hard):
        reasons = [check.reason_code for check in hard if check.status != ConstraintStatus.PASS]
        return ConstraintStatus.UNKNOWN, list(dict.fromkeys(reasons))
    if unresolved_demand:
        return ConstraintStatus.UNKNOWN, [ConstraintReasonCode.UNRESOLVED_DEMAND]
    return ConstraintStatus.PASS, [ConstraintReasonCode.VERIFIED_COMPARISON]


def evaluate_requirement_product(
    requirement: Requirement,
    product_candidate_id: str,
    product_model_ref: str | None,
    claims: Sequence[ProductAttributeClaim],
    alignments: Sequence[SemanticAlignment],
    *,
    unresolved_demand: Sequence[str] = (),
    evaluated_at: Any = None,
) -> SpecAssessment:
    """Evaluate every constraint of one requirement against one product model."""
    from datetime import datetime

    moment = evaluated_at or datetime.now(UTC)
    by_constraint = {alignment.constraint_id: alignment for alignment in alignments}
    checks = [
        evaluate_constraint(
            constraint,
            claims,
            by_constraint.get(constraint.constraint_id),
            product_model_ref=product_model_ref,
        )
        for constraint in requirement.constraints
    ]
    overall, reasons = aggregate_hard_checks(checks, unresolved_demand=unresolved_demand)
    return SpecAssessment(
        requirement_id=requirement.requirement_id,
        product_candidate_id=product_candidate_id,
        product_model_ref=product_model_ref,
        calculator_version=CALCULATOR_VERSION,
        dsl_schema_version=DSL_SCHEMA_VERSION,
        checks=checks,
        hard_spec_overall=overall,
        overall_reason_codes=list(dict.fromkeys(reasons)),
        hard_constraint_count=len([check for check in checks if check.importance == Importance.HARD.value]),
        unresolved_question_ids=[],
        evaluated_at=moment,
    )
