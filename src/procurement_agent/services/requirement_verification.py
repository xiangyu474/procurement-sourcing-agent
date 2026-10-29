"""Deterministic verification of the numbers and the quotes the compiler read.

The model reads the document and reports what it read. This module checks the
citations and the arithmetic against the source text, so a number the source
does not state cannot silently become a hard constraint.

Verification never deletes a requirement and never changes a quantity, a
price, or a budget. A check that cannot confirm a value marks that value
instead: the constraint becomes AMBIGUOUS, which keeps it out of the automatic
PASS/FAIL gate, and the reason is recorded with the compilation.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from procurement_agent.domain.requirements import (
    ParseStatus,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    SourceFragment,
    ValueType,
)
from procurement_agent.domain.units import unit_spec, unit_spellings

SCALE_WORDS: dict[str, Decimal] = {
    "万": Decimal(10_000),
    "亿": Decimal(100_000_000),
    "千": Decimal(1000),
}

_NUMBER = re.compile(r"(?<![\d.,])(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?")

_VERIFIED = "VERIFIED"
_UNVERIFIABLE = "UNVERIFIABLE"


@dataclass(frozen=True)
class NumberCheck:
    """The result of checking one number the model reported."""

    scope: str
    reference: str
    value: str
    status: str
    detail: str

    @property
    def verified(self) -> bool:
        return self.status == _VERIFIED


@dataclass(frozen=True)
class TotalCheck:
    """The result of recomputing a line-item total."""

    computed_sum: str
    unit: str | None
    stated_values: list[str] = field(default_factory=list)
    difference: str | None = None
    classification: str = "NO_TOTAL"
    detail: str = ""


@dataclass(frozen=True)
class VerificationResult:
    """Everything the verification found, and the compilation it produced."""

    compilation: RequirementCompilation
    number_checks: list[NumberCheck] = field(default_factory=list)
    total_checks: list[TotalCheck] = field(default_factory=list)

    @property
    def unverifiable(self) -> list[NumberCheck]:
        return [check for check in self.number_checks if not check.verified]


@dataclass(frozen=True)
class _QuotedNumber:
    """One number the source text states, with its scale word and unit."""

    value: Decimal
    scale: Decimal
    unit: str | None


def _decimal(text: str) -> Decimal | None:
    try:
        result = Decimal(text.replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() else None


def _detect_unit(text: str) -> tuple[str | None, str]:
    """Read the unit that follows a number, and the rest of the text."""
    tail = text.lstrip()
    for spelling, normalized in unit_spellings():
        if tail[: len(spelling)].casefold() == spelling.casefold():
            return normalized, tail[len(spelling):]
    return None, tail


def _quoted_numbers(text: str) -> list[_QuotedNumber]:
    """Read every number the text states, with the scale word and unit after it."""
    found: list[_QuotedNumber] = []
    for match in _NUMBER.finditer(text):
        sign, whole, fraction = match.groups()
        raw = f"{sign}{whole}" + (f".{fraction}" if fraction else "")
        value = _decimal(raw)
        if value is None:
            continue
        tail = text[match.end():]
        scale = Decimal(1)
        stripped = tail.lstrip()
        if stripped[:1] in SCALE_WORDS:
            scale = SCALE_WORDS[stripped[0]]
            tail = stripped[1:]
        unit, _rest = _detect_unit(tail)
        found.append(_QuotedNumber(value=value, scale=scale, unit=unit))
    return found


def _number_is_quoted(value: Decimal, unit: str | None, quote: str) -> bool:
    """Report whether the quote states the value on the unit the requirement states."""
    quoted = _quoted_numbers(quote)
    if not quoted:
        return False
    requirement_spec = unit_spec(unit)
    for item in quoted:
        if requirement_spec is None:
            if item.value * item.scale == value:
                return True
            continue
        if item.unit is None:
            continue
        quote_spec = unit_spec(item.unit)
        if quote_spec is None or quote_spec.dimension != requirement_spec.dimension:
            continue
        if item.value * item.scale * quote_spec.factor == value * requirement_spec.factor:
            return True
    return False


def _plain_number_is_quoted(value: Decimal, quote: str) -> bool:
    """Report whether the quote states the value, whatever scale word it carries."""
    return any(item.value == value for item in _quoted_numbers(quote))


def _normalize_text(value: str) -> str:
    return " ".join(value.split())


def _quote_is_grounded(quote: str | None, source_text: str | None) -> bool:
    """Report whether the quote appears in the cited fragment."""
    if not quote or not source_text:
        return False
    return _normalize_text(quote) in _normalize_text(source_text)


def _fragment_index(fragments: Sequence[SourceFragment]) -> dict[str, str]:
    return {fragment.locator: fragment.text for fragment in fragments}


def _constraint_values(constraint: RequirementConstraint) -> list[Decimal]:
    """Read the numbers a constraint claims."""
    if constraint.value_type == ValueType.NUMBER:
        value = _decimal(str(constraint.value))
        return [value] if value is not None else []
    if constraint.value_type == ValueType.RANGE and isinstance(constraint.value, dict):
        bounds = []
        for key in ("lower", "upper"):
            raw = constraint.value.get(key)
            if raw is None:
                continue
            value = _decimal(str(raw))
            if value is None:
                return []
            bounds.append(value)
        return bounds
    return []


def _verify_constraint(
    constraint: RequirementConstraint,
    quote: str | None,
    source_text: str | None,
) -> NumberCheck:
    """Check that the constraint's number and citation hold."""
    reference = constraint.constraint_id
    if not _constraint_values(constraint):
        # Boolean, string, and set values carry no number to recompute.
        return NumberCheck(
            scope="constraint",
            reference=reference,
            value=str(constraint.value),
            status=_VERIFIED,
            detail="The constraint carries no numeric value.",
        )
    if not _quote_is_grounded(quote, source_text):
        return NumberCheck(
            scope="constraint",
            reference=reference,
            value=str(constraint.value),
            status=_UNVERIFIABLE,
            detail="The quotation was not found in the cited fragment.",
        )
    for value in _constraint_values(constraint):
        if not _number_is_quoted(value, constraint.unit, quote or ""):
            return NumberCheck(
                scope="constraint",
                reference=reference,
                value=str(constraint.value),
                status=_UNVERIFIABLE,
                detail=f"The cited text does not state the value {value}.",
            )
    return NumberCheck(
        scope="constraint",
        reference=reference,
        value=str(constraint.value),
        status=_VERIFIED,
        detail="The cited text states the value.",
    )


