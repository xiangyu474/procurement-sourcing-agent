"""Tests for the price context the frontend reads.

The frontend shows a price only when it knows the scope the price was
computed in. These tests pin the shape of that answer and the rule that a
catalogue-wide figure is never presented as the price of one item.
"""

from __future__ import annotations

from procurement_agent.api.app import _price_contexts
from procurement_agent.domain.requirements import HistoricalTransaction, Requirement


def requirement(**overrides) -> Requirement:
    fields = {
        "requirement_id": "r1",
        "project_id": "p1",
        "product_name": "5MP 工业网络摄像机",
    }
    fields.update(overrides)
    return Requirement(**fields)


def transaction(sku: str, name: str, price: str) -> HistoricalTransaction:
    return HistoricalTransaction(
        transaction_id=f"t-{sku}-{price}",
        dataset_id="d1",
        project_id="p1",
        source_row_ref=f"row-{sku}-{price}",
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


def test_a_requirement_outside_the_catalogue_gets_an_overview_only() -> None:
    """The catalogue is an overview, and the answer says so."""
    contexts = _price_contexts(
        requirements=[requirement()],
        transactions=[
            transaction("SKU-A", "通用超清枪式探头", "99"),
            transaction("SKU-B", "通用超清云台探头", "77"),
        ],
        equivalences=[],
        history_price_unit="元/台",
    )

    assert len(contexts) == 1
    context = contexts[0]
    assert context["history_scope"] == "TABLE_OVERVIEW"
    assert context["overview_is_not_a_baseline"] is True
    assert context["history_available"] is False
    assert context["statistics"] is None
    assert context["overview_statistics"] is not None
    assert context["overview_statistics"]["minimum"] == "77"
    assert context["findings"] == []
    assert any("not a price baseline" in note for note in context["notes"])


def test_the_item_of_the_requirement_is_its_price_baseline() -> None:
    """The rows of the own item are the baseline, and they can be compared."""
    contexts = _price_contexts(
        requirements=[requirement(product_name="通用超清枪式探头")],
        transactions=[
            transaction("SKU-A", "通用超清枪式探头", "99"),
            transaction("SKU-B", "通用超清云台探头", "77"),
        ],
        equivalences=[],
        history_price_unit="元/台",
    )

    context = contexts[0]
    assert context["history_scope"] == "ITEM"
    assert context["overview_is_not_a_baseline"] is False
    assert context["history_available"] is True
    assert context["history_rows"] == 1
    assert context["statistics"] is not None
    assert context["statistics"]["minimum"] == "99"
    assert context["statistics"]["count"] == 1


def test_the_answer_carries_the_budget_of_the_requirement() -> None:
    """The planned price is part of the price context."""
    contexts = _price_contexts(
        requirements=[requirement()],
        transactions=[],
        equivalences=[],
        history_price_unit=None,
    )

    context = contexts[0]
    assert context["requirement_id"] == "r1"
    assert context["product_name"] == "5MP 工业网络摄像机"
    assert context["history_scope"] == "NONE"
    assert context["history_available"] is False
    assert context["findings"] == []
