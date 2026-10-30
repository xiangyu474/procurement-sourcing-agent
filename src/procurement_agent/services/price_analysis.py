"""M3-B price comparability and the price analysis of one requirement.

Two prices compare only when they are the same kind of number, in the same
currency, with the same tax basis, and per the same unit. When they do not,
the outcome says why, and no lowest price and no saving are produced.

The rule that matters for a buyer: a public listing is not a quotation, and a
budget is not a transaction. Mixing them would produce a saving that nobody
signed for.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from procurement_agent.domain.pricing import (
    ComparabilityReason,
    ComparabilityStatus,
    PriceBasis,
    PriceComparison,
    PriceFinding,
    PriceObservation,
    read_decimal,
)
from procurement_agent.domain.requirements import TaxBasis

# The pairs of bases that answer a question a buyer asks.
#
# - Two prices of one kind compare with each other, so a lowest price exists.
# - A formal quotation compares with the budget, which is the saving.
# - A formal quotation compares with the historical transaction, which is the
#   offer against the past.
# - A historical transaction compares with the budget, which is the budget
#   against the past.
#
# A public listing compares with nothing but another public listing. It is a
# price somebody posted, not an offer, so it never produces a saving.
_COMPARABLE_PAIRS: frozenset[tuple[PriceBasis, PriceBasis]] = frozenset(
    {
        (PriceBasis.HISTORICAL_TRANSACTION, PriceBasis.HISTORICAL_TRANSACTION),
        (PriceBasis.FORMAL_QUOTATION, PriceBasis.FORMAL_QUOTATION),
        (PriceBasis.PUBLIC_REFERENCE, PriceBasis.PUBLIC_REFERENCE),
        (PriceBasis.PLANNED_BUDGET, PriceBasis.PLANNED_BUDGET),
        (PriceBasis.FORMAL_QUOTATION, PriceBasis.PLANNED_BUDGET),
        (PriceBasis.FORMAL_QUOTATION, PriceBasis.HISTORICAL_TRANSACTION),
        (PriceBasis.HISTORICAL_TRANSACTION, PriceBasis.PLANNED_BUDGET),
    }
)


def _format(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _normalize_unit(unit: str | None) -> str | None:
    if unit is None:
        return None
    key = unit.strip().casefold().replace(" ", "")
    return key or None


def compare_prices(left: PriceObservation, right: PriceObservation) -> PriceComparison:
    """Compare two prices and say whether the comparison is meaningful."""
    reasons: list[ComparabilityReason] = []
    pair = (left.price_basis, right.price_basis)
    if pair not in _COMPARABLE_PAIRS and (pair[1], pair[0]) not in _COMPARABLE_PAIRS:
        reasons.append(ComparabilityReason.DIFFERENT_BASIS)
    if not left.currency or not right.currency:
        reasons.append(ComparabilityReason.UNKNOWN_CURRENCY)
    elif left.currency.strip().upper() != right.currency.strip().upper():
        reasons.append(ComparabilityReason.CURRENCY_MISMATCH)
    if left.tax_basis == TaxBasis.UNKNOWN or right.tax_basis == TaxBasis.UNKNOWN:
        reasons.append(ComparabilityReason.UNKNOWN_TAX_BASIS)
    elif left.tax_basis != right.tax_basis:
        reasons.append(ComparabilityReason.TAX_BASIS_MISMATCH)
    left_unit = _normalize_unit(left.unit)
    right_unit = _normalize_unit(right.unit)
    if not left_unit or not right_unit:
        reasons.append(ComparabilityReason.UNKNOWN_UNIT)
    elif left_unit != right_unit:
        reasons.append(ComparabilityReason.UNIT_MISMATCH)

    if reasons:
        return PriceComparison(
            status=ComparabilityStatus.NOT_COMPARABLE,
            reasons=reasons,
            explanation=(
                f"The two prices cannot be compared: {', '.join(reason.value for reason in reasons)}."
            ),
        )
    left_value = read_decimal(left.value)
    right_value = read_decimal(right.value)
    if left_value is None or right_value is None:
        return PriceComparison(
            status=ComparabilityStatus.NOT_COMPARABLE,
            reasons=[ComparabilityReason.DIFFERENT_BASIS],
            explanation="One of the two prices is not a finite decimal.",
        )
    difference = left_value - right_value
    percent: Decimal | None = None
    if right_value != 0:
        percent = (difference / right_value) * Decimal(100)
    return PriceComparison(
        status=ComparabilityStatus.COMPARABLE,
        reasons=[ComparabilityReason.SAME_BASIS],
        difference=_format(difference),
        difference_percent=_format(percent) if percent is not None else None,
        explanation=(
            f"Both prices are {left.price_basis.value} in {left.currency} per {left_unit}, "
            f"tax basis {left.tax_basis.value}."
        ),
    )


def comparable_group(
    observations: Sequence[PriceObservation],
) -> tuple[list[PriceObservation], list[str]]:
    """Return the series when every observation agrees on its basis.

    A set that mixes bases has no meaningful cheapest member, so the whole set
    is returned as excluded and nothing is compared.
    """
    groups: dict[tuple[str, str, str, str], list[PriceObservation]] = {}
    for observation in observations:
        key = (
            observation.price_basis.value,
            observation.tax_basis.value,
            (observation.currency or "").strip().upper(),
            _normalize_unit(observation.unit) or "",
        )
        groups.setdefault(key, []).append(observation)
    if not groups:
        return [], []
    if len(groups) > 1:
        return [], [observation.observation_id for observation in observations]
    series = next(iter(groups.values()))
    return series, []


def analyze_prices(
    *,
    requirement_id: str | None = None,
    equivalence_key: str | None = None,
    observations: Sequence[PriceObservation],
    budget: PriceObservation | None = None,
) -> PriceFinding:
    """Analyse the prices of one requirement.

    A lowest price appears only when the observations agree on their basis. A
    saving appears only when that price and the budget are comparable.
    """
    series, excluded = comparable_group(observations)
    if not series:
        return PriceFinding(
            requirement_id=requirement_id,
            equivalence_key=equivalence_key,
            comparability=ComparabilityStatus.NOT_COMPARABLE,
            reasons=[ComparabilityReason.DIFFERENT_BASIS],
            excluded_observation_ids=[item.observation_id for item in observations],
            explanation="There is no price to compare, so no lowest price and no saving are reported.",
        )
    if excluded:
        # The set holds prices of different kinds. The cheapest of them is not
        # a price a buyer can act on, so no lowest price and no saving are
        # reported; the excluded prices are named instead.
        return PriceFinding(
            requirement_id=requirement_id,
            equivalence_key=equivalence_key,
            comparability=ComparabilityStatus.NOT_COMPARABLE,
            reasons=[ComparabilityReason.DIFFERENT_BASIS],
            excluded_observation_ids=excluded,
            explanation=(
                f"The {len(observations)} prices are not all on the same basis, so no lowest price "
                "and no saving are reported."
            ),
        )
    lowest = min(series, key=lambda item: read_decimal(item.value) or Decimal(0))
    reasons = [ComparabilityReason.SAME_BASIS]
    saving: str | None = None
    saving_percent: str | None = None
    if budget is not None:
        comparison = compare_prices(budget, lowest)
        if comparison.status == ComparabilityStatus.COMPARABLE:
            budget_value = read_decimal(budget.value) or Decimal(0)
            lowest_value = read_decimal(lowest.value) or Decimal(0)
            difference = budget_value - lowest_value
            saving = _format(difference)
            if budget_value != 0:
                saving_percent = _format((difference / budget_value) * Decimal(100))
        else:
            reasons.extend(comparison.reasons)
    explanation = (
        f"{len(series)} prices share the basis {lowest.price_basis.value}; the lowest is "
        f"{lowest.value} {lowest.currency or ''} per {_normalize_unit(lowest.unit) or 'unit'}."
    )
    if budget is not None and saving is None:
        explanation += " The budget is not on the same basis, so no saving is reported."
    elif saving is not None:
        explanation += f" The saving against the budget is {saving} ({saving_percent} percent)."
    return PriceFinding(
        requirement_id=requirement_id,
        equivalence_key=equivalence_key,
        comparability=ComparabilityStatus.COMPARABLE,
        reasons=list(dict.fromkeys(reasons)),
        lowest_observation_id=lowest.observation_id,
        lowest_value=lowest.value,
        lowest_basis=lowest.price_basis,
        budget_value=budget.value if budget is not None else None,
        saving=saving,
        saving_percent=saving_percent,
        excluded_observation_ids=excluded,
        explanation=explanation,
    )


def analyze_price_series(
    *,
    requirement_id: str | None = None,
    equivalence_key: str | None = None,
    observations: Sequence[PriceObservation],
    budget: PriceObservation | None = None,
) -> list[PriceFinding]:
    """One finding per kind of price, so a mixed set still yields what it can.

    A historical transaction, a public listing, and a formal quotation are
    three different kinds of number. Each is analysed on its own, and the
    caller sees which kind produced which lowest price.
    """
    groups: dict[tuple[str, str, str, str], list[PriceObservation]] = {}
    for observation in observations:
        key = (
            observation.price_basis.value,
            observation.tax_basis.value,
            (observation.currency or "").strip().upper(),
            _normalize_unit(observation.unit) or "",
        )
        groups.setdefault(key, []).append(observation)
    findings = [
        analyze_prices(
            requirement_id=requirement_id,
            equivalence_key=equivalence_key,
            observations=members,
            budget=budget,
        )
        for members in groups.values()
    ]
    findings.sort(key=lambda item: (item.lowest_basis.value if item.lowest_basis else "", item.lowest_value or ""))
    return findings