def _verify_amount(
    label: str,
    value: str | None,
    quote: str | None,
    source_text: str | None,
) -> NumberCheck:
    """Check that an amount's number and citation hold."""
    if not value:
        return NumberCheck(scope="amount", reference=label, value="", status=_VERIFIED, detail="No amount was reported.")
    number = _decimal(value)
    if number is None:
        return NumberCheck(
            scope="amount",
            reference=label,
            value=value,
            status=_UNVERIFIABLE,
            detail="The amount is not a finite decimal.",
        )
    if not _quote_is_grounded(quote, source_text):
        return NumberCheck(
            scope="amount",
            reference=label,
            value=value,
            status=_UNVERIFIABLE,
            detail="The quotation was not found in the cited fragment.",
        )
    if not _plain_number_is_quoted(number, quote or ""):
        return NumberCheck(
            scope="amount",
            reference=label,
            value=value,
            status=_UNVERIFIABLE,
            detail=f"The cited text does not state the amount {value}.",
        )
    return NumberCheck(
        scope="amount",
        reference=label,
        value=value,
        status=_VERIFIED,
        detail="The cited text states the amount.",
    )


def _verify_quantity(requirement: Requirement, cited_text: str) -> NumberCheck:
    """Check that the quantity appears in the fragments the requirement cites."""
    reference = requirement.requirement_id
    if not requirement.quantity:
        return NumberCheck(scope="quantity", reference=reference, value="", status=_VERIFIED, detail="No quantity was reported.")
    number = _decimal(requirement.quantity)
    if number is None:
        return NumberCheck(
            scope="quantity",
            reference=reference,
            value=requirement.quantity,
            status=_UNVERIFIABLE,
            detail="The quantity is not a finite decimal.",
        )
    if _plain_number_is_quoted(number, cited_text):
        return NumberCheck(
            scope="quantity",
            reference=reference,
            value=requirement.quantity,
            status=_VERIFIED,
            detail="The cited fragments state the quantity.",
        )
    return NumberCheck(
        scope="quantity",
        reference=reference,
        value=requirement.quantity,
        status=_UNVERIFIABLE,
        detail=f"The cited fragments do not state the quantity {requirement.quantity}.",
    )


