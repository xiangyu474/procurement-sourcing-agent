"""Tests for the M3-B history scope: a catalogue is not a price baseline.

The official history workbooks hold fourteen items each, with prices that
spread over more than fifteen times. A number that averages those items
describes the catalogue, not the product a buyer is asking about. These
tests pin that rule down: the history is scoped to the requirement's own
item, and a table-wide figure never becomes a lowest price or a saving.
"""

from __future__ import annotations

import pytest

from procurement_agent.domain.pricing import (
    ComparabilityStatus,
    HistoryScope,
    PriceBasis,
    PriceObservation,
)
from procurement_agent.domain.requirements import (
    HistoricalTransaction,
    PlannedAmount,
    Requirement,
    TaxBasis,
)
from procurement_agent.services.history_analytics import scope_history
from procurement_agent.services.price_context import build_price_context, context_summary
from procurement_agent.services.product_equivalence import (
    EquivalenceStatus,
    ProductEquivalence,
)

CATALOGUE = (
    ("SKU-CHEAP", "通用超清云台探头", "77"),
    ("SKU-MAIN", "通用超清轻智能枪式探头", "99"),
    ("SKU-MAIN", "通用超清轻智能枪式探头", "123"),
    ("SKU-EXPENSIVE", "通用超清轻智能4G探头（80W太阳能版）", "1255"),
)


def requirement(**overrides) -> Requirement:
    fields = {
        "requirement_id": "r1",
        "project_id": "p1",
        "product_name": "5MP 工业网络摄像机",
        "planned_unit_price": PlannedAmount(
            kind="PLANNED_PRICE",
            value="200",
            currency="CNY",
            unit="元/套",
            tax_basis=TaxBasis.INCLUSIVE,
            source_ref="pptx:slide=6:table=1:row=2",
            source_quote="预计采购单价（元/套） | 200",
        ),
    }
    fields.update(overrides)
    return Requirement(**fields)


def transaction(index: int, sku: str, name: str, price: str) -> HistoricalTransaction:
    return HistoricalTransaction(
        transaction_id=f"t{index}",
        dataset_id="d1",
        project_id="p1",
        source_row_ref=f"row={index + 2}",
        sku=sku,
        product_name=name,
        specification="5MP",
        supplier_entity_id="HISTORICAL_SUPPLIER_SIMULATED:SUP-A",
        supplier_display_name="模拟供应商甲",
        supplier_namespace="HISTORICAL_SUPPLIER_SIMULATED",
        is_synthetic_supplier=True,
        quantity="10",
        unit_price_ex_tax=price,
        currency="CNY",
    )


def catalogue() -> list[HistoricalTransaction]:
    return [transaction(index, sku, name, price) for index, (sku, name, price) in enumerate(CATALOGUE)]


def test_history_without_a_matching_item_is_not_a_price_baseline() -> None:
    """A catalogue of other products produces no lowest price and no saving."""
    context = build_price_context(
        requirement=requirement(),
        transactions=catalogue(),
        history_price_unit="元/套",
    )

    assert context.history_scope == HistoryScope.TABLE_OVERVIEW
    assert context.history.available is False
    assert context.history.statistics is None
    assert context.history_overview is not None
    assert context.history_overview.transaction_count == 4
    assert context.history_overview.statistics is not None
    assert context.history_overview.statistics.minimum == "77"

    historical = [
        finding
        for finding in context.findings
        if finding.lowest_basis == PriceBasis.HISTORICAL_TRANSACTION
    ]
    assert historical == []
    assert all(finding.saving is None for finding in context.findings)
    assert any("not a price baseline" in note for note in context.notes)


def test_the_overview_is_never_used_for_a_saving_even_with_a_budget() -> None:
    """A budget plus a catalogue still produces no saving."""
    context = build_price_context(
        requirement=requirement(),
        transactions=catalogue(),
        history_price_unit="元/套",
    )

    assert context.budget_value == "200"
    assert context.findings == []
    summary = context_summary(context)
    assert summary["history_available"] is False
    assert summary["history_scope"] == "TABLE_OVERVIEW"
    assert summary["history_overview_rows"] == 4
    assert summary["history_overview_is_not_a_baseline"] is True


def test_a_confirmed_equivalence_scopes_the_history_to_one_item() -> None:
    """A confirmed equivalence makes the rows of that item the baseline."""
    equivalence = ProductEquivalence(
        equivalence_key="eq-1",
        product_ref="SKU-MAIN",
        requirement_id="r1",
        sku="SKU-MAIN",
        status=EquivalenceStatus.CONFIRMED,
        confirmed_by="the buyer confirmed the item identity",
    )
    context = build_price_context(
        requirement=requirement(
            planned_unit_price=PlannedAmount(
                kind="PLANNED_PRICE",
                value="200",
                currency="CNY",
                unit="元/套",
                tax_basis=TaxBasis.EXCLUSIVE,
                source_ref="pptx:slide=6:table=1:row=2",
                source_quote="预计采购单价（元/套） | 200",
            )
        ),
        transactions=catalogue(),
        equivalences=[equivalence],
        history_price_unit="元/套",
    )

    assert context.history_scope == HistoryScope.ITEM
    assert context.history.available is True
    assert context.history.transaction_count == 2
    assert context.history.statistics is not None
    assert context.history.statistics.minimum == "99"
    assert context.history.statistics.maximum == "123"
    assert context.history_overview is None

    historical = [
        finding
        for finding in context.findings
        if finding.lowest_basis == PriceBasis.HISTORICAL_TRANSACTION
    ]
    assert len(historical) == 1
    assert historical[0].comparability == ComparabilityStatus.COMPARABLE
    assert historical[0].lowest_value == "99"
    assert historical[0].saving == "101"


