"""Tests for the M3-B history analytics and the equivalence-based fusion."""

from __future__ import annotations

from procurement_agent.domain.pricing import PriceBasis
from procurement_agent.domain.requirements import HistoricalTransaction
from procurement_agent.services.history_analytics import (
    analyze_history,
    is_synthetic_supplier,
)
from procurement_agent.services.product_equivalence import (
    EquivalenceStatus,
    ProductEquivalence,
    build_equivalence_index,
    fuse_by_equivalence,
)


def transaction(**overrides) -> HistoricalTransaction:
    fields = {
        "transaction_id": "t1",
        "dataset_id": "d1",
        "project_id": "p1",
        "source_row_ref": "row=2",
        "sku": "SKU-1",
        "product_name": "某工业摄像机",
        "specification": "5MP",
        "supplier_entity_id": "HISTORICAL_SUPPLIER_SIMULATED:SUP-A",
        "supplier_display_name": "模拟供应商甲",
        "supplier_namespace": "HISTORICAL_SUPPLIER_SIMULATED",
        "is_synthetic_supplier": True,
        "quantity": "100",
        "unit_price_ex_tax": "88.50",
        "tax_rate": "13%",
        "currency": "CNY",
    }
    fields.update(overrides)
    return HistoricalTransaction(**fields)


# --- history analytics ------------------------------------------------------


def test_analysis_without_history_is_available_and_empty():
    analysis = analyze_history([], requirement_id="r1")
    assert analysis.available is False
    assert analysis.statistics is None
    assert analysis.transaction_count == 0
    assert "no historical distribution" in analysis.notes[0]


def test_the_distribution_uses_the_real_fields():
    rows = [
        transaction(transaction_id="t1", unit_price_ex_tax="88.50", quantity="100"),
        transaction(transaction_id="t2", unit_price_ex_tax="92.00", quantity="50"),
        transaction(transaction_id="t3", unit_price_ex_tax="95.50", quantity="25"),
    ]
    analysis = analyze_history(rows, requirement_id="r1")
    assert analysis.available is True
    assert analysis.transaction_count == 3
    statistics = analysis.statistics
    assert statistics is not None
    assert statistics.count == 3
    assert statistics.minimum == "88.5"
    assert statistics.maximum == "95.5"
    assert statistics.total_quantity == "175"
    assert statistics.basis == PriceBasis.HISTORICAL_TRANSACTION


def test_a_row_without_a_price_is_counted_but_not_priced():
    rows = [
        transaction(transaction_id="t1", unit_price_ex_tax="88.50"),
        transaction(transaction_id="t2", unit_price_ex_tax=None),
    ]
    analysis = analyze_history(rows)
    assert analysis.transaction_count == 2
    assert analysis.statistics is not None
    assert analysis.statistics.count == 1
    assert any("no unit price" in note for note in analysis.notes)


def test_a_simulated_supplier_stays_simulated():
    """The acceptance case: the simulated history never becomes a public company."""
    rows = [
        transaction(transaction_id="t1", supplier_entity_id="HISTORICAL_SUPPLIER_SIMULATED:SUP-A"),
        transaction(
            transaction_id="t2",
            supplier_entity_id="SUP-B",
            supplier_display_name="真实供应商乙",
            supplier_namespace="PUBLIC",
            is_synthetic_supplier=False,
        ),
    ]
    analysis = analyze_history(rows)
    assert analysis.synthetic_supplier_ids == ["HISTORICAL_SUPPLIER_SIMULATED:SUP-A"]
    assert analysis.public_supplier_ids == ["SUP-B"]
    assert any("stay separate from the public companies" in note for note in analysis.notes)
    for supplier in analysis.suppliers:
        if supplier.is_synthetic:
            assert supplier.note is not None
            assert "never mapped to a public company" in supplier.note
        else:
            assert supplier.note is None


