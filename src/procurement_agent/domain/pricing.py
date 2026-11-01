"""M3-B price contracts: what a price number is, and when two of them compare.

A price without its basis is not a price. The same number can be a budget, a
historical transaction, a public listing, or a supplier's formal quotation,
and only two prices of the same basis can be compared. When the basis does
not line up, the outcome is "not comparable" and no lowest price and no
saving are reported.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator

from procurement_agent.domain.requirements import TaxBasis


class PriceBasis(StrEnum):
    """What kind of number a price is."""

    PLANNED_BUDGET = "PLANNED_BUDGET"
    HISTORICAL_TRANSACTION = "HISTORICAL_TRANSACTION"
    PUBLIC_REFERENCE = "PUBLIC_REFERENCE"
    FORMAL_QUOTATION = "FORMAL_QUOTATION"


class ComparabilityStatus(StrEnum):
    """Whether two prices can be put on one scale."""

    COMPARABLE = "COMPARABLE"
    NOT_COMPARABLE = "NOT_COMPARABLE"


class HistoryScope(StrEnum):
    """Which part of the imported history speaks about one requirement.

    An imported workbook holds many items. The rows of one item are a price
    baseline for that item. The rows of the whole workbook are a catalogue
    overview: they say what was paid across different items, so they are not a
    baseline for a single product and never produce a lowest price, a
    ranking, or a saving.
    """

    ITEM = "ITEM"
    TABLE_OVERVIEW = "TABLE_OVERVIEW"
    NONE = "NONE"


class ComparabilityReason(StrEnum):
    """Why two prices can or cannot be compared."""

    SAME_BASIS = "SAME_BASIS"
    DIFFERENT_BASIS = "DIFFERENT_BASIS"
    TAX_BASIS_MISMATCH = "TAX_BASIS_MISMATCH"
    UNKNOWN_TAX_BASIS = "UNKNOWN_TAX_BASIS"
    CURRENCY_MISMATCH = "CURRENCY_MISMATCH"
    UNKNOWN_CURRENCY = "UNKNOWN_CURRENCY"
    UNIT_MISMATCH = "UNIT_MISMATCH"
    UNKNOWN_UNIT = "UNKNOWN_UNIT"


class PriceObservation(BaseModel):
    """One price number with the context needed to compare it."""

    model_config = ConfigDict(extra="forbid")

    observation_id: str
    price_basis: PriceBasis
    value: str
    currency: str | None = "CNY"
    unit: str | None = Field(default=None, max_length=40)
    tax_basis: TaxBasis = TaxBasis.UNKNOWN
    tax_rate: str | None = None
    requirement_id: str | None = None
    sku: str | None = None
    supplier_id: str | None = None
    product_equivalence_key: str | None = None
    source_ref: str | None = None
    source_quote: str | None = None
    observed_at: datetime | None = None
    is_synthetic_supplier: bool = False

    @field_validator("value")
    @classmethod
    def decimal_value(cls, value: str) -> str:
        try:
            parsed = Decimal(value)
        except (InvalidOperation, ValueError) as exc:
            raise ValueError("a price must be a decimal string") from exc
        if not parsed.is_finite():
            raise ValueError("a price must be finite")
        return value


class PriceComparison(BaseModel):
    """The outcome of comparing two prices."""

    model_config = ConfigDict(extra="forbid")

    status: ComparabilityStatus
    reasons: list[ComparabilityReason] = Field(default_factory=list)
    difference: str | None = None
    difference_percent: str | None = None
    explanation: str = Field(min_length=4, max_length=800)


class PriceStatistics(BaseModel):
    """The distribution of one comparable price series."""

    model_config = ConfigDict(extra="forbid")

    count: int = Field(ge=0)
    basis: PriceBasis
    currency: str | None = None
    unit: str | None = None
    tax_basis: TaxBasis = TaxBasis.UNKNOWN
    minimum: str | None = None
    maximum: str | None = None
    median: str | None = None
    mean: str | None = None
    p25: str | None = None
    p75: str | None = None
    total_quantity: str | None = None
    quantity_unit: str | None = None


class PriceFinding(BaseModel):
    """The outcome of a price analysis for one requirement.

    A lowest price and a saving are only present when the prices that produced
    them were comparable.
    """

    model_config = ConfigDict(extra="forbid")

    requirement_id: str | None = None
    equivalence_key: str | None = None
    comparability: ComparabilityStatus
    reasons: list[ComparabilityReason] = Field(default_factory=list)
    lowest_observation_id: str | None = None
    lowest_value: str | None = None
    lowest_basis: PriceBasis | None = None
    budget_value: str | None = None
    saving: str | None = None
    saving_percent: str | None = None
    excluded_observation_ids: list[str] = Field(default_factory=list)
    explanation: str = Field(min_length=4, max_length=1000)


def normalize_price_unit(unit: str | None) -> str | None:
    """Normalize a unit of trade so that two spellings compare equal."""
    if unit is None:
        return None
    key = unit.strip().casefold().replace(" ", "")
    return key or None


def read_decimal(value: str) -> Decimal | None:
    """Read a finite decimal from the canonical string form."""
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() else None