def _budget_sum(compilation: RequirementCompilation) -> tuple[Decimal, str | None, int]:
    """Add up the line-item budgets, when they share one unit."""
    total = Decimal(0)
    unit: str | None = None
    rows = 0
    for requirement in compilation.requirements:
        budget = requirement.planned_total_budget
        if budget is None:
            continue
        value = _decimal(budget.value)
        if value is None:
            continue
        if unit is None:
            unit = budget.unit
        elif budget.unit != unit:
            return Decimal(0), None, 0
        total += value
        rows += 1
    return total, unit, rows


_AMOUNT_TOTAL = re.compile(r"(-?\d[\d,]*(?:\.\d+)?)\s*(?:万\s*)?元")


def _stated_totals(compilation: RequirementCompilation) -> list[Decimal]:
    """Read the totals the model reported as a conflict.

    A total is a number the document states with a currency. The numbers the
    model lists inside its explanation, such as the row budgets it added up,
    are not totals and are left out.
    """
    stated: list[Decimal] = []
    for conflict in compilation.conflicts:
        for value in conflict.values_with_source:
            totals = [Decimal(item.replace(",", "")) for item in _AMOUNT_TOTAL.findall(value.value)]
            if totals:
                stated.extend(totals)
                continue
            # Without a currency, the first number of the statement is the total.
            first = _quoted_numbers(value.value)
            if first:
                stated.append(first[0].value)
    return stated


def _rounding_tolerance(rows: int, compilation: RequirementCompilation) -> Decimal:
    """The largest gap the row budgets could explain by being rounded.

    Each row budget is rounded to the precision the document uses, and the
    project total is rounded once more, so the two can differ by that much
    without either being wrong.
    """
    decimals = 0
    for requirement in compilation.requirements:
        budget = requirement.planned_total_budget
        if budget is None:
            continue
        text = budget.value
        if "." in text:
            decimals = max(decimals, len(text.split(".", 1)[1]))
    return Decimal(rows + 1) * Decimal(1).scaleb(-decimals) / 2


def verify_project_total(compilation: RequirementCompilation) -> TotalCheck:
    """Recompute the line-item total and classify the difference.

    The classification separates three causes: our own arithmetic is wrong,
    the gap is the rounding of the row budgets, or the source states two
    different totals.
    """
    computed, unit, rows = _budget_sum(compilation)
    if rows == 0:
        return TotalCheck(computed_sum="0", unit=None, classification="NO_TOTAL", detail="No line item states a budget.")
    stated = _stated_totals(compilation)
    if not stated:
        return TotalCheck(
            computed_sum=str(computed),
            unit=unit,
            classification="NO_STATED_TOTAL",
            detail="The document states no project total to compare with.",
        )
    if computed in stated:
        tolerance = _rounding_tolerance(rows, compilation)
        spread = max(stated) - min(stated)
        if spread == 0:
            classification = "EXACT"
            detail = "The recomputed total equals the total the document states."
        elif spread <= tolerance:
            classification = "ROUNDING"
            detail = (
                f"The document states {min(stated)} and {max(stated)}. The gap of {spread} is within "
                f"the {tolerance} that {rows} rounded row budgets can explain."
            )
        else:
            classification = "SOURCE_DIFFERENCE"
            detail = (
                f"The document states {min(stated)} and {max(stated)}. The gap of {spread} is larger than "
                f"the {tolerance} that {rows} rounded row budgets can explain."
            )
        return TotalCheck(
            computed_sum=str(computed),
            unit=unit,
            stated_values=[str(value) for value in stated],
            difference=str(spread),
            classification=classification,
            detail=detail,
        )
    return TotalCheck(
        computed_sum=str(computed),
        unit=unit,
        stated_values=[str(value) for value in stated],
        difference=str(max(stated) - computed),
        classification="ARITHMETIC_MISMATCH",
        detail=(
            f"The recomputed sum of the line items is {computed}, and the document states "
            f"{', '.join(str(value) for value in stated)}. The arithmetic needs review."
        ),
    )


