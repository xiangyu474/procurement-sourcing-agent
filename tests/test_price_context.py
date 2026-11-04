"""Tests for the M3-B price context: the three acceptance cases end to end."""

from __future__ import annotations

from procurement_agent.domain.pricing import (
    ComparabilityStatus,
    PriceBasis,
    PriceObservation,
)
from procurement_agent.domain.requirements import (
    HistoricalTransaction,
    PlannedAmount,
    Requirement,
    TaxBasis,
)
from procurement_agent.services.price_context import (
    build_price_context,
    context_summary,
)
from procurement_agent.services.product_equivalence import ProductEquivalence


def requirement(**overrides) -> Requirement:
    fields = {
        "requirement_id": "r1",
        "project_id": "p1",
        "product_name": "5MP 工业网络摄像机",
        "quantity": "10",
        "quantity_unit": "套",
        "planned_unit_price": PlannedAmount(
            kind="PLANNED_PRICE",
            value="100",
            currency="CNY",
            unit="元/套",
            tax_basis=TaxBasis.INCLUSIVE,
            source_ref="pptx:slide=6:table=1:row=2",
            source_quote="预计采购单价（元/套） | 100",
        ),
    }
    fields.update(overrides)
    return Requirement(**fields)


def transaction(**overrides) -> HistoricalTransaction:
    fields = {
        "transaction_id": "t1",
        "dataset_id": "d1",
        "project_id": "p1",
        "source_row_ref": "row=2",
        "sku": "SKU-1",
        "product_name": "5MP 工业网络摄像机",
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


def public_observation(**overrides) -> PriceObservation:
    fields = {
        "observation_id": "p1",
        "price_basis": PriceBasis.PUBLIC_REFERENCE,
        "value": "95",
        "currency": "CNY",
        "unit": "元/套",
        "tax_basis": TaxBasis.INCLUSIVE,
        "requirement_id": "r1",
        "supplier_id": "SUP-B",
        "product_equivalence_key": "prd_a",
    }
    fields.update(overrides)
    return PriceObservation(**fields)


def test_analysis_without_history_still_works():
    context = build_price_context(requirement=requirement())
    assert context.history.available is False
    assert context.history.statistics is None
    assert context.budget_value == "100"
    assert any("no imported purchase history" in note for note in context.notes)
    summary = context_summary(context)
    assert summary["history_available"] is False
    assert summary["history_rows"] == 0


def test_a_public_listing_never_produces_a_saving():
    context = build_price_context(
        requirement=requirement(),
        public_observations=[public_observation()],
    )
    assert context.findings
    for finding in context.findings:
        assert finding.saving is None
        assert finding.saving_percent is None
    assert all(
        finding.lowest_basis != PriceBasis.PUBLIC_REFERENCE
        or finding.comparability == ComparabilityStatus.COMPARABLE
        for finding in context.findings
    )


def test_the_simulated_history_stays_away_from_the_public_company():
    context = build_price_context(
        requirement=requirement(),
        transactions=[transaction()],
        public_observations=[public_observation()],
        history_price_unit="元/套",
        equivalences=[
            ProductEquivalence(
                equivalence_key="eq-5mp",
                product_ref="prd_a",
                sku="SKU-1",
                requirement_id="r1",
                confirmed_by="the order code was confirmed against the supplier page",
            )
        ],
    )
    assert context.history.synthetic_supplier_ids == ["HISTORICAL_SUPPLIER_SIMULATED:SUP-A"]
    assert context.history.public_supplier_ids == []
    for group in context.fused_groups:
        assert "HISTORICAL_SUPPLIER_SIMULATED:SUP-A" in group.synthetic_supplier_ids
        assert "SUP-B" in group.public_supplier_ids
        assert "HISTORICAL_SUPPLIER_SIMULATED:SUP-A" not in group.public_supplier_ids
    assert any("stay separate from every public company" in note for note in context.notes)


def test_without_a_confirmed_equivalence_the_prices_are_not_joined():
    context = build_price_context(
        requirement=requirement(),
        transactions=[transaction()],
        public_observations=[public_observation()],
        history_price_unit="元/套",
    )
    assert context.fused_groups == []
    assert any("No product equivalence was confirmed" in note for note in context.notes)


def test_the_history_and_the_budget_report_a_saving():
    context = build_price_context(
        requirement=requirement(
            planned_unit_price=PlannedAmount(
                kind="PLANNED_PRICE",
                value="100",
                currency="CNY",
                unit="元/套",
                tax_basis=TaxBasis.EXCLUSIVE,
                source_ref="pptx:slide=6:table=1:row=2",
                source_quote="100",
            )
        ),
        transactions=[transaction()],
        history_price_unit="元/套",
        equivalences=[ProductEquivalence(equivalence_key="eq", product_ref="SKU-1", sku="SKU-1", requirement_id="r1", confirmed_by="test buyer confirmation")],
    )
    findings = {finding.lowest_basis: finding for finding in context.findings}
    historical = findings[PriceBasis.HISTORICAL_TRANSACTION]
    assert historical.lowest_value == "88.50"
    assert historical.saving == "11.5"
    assert historical.saving_percent == "11.5"


def test_the_planned_budget_says_whether_it_is_a_unit_price_or_a_total():
    unit = build_price_context(
        requirement=requirement(
            planned_unit_price=PlannedAmount(kind="PLANNED_PRICE", value="500", currency="CNY", unit="元/套", source_ref="text:1", source_quote="500")
        ),
        transactions=[transaction()],
    )
    assert unit.budget_kind == "PLANNED_UNIT_PRICE"
    total = build_price_context(
        requirement=requirement(
            planned_unit_price=None,
            planned_total_budget=PlannedAmount(kind="PLANNED_BUDGET", value="5000", currency="CNY", unit="元", source_ref="text:1", source_quote="5000"),
        ),
        transactions=[transaction()],
    )
    assert total.budget_kind == "PLANNED_TOTAL_BUDGET"
    plain = build_price_context(requirement=requirement(planned_unit_price=None), transactions=[transaction()])
    assert plain.budget_kind is None
