"""M3-B price context: everything known about the prices of one requirement.

The context brings three things together: what the internal history says, what
the public leads say, and what the buyer planned to pay. The history is
optional, and the public listings are never treated as offers.

The fusion uses confirmed product equivalences, never the supplier name.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from procurement_agent.domain.pricing import (
    HistoryScope,
    PriceBasis,
    PriceFinding,
    PriceObservation,
)
from procurement_agent.domain.requirements import HistoricalTransaction, Requirement, TaxBasis
from procurement_agent.services.history_analytics import (
    HistoryAnalysis,
    analyze_history,
    scope_history,
)
from procurement_agent.services.price_analysis import analyze_price_series
from procurement_agent.services.product_equivalence import (
    FusedGroup,
    ProductEquivalence,
    fuse_by_equivalence,
)


class PriceContext(BaseModel):
    """What is known about the prices of one requirement."""

    model_config = ConfigDict(extra="forbid")

    requirement_id: str | None = None
    product_name: str | None = None
    budget_value: str | None = None
    budget_currency: str | None = None
    budget_unit: str | None = None
    budget_tax_basis: TaxBasis = TaxBasis.UNKNOWN
    # Whether the planned budget is a unit price or the total of the line.
    budget_kind: str | None = None
    history: HistoryAnalysis
    history_overview: HistoryAnalysis | None = None
    history_scope: HistoryScope = HistoryScope.NONE
    fused_groups: list[FusedGroup] = Field(default_factory=list)
    findings: list[PriceFinding] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


def budget_kind(requirement: Requirement) -> str | None:
    """Say whether the planned budget is a unit price or the total."""
    if requirement.planned_unit_price is not None:
        return "PLANNED_UNIT_PRICE"
    if requirement.planned_total_budget is not None:
        return "PLANNED_TOTAL_BUDGET"
    return None


def budget_observation(requirement: Requirement) -> PriceObservation | None:
    """Read the planned price of a requirement as a budget observation."""
    amount = requirement.planned_unit_price or requirement.planned_total_budget
    if amount is None:
        return None
    return PriceObservation(
        observation_id=f"budget:{requirement.requirement_id}",
        price_basis=PriceBasis.PLANNED_BUDGET,
        value=amount.value,
        currency=amount.currency,
        unit=amount.unit,
        tax_basis=amount.tax_basis,
        tax_rate=amount.tax_rate,
        requirement_id=requirement.requirement_id,
        source_ref=amount.source_ref,
        source_quote=amount.source_quote,
    )


def build_price_context(
    *,
    requirement: Requirement,
    transactions: Iterable[HistoricalTransaction] = (),
    public_observations: Sequence[PriceObservation] = (),
    equivalences: Sequence[ProductEquivalence] = (),
    history_price_unit: str | None = None,
) -> PriceContext:
    """Build the price context of one requirement.

    A requirement without a history still gets a context: the history part
    says there is none, and the public prices and the budget are analysed on
    their own.
    """
    rows = list(transactions)
    scope = scope_history(rows, requirement=requirement, equivalences=equivalences)
    overview: HistoryAnalysis | None = None
    if scope.scope == HistoryScope.ITEM:
        history = analyze_history(
            scope.rows,
            requirement_id=requirement.requirement_id,
            price_unit=history_price_unit,
            scope=HistoryScope.ITEM,
            scope_note=scope.note,
            item_keys=scope.item_keys,
        )
        # Only the rows of this requirement's own item are a price baseline.
        history_observations = list(history.observations)
    else:
        history = analyze_history(
            [],
            requirement_id=requirement.requirement_id,
            price_unit=history_price_unit,
            scope=scope.scope,
            scope_note=scope.note,
        )
        history_observations = []
        if scope.scope == HistoryScope.TABLE_OVERVIEW and scope.rows:
            overview = analyze_history(
                scope.rows,
                requirement_id=requirement.requirement_id,
                price_unit=history_price_unit,
                scope=HistoryScope.TABLE_OVERVIEW,
                scope_note=(
                    "This is the imported catalogue as a whole. It is not the price of this "
                    "requirement's item and is never used as a baseline."
                ),
            )
    budget = budget_observation(requirement)
    observations = history_observations + list(public_observations)
    findings = analyze_price_series(
        requirement_id=requirement.requirement_id,
        observations=observations,
        budget=budget,
    )
    fused = fuse_by_equivalence(
        history_observations=history.observations,
        public_observations=list(public_observations),
        equivalences=equivalences,
    )
    notes: list[str] = []
    if not rows:
        notes.append("This project has no imported purchase history.")
    if scope.scope == HistoryScope.TABLE_OVERVIEW:
        notes.append(scope.note)
    if public_observations and not equivalences:
        notes.append(
            "No product equivalence was confirmed, so the public prices are not joined with the history."
        )
    if history.synthetic_supplier_ids:
        notes.append(
            "The history rows of the simulated suppliers stay separate from every public company."
        )
    return PriceContext(
        requirement_id=requirement.requirement_id,
        product_name=requirement.product_name,
        budget_value=budget.value if budget is not None else None,
        budget_currency=budget.currency if budget is not None else None,
        budget_unit=budget.unit if budget is not None else None,
        budget_tax_basis=budget.tax_basis if budget is not None else TaxBasis.UNKNOWN,
        budget_kind=budget_kind(requirement),
        history=history,
        history_overview=overview,
        history_scope=scope.scope,
        fused_groups=fused,
        findings=findings,
        notes=notes + history.notes,
    )


def context_summary(context: PriceContext) -> dict[str, Any]:
    """A short summary for the decision stage and for the report."""
    return {
        "requirement_id": context.requirement_id,
        "history_available": context.history.available,
        "history_scope": context.history_scope.value,
        "history_scope_note": context.history.scope_note,
        "history_rows": context.history.transaction_count,
        "history_overview_rows": context.history_overview.transaction_count if context.history_overview else 0,
        "history_overview_is_not_a_baseline": context.history_scope == HistoryScope.TABLE_OVERVIEW,
        "distinct_history_prices": context.history.statistics.count if context.history.statistics else 0,
        "budget": context.budget_value,
        "budget_kind": context.budget_kind,
        "findings": [
            {
                "basis": finding.lowest_basis.value if finding.lowest_basis else None,
                "lowest": finding.lowest_value,
                "saving": finding.saving,
                "comparability": finding.comparability.value,
            }
            for finding in context.findings
        ],
        "fused_groups": len(context.fused_groups),
        "notes": context.notes,
    }