def test_the_namespace_alone_marks_a_row_as_simulated():
    row = transaction(is_synthetic_supplier=False, supplier_namespace="HISTORICAL_SUPPLIER_SIMULATED")
    assert is_synthetic_supplier(row) is True


def test_the_observations_carry_the_supplier_and_the_flag():
    analysis = analyze_history([transaction()])
    assert len(analysis.observations) == 1
    observation = analysis.observations[0]
    assert observation.price_basis == PriceBasis.HISTORICAL_TRANSACTION
    assert observation.supplier_id == "HISTORICAL_SUPPLIER_SIMULATED:SUP-A"
    assert observation.is_synthetic_supplier is True


# --- equivalence ------------------------------------------------------------


def equivalence(**overrides) -> ProductEquivalence:
    fields = {
        "equivalence_key": "eq-5mp-camera",
        "product_ref": "prd_lucid_tri055n",
        "requirement_id": "r1",
        "confirmed_by": "the model and the buyer confirmed the order code",
    }
    fields.update(overrides)
    return ProductEquivalence(**fields)


def test_only_a_confirmed_equivalence_enters_the_index():
    index = build_equivalence_index(
        [
            equivalence(product_ref="prd_a"),
            equivalence(product_ref="prd_b", status=EquivalenceStatus.CANDIDATE),
        ]
    )
    assert index == {"prd_a": "eq-5mp-camera"}


def test_records_are_fused_by_equivalence_not_by_supplier_name():
    from procurement_agent.domain.pricing import PriceObservation

    history = PriceObservation(
        observation_id="h1",
        price_basis=PriceBasis.HISTORICAL_TRANSACTION,
        value="88.50",
        currency="CNY",
        unit="元/套",
        requirement_id="r1",
        sku="SKU-1",
        supplier_id="SUP-A",
        is_synthetic_supplier=True,
    )
    public = PriceObservation(
        observation_id="p1",
        price_basis=PriceBasis.PUBLIC_REFERENCE,
        value="95",
        currency="CNY",
        unit="元/套",
        requirement_id="r1",
        supplier_id="SUP-B",
        product_equivalence_key="prd_a",
    )
    groups = fuse_by_equivalence(
        history_observations=[history],
        public_observations=[public],
        equivalences=[equivalence(product_ref="prd_a", sku="SKU-1")],
    )
    assert len(groups) == 1
    group = groups[0]
    assert group.equivalence_key == "eq-5mp-camera"
    assert group.history_observation_ids == ["h1"]
    assert group.public_observation_ids == ["p1"]
    assert group.synthetic_supplier_ids == ["SUP-A"]
    assert group.public_supplier_ids == ["SUP-B"]
    assert any("not because the supplier names match" in note for note in group.notes)


def test_a_record_without_a_confirmed_equivalence_stays_out():
    from procurement_agent.domain.pricing import PriceObservation

    public = PriceObservation(
        observation_id="p1",
        price_basis=PriceBasis.PUBLIC_REFERENCE,
        value="95",
        requirement_id="r1",
        supplier_id="SUP-B",
        product_equivalence_key="prd_unknown",
    )
    groups = fuse_by_equivalence(
        history_observations=[],
        public_observations=[public],
        equivalences=[equivalence(product_ref="prd_a")],
    )
    assert groups == []


def test_the_same_supplier_name_never_creates_a_group():
    from procurement_agent.domain.pricing import PriceObservation

    history = PriceObservation(
        observation_id="h1",
        price_basis=PriceBasis.HISTORICAL_TRANSACTION,
        value="88.50",
        supplier_id="SUP-A",
        requirement_id="r1",
    )
    public = PriceObservation(
        observation_id="p1",
        price_basis=PriceBasis.PUBLIC_REFERENCE,
        value="95",
        supplier_id="SUP-A",
        requirement_id="r1",
    )
    groups = fuse_by_equivalence(
        history_observations=[history],
        public_observations=[public],
        equivalences=[],
    )
    assert groups == []
