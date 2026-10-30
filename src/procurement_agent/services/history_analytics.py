"""M3-B history analytics: the price distribution of what was bought before.

The history is optional. A project without an imported history still runs,
and its analysis simply says that there is no history.

Two rules hold here. The statistics are computed over the real fields of the
imported rows, and a simulated supplier never becomes a public company: the
rows that carry the simulated namespace stay in their own group and are never
named after a real entity.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from decimal import Decimal
from statistics import median

from pydantic import BaseModel, ConfigDict, Field

from procurement_agent.domain.pricing import (
    PriceBasis,
    PriceObservation,
    PriceStatistics,
    read_decimal,
)
from procurement_agent.domain.requirements import HistoricalTransaction, TaxBasis

SYNTHETIC_NAMESPACE = "HISTORICAL_SUPPLIER_SIMULATED"


class HistoricalSupplierSummary(BaseModel):
    """One supplier in the history, with the isolation rule visible."""

    model_config = ConfigDict(extra="forbid")

    supplier_entity_id: str
    display_name: str | None = None
    is_synthetic: bool
    transaction_count: int = Field(ge=0)
    total_quantity: str | None = None
    note: str | None = None


class HistoryAnalysis(BaseModel):
    """What the history says about one requirement or product equivalence key."""

    model_config = ConfigDict(extra="forbid")

    requirement_id: str | None = None
    equivalence_key: str | None = None
    available: bool = False
    transaction_count: int = Field(default=0, ge=0)
    statistics: PriceStatistics | None = None
    suppliers: list[HistoricalSupplierSummary] = Field(default_factory=list)
    synthetic_supplier_ids: list[str] = Field(default_factory=list)
    public_supplier_ids: list[str] = Field(default_factory=list)
    observations: list[PriceObservation] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


def is_synthetic_supplier(transaction: HistoricalTransaction) -> bool:
    """Report whether a history row comes from a simulated supplier."""
    if transaction.is_synthetic_supplier:
        return True
    namespace = (transaction.supplier_namespace or "").strip().upper()
    entity = (transaction.supplier_entity_id or "").strip().upper()
    return namespace.startswith(SYNTHETIC_NAMESPACE) or entity.startswith(f"{SYNTHETIC_NAMESPACE}:")


def _quantile(values: Sequence[Decimal], fraction: float) -> Decimal | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (Decimal(1) - Decimal(str(weight))) + ordered[upper] * Decimal(str(weight))


def _format(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _observation_for(
    transaction: HistoricalTransaction,
    price_unit: str | None = None,
) -> PriceObservation | None:
    """Read one history row as a price observation.

    The unit of the imported price column is not part of the row, so the
    caller states it. Without a unit the price cannot be compared with a
    budget that states one.
    """
    value = transaction.unit_price_ex_tax
    if not value:
        return None
    number = read_decimal(value)
    if number is None:
        return None
    return PriceObservation(
        observation_id=transaction.transaction_id,
        price_basis=PriceBasis.HISTORICAL_TRANSACTION,
        value=value,
        currency=transaction.currency or "CNY",
        unit=price_unit,
        tax_basis=TaxBasis.EXCLUSIVE if transaction.unit_price_ex_tax else TaxBasis.UNKNOWN,
        tax_rate=transaction.tax_rate,
        sku=transaction.sku,
        supplier_id=transaction.supplier_entity_id,
        source_ref=transaction.source_row_ref,
        source_quote=transaction.specification,
        observed_at=None,
        is_synthetic_supplier=is_synthetic_supplier(transaction),
    )


def analyze_history(
    transactions: Iterable[HistoricalTransaction],
    *,
    requirement_id: str | None = None,
    equivalence_key: str | None = None,
    price_unit: str | None = None,
) -> HistoryAnalysis:
    """Compute the price distribution and the purchase volume of a history.

    The rows that carry no unit price are counted but do not enter the
    distribution, and the reason is written down.
    """
    rows = list(transactions)
    if not rows:
        return HistoryAnalysis(
            requirement_id=requirement_id,
            equivalence_key=equivalence_key,
            available=False,
            notes=["No internal purchase history was imported, so there is no historical distribution."],
        )
    prices: list[Decimal] = []
    observations: list[PriceObservation] = []
    quantity_total = Decimal(0)
    quantity_seen = False
    quantity_unit: str | None = None
    currency: str | None = None
    without_price = 0
    suppliers: dict[str, HistoricalSupplierSummary] = {}
    for transaction in rows:
        synthetic = is_synthetic_supplier(transaction)
        entity = transaction.supplier_entity_id or "unknown"
        summary = suppliers.get(entity)
        if summary is None:
            summary = HistoricalSupplierSummary(
                supplier_entity_id=entity,
                display_name=transaction.supplier_display_name,
                is_synthetic=synthetic,
                transaction_count=0,
                note=(
                    "The rows of this supplier come from the simulated history. They are never "
                    "mapped to a public company."
                    if synthetic
                    else None
                ),
            )
            suppliers[entity] = summary
        summary.transaction_count += 1
        if transaction.quantity:
            quantity = read_decimal(transaction.quantity)
            if quantity is not None:
                quantity_total += quantity
                quantity_seen = True
        observation = _observation_for(transaction, price_unit)
        if observation is None:
            without_price += 1
            continue
        prices.append(read_decimal(observation.value) or Decimal(0))
        observations.append(observation)
        if currency is None:
            currency = observation.currency
    statistics: PriceStatistics | None = None
    if prices:
        statistics = PriceStatistics(
            count=len(prices),
            basis=PriceBasis.HISTORICAL_TRANSACTION,
            currency=currency,
            unit=price_unit,
            tax_basis=TaxBasis.EXCLUSIVE,
            minimum=_format(min(prices)),
            maximum=_format(max(prices)),
            median=_format(Decimal(str(median(prices)))),
            mean=_format(sum(prices) / Decimal(len(prices))),
            p25=_format(_quantile(prices, 0.25)),
            p75=_format(_quantile(prices, 0.75)),
            total_quantity=_format(quantity_total) if quantity_seen else None,
            quantity_unit=quantity_unit,
        )
    notes: list[str] = []
    if without_price:
        notes.append(f"{without_price} rows carry no unit price and are not part of the distribution.")
    synthetic_ids = sorted(item.supplier_entity_id for item in suppliers.values() if item.is_synthetic)
    public_ids = sorted(item.supplier_entity_id for item in suppliers.values() if not item.is_synthetic)
    if synthetic_ids:
        notes.append(
            "The simulated suppliers stay separate from the public companies: no row of this "
            "history is attributed to a public entity."
        )
    return HistoryAnalysis(
        requirement_id=requirement_id,
        equivalence_key=equivalence_key,
        available=True,
        transaction_count=len(rows),
        statistics=statistics,
        suppliers=sorted(suppliers.values(), key=lambda item: item.supplier_entity_id),
        synthetic_supplier_ids=synthetic_ids,
        public_supplier_ids=public_ids,
        observations=observations,
        notes=notes,
    )


def group_by_supplier(
    transactions: Iterable[HistoricalTransaction],
) -> dict[str, list[HistoricalTransaction]]:
    """Group the history rows by supplier, keeping the synthetic ones apart."""
    grouped: dict[str, list[HistoricalTransaction]] = defaultdict(list)
    for transaction in transactions:
        grouped[transaction.supplier_entity_id or "unknown"].append(transaction)
    return dict(grouped)