def test_an_unconfirmed_equivalence_scopes_nothing() -> None:
    """A guess about the item identity does not become a baseline."""
    equivalence = ProductEquivalence(
        equivalence_key="eq-1",
        product_ref="SKU-MAIN",
        requirement_id="r1",
        sku="SKU-MAIN",
        status=EquivalenceStatus.CANDIDATE,
        confirmed_by="a guess that nobody confirmed yet",
    )
    context = build_price_context(
        requirement=requirement(),
        transactions=catalogue(),
        equivalences=[equivalence],
        history_price_unit="元/套",
    )

    assert context.history_scope == HistoryScope.TABLE_OVERVIEW
    assert context.history.available is False
    assert context.findings == []


def test_the_same_item_name_scopes_the_history() -> None:
    """An exact item name is enough to pick the rows of that item."""
    rows = catalogue()
    context = build_price_context(
        requirement=requirement(product_name="通用超清轻智能枪式探头"),
        transactions=rows,
        history_price_unit="元/套",
    )

    assert context.history_scope == HistoryScope.ITEM
    assert context.history.transaction_count == 2
    assert context.history.statistics is not None
    assert context.history.statistics.minimum == "99"


def test_the_scope_function_reports_why_it_matched() -> None:
    """The scope carries the reason, so a report can show it."""
    rows = catalogue()
    unscoped = scope_history(rows, requirement=requirement())
    assert unscoped.scope == HistoryScope.TABLE_OVERVIEW
    assert "other items" in unscoped.note

    equivalence = ProductEquivalence(
        equivalence_key="eq-1",
        product_ref="SKU-MAIN",
        requirement_id="r1",
        sku="SKU-MAIN",
        status=EquivalenceStatus.CONFIRMED,
        confirmed_by="the buyer confirmed the item identity",
    )
    scoped = scope_history(rows, requirement=requirement(), equivalences=[equivalence])
    assert scoped.scope == HistoryScope.ITEM
    assert scoped.matched_by == "CONFIRMED_EQUIVALENCE"
    assert scoped.item_keys == ["SKU-MAIN"]


def test_public_prices_still_analyse_when_the_history_is_only_an_overview() -> None:
    """The overview does not block the public prices from being analysed."""
    observation = PriceObservation(
        observation_id="pub-1",
        price_basis=PriceBasis.PUBLIC_REFERENCE,
        value="150",
        currency="CNY",
        unit="元/套",
        tax_basis=TaxBasis.INCLUSIVE,
    )
    context = build_price_context(
        requirement=requirement(),
        transactions=catalogue(),
        public_observations=[observation],
        history_price_unit="元/套",
    )

    assert len(context.findings) == 1
    assert context.findings[0].lowest_basis == PriceBasis.PUBLIC_REFERENCE
    assert context.findings[0].lowest_value == "150"
    assert context.findings[0].saving is None


def test_the_public_price_of_another_item_is_not_fused_without_an_equivalence() -> None:
    """A public price joins the history only through a confirmed equivalence."""
    observation = PriceObservation(
        observation_id="pub-1",
        price_basis=PriceBasis.PUBLIC_REFERENCE,
        value="150",
        currency="CNY",
        unit="元/套",
        tax_basis=TaxBasis.INCLUSIVE,
        supplier_id="PUBLIC-SUP-1",
    )
    context = build_price_context(
        requirement=requirement(),
        transactions=catalogue(),
        public_observations=[observation],
        history_price_unit="元/套",
    )

    assert context.fused_groups == []
    assert any("No product equivalence" in note for note in context.notes)


@pytest.mark.parametrize("unit", ["元/套", "元/台"])
def test_the_history_unit_is_carried_into_the_statistics(unit: str) -> None:
    """The unit of the history is stated, so a budget in another unit is refused."""
    equivalence = ProductEquivalence(
        equivalence_key="eq-1",
        product_ref="SKU-MAIN",
        requirement_id="r1",
        sku="SKU-MAIN",
        status=EquivalenceStatus.CONFIRMED,
        confirmed_by="the buyer confirmed the item identity",
    )
    context = build_price_context(
        requirement=requirement(),
        transactions=catalogue(),
        equivalences=[equivalence],
        history_price_unit=unit,
    )

    assert context.history.statistics is not None
    assert context.history.statistics.unit == unit
