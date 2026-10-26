"""Regression checks against the four local official competition inputs.

The files remain outside this repository and are never uploaded by these
tests. If the user has not placed the local source package beside the repo,
pytest skips these checks; CI uses synthetic fixtures instead.

These checks cover the deterministic layer only: that the extractor reads the
whole document without dropping a row. What the model derives from that
content is asserted by ``scripts/live_official_demand_compile.py``.
"""

from pathlib import Path

import pytest

from procurement_agent.ingestion.pptx import extract_pptx_fragments
from procurement_agent.ingestion.xlsx import import_historical_xlsx

SOURCE_ROOT = (
    Path(__file__).resolve().parents[2]
    / "参赛要求与官方资料"
    / "命题赛道素材_已解压"
    / "命题赛道素材"
    / "寻价比源素材"
)


@pytest.mark.parametrize(
    ("case", "pptx_name", "xlsx_name", "expected_start", "expected_end"),
    [
        (
            "1",
            "智能视频采集终端生产采购项目_v1.pptx",
            "智能视频采集终端_历史采购明细_v1.xlsx",
            "2023-01-03",
            "2025-06-30",
        ),
        (
            "2",
            "智能视觉感知探头生产采购项目_v2.pptx",
            "智能视觉感知探头_模拟历史采购明细_v2.xlsx",
            "2023-01-03",
            "2025-12-31",
        ),
    ],
)
def test_official_case_pptx_and_xlsx(case, pptx_name, xlsx_name, expected_start, expected_end):
    case_dir = SOURCE_ROOT / case
    pptx_path = case_dir / pptx_name
    xlsx_path = case_dir / xlsx_name
    if not pptx_path.exists() or not xlsx_path.exists():
        pytest.skip("official competition materials are not present in this local workspace")

    fragments = extract_pptx_fragments(
        pptx_path.read_bytes(),
        project_id=f"official-case-{case}",
        source_id=f"official-pptx-{case}",
        filename=pptx_name,
    )
    assert fragments
    assert any(":slide=1:" in fragment.locator for fragment in fragments)
    assert any(":slide=6:table=1:row=1" in fragment.locator for fragment in fragments)
    assert any(":slide=6:table=1:row=15" in fragment.locator for fragment in fragments)

    procurement_rows = [
        fragment
        for fragment in fragments
        if ":slide=6:table=1:row=" in fragment.locator
        and not fragment.locator.endswith(":row=1")
    ]
    assert len(procurement_rows) == 14
    assert all("|" in fragment.text for fragment in procurement_rows)
    assert all(fragment.text.split(" | ")[0].strip() for fragment in procurement_rows)
    # Nothing is filtered out of the document before the model reads it.
    assert any("市场预测" in fragment.text for fragment in fragments)

    result = import_historical_xlsx(
        xlsx_path.read_bytes(),
        project_id=f"official-case-{case}",
        source_file_name=xlsx_name,
        source_file_id=f"official-xlsx-{case}",
    )
    assert result.header_row == 8
    assert result.row_count == 1000
    assert result.column_count == 38
    assert result.is_synthetic is True
    assert result.supplier_namespace == "HISTORICAL_SUPPLIER_SIMULATED"
    assert result.transactions[0].supplier_entity_id.startswith(
        "HISTORICAL_SUPPLIER_SIMULATED:"
    )
    assert result.transactions[0].order_date.startswith(expected_start)
    assert result.transactions[-1].order_date.startswith(expected_end)