def apply_source_verification(
    compilation: RequirementCompilation,
    fragments: Sequence[SourceFragment],
) -> VerificationResult:
    """Check the compiled numbers against the source and mark what fails.

    The returned compilation is a copy. A constraint whose value or citation
    cannot be confirmed becomes AMBIGUOUS, so it stays out of the automatic
    PASS/FAIL gate, and every finding is recorded in the compilation issues.
    """
    index = _fragment_index(fragments)
    verified = compilation.model_copy(deep=True)
    checks: list[NumberCheck] = []
    issues: list[str] = []

    for requirement in verified.requirements:
        cited = set(requirement.source_refs)
        for constraint in requirement.constraints:
            cited.add(constraint.source_ref or "")
        for amount in (
            requirement.planned_unit_price,
            requirement.planned_sales_unit_price,
            requirement.planned_total_budget,
        ):
            if amount is not None:
                cited.add(amount.source_ref or "")
        cited_text = " ".join(index.get(ref, "") for ref in sorted(cited) if ref)
        quantity_check = _verify_quantity(requirement, cited_text)
        checks.append(quantity_check)
        if not quantity_check.verified:
            issues.append(
                f"The quantity of {requirement.requirement_id} could not be confirmed: {quantity_check.detail}"
            )
            question = f"The quantity {requirement.quantity} is not confirmed by the cited text."
            if question not in requirement.open_questions:
                requirement.open_questions.append(question)

        for constraint in requirement.constraints:
            source_text = index.get(constraint.source_ref or "")
            check = _verify_constraint(constraint, constraint.source_quote, source_text)
            checks.append(check)
            if not check.verified and constraint.parse_status == ParseStatus.RESOLVED:
                constraint.parse_status = ParseStatus.AMBIGUOUS
                constraint.validation_issues.append(check.detail)
                issues.append(
                    f"Constraint {constraint.constraint_id} of {requirement.requirement_id} was marked "
                    f"AMBIGUOUS: {check.detail}"
                )

        for label, amount in (
            ("planned_unit_price", requirement.planned_unit_price),
            ("planned_sales_unit_price", requirement.planned_sales_unit_price),
            ("planned_total_budget", requirement.planned_total_budget),
        ):
            if amount is None:
                continue
            check = _verify_amount(
                label,
                amount.value,
                amount.source_quote,
                index.get(amount.source_ref or ""),
            )
            checks.append(check)
            if not check.verified:
                issues.append(
                    f"The {label} of {requirement.requirement_id} could not be confirmed: {check.detail}"
                )
                question = f"The {label} {amount.value} is not confirmed by the cited text."
                if question not in requirement.open_questions:
                    requirement.open_questions.append(question)

    total = verify_project_total(verified)
    if total.classification not in {"NO_TOTAL", "EXACT", "NO_STATED_TOTAL"}:
        issues.append(f"Project total check: {total.classification}. {total.detail}")

    verified.issues = list(verified.issues) + issues
    return VerificationResult(compilation=verified, number_checks=checks, total_checks=[total])
