"""Regression test on the official history workbooks.

The two official files are the ones the competition provides. Each holds a
catalogue of fourteen items whose prices spread over more than fifteen times,
so a table-wide number is not the price of any one item. This test reads the
real files and pins that reading down, so a change in the import cannot turn
the catalogue back into a single baseline.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from procurement_agent.domain.pricing import HistoryScope, PriceBasis
from procurement_agent.domain.requirements import Requirement
from procurement_agent.ingestion.xlsx import import_historical_xlsx
from procurement_agent.services.price_context import build_price_context
from procurement_agent.services.product_equivalence import ProductEquivalence

MATERIALS = (
    Path(__file__).resolve().parents[2]
    / "参赛要求与官方资料/命题赛道素材_已解压/命题赛道素材/寻价比源素材"
)
FILES = (
    ("1", "智能视频采集终端_历史采购明细_v1.xlsx", "AV"),
    ("2", "智能视觉感知探头_模拟历史采购明细_v2.xlsx", "IVP"),
)


def _load(folder: str, name: str):
    path = MATERIALS / folder / name
    if not path.exists():
        pytest.skip(f"the official material {name} is not on this machine")
    return import_historical_xlsx(
        path.read_bytes(),
        project_id="official-regression",
        source_file_name=path.name,
        source_file_id=f"official-{folder}",
    )


def _requirement(product_name: str) -> Requirement:
    return Requirement(
        requirement_id="r1",
        project_id="official-regression",
        product_name=product_name,
    )


@pytest.mark.parametrize("folder,name,prefix", FILES)
def test_every_official_history_holds_many_items(folder: str, name: str, prefix: str) -> None:
    """The workbook is a catalogue, not a single product."""
    imported = _load(folder, name)
    rows = imported.transactions
    skus = {row.sku for row in rows}

    assert imported.row_count == 1000
    assert len(rows) == 1000
    assert len(skus) == 14
    assert all(sku and sku.startswith(prefix) for sku in skus)
    assert imported.is_synthetic is True


@pytest.mark.parametrize("folder,name,prefix", FILES)
def test_the_table_wide_price_is_not_the_price_of_one_item(folder: str, name: str, prefix: str) -> None:
    """A requirement outside the catalogue gets no historical price at all."""
    imported = _load(folder, name)
    context = build_price_context(
        requirement=_requirement("5MP 工业网络摄像机"),
        transactions=imported.transactions,
        history_price_unit="元/台",
    )

    assert context.history_scope == HistoryScope.TABLE_OVERVIEW
    assert context.history.available is False
    assert context.history_overview is not None
    assert context.history_overview.transaction_count == 1000
    assert context.findings == []


def test_one_item_keeps_its_own_price_range() -> None:
    """The rows of one item are the baseline of that item."""
    imported = _load("2", "智能视觉感知探头_模拟历史采购明细_v2.xlsx")
    context = build_price_context(
        requirement=_requirement("通用超清轻智能枪式探头"),
        transactions=imported.transactions,
        history_price_unit="元/台",
        equivalences=[ProductEquivalence(equivalence_key="eq", product_ref="IVP000000008", sku="IVP000000008", requirement_id="r1", confirmed_by="test buyer confirmation")],
    )

    assert context.history_scope == HistoryScope.ITEM
    assert context.history.available is True
    statistics = context.history.statistics
    assert statistics is not None
    assert statistics.count == 633
    assert statistics.minimum == "99"
    assert statistics.maximum == "123"

    historical = [
        finding
        for finding in context.findings
        if finding.lowest_basis == PriceBasis.HISTORICAL_TRANSACTION
    ]
    assert len(historical) == 1
    assert historical[0].lowest_value == "99"


def test_the_spread_inside_one_item_is_narrower_than_across_the_catalogue() -> None:
    """This is why the catalogue cannot stand in for one item."""
    imported = _load("2", "智能视觉感知探头_模拟历史采购明细_v2.xlsx")
    by_sku: dict[str, list[float]] = {}
    for row in imported.transactions:
        if row.unit_price_ex_tax:
            by_sku.setdefault(row.sku or "", []).append(float(row.unit_price_ex_tax))

    all_prices = [price for prices in by_sku.values() for price in prices]
    catalogue_spread = max(all_prices) / min(all_prices)
    item_spreads = [max(prices) / min(prices) for prices in by_sku.values() if len(prices) > 1]

    assert catalogue_spread > 15
    assert max(item_spreads) < 2
