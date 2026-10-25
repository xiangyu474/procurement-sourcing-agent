"""Regression checks against the four local official competition inputs.

The files remain outside this repository and are never uploaded by these
tests. If the user has not placed the local source package beside the repo,
pytest skips these checks; CI uses synthetic fixtures instead.
"""

from pathlib import Path

import pytest

from procurement_agent.ingestion.pptx import (
    extract_pptx_fragments,
    select_pptx_demand_fragments,
    select_pptx_narrative_fragments,
)
from procurement_agent.ingestion.pptx_tables import (
    extract_requirement_rows_from_pptx,
    extract_summary_quantity_conflicts,
)
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
    slide_six = [f for f in fragments if ":slide=6:" in f.locator]
    demand_fragments = select_pptx_demand_fragments(fragments)
    narrative_fragments = select_pptx_narrative_fragments(fragments)
    requirements = extract_requirement_rows_from_pptx(
        fragments, project_id=f"official-case-{case}"
    )
    assert len(fragments) > 0
    assert any(":table=1:row=1:cell=1" in f.locator for f in slide_six)
    assert any(":table=1:row=15:cell=7" in f.locator for f in slide_six)
    assert sum(1 for f in demand_fragments if ":slide=6:table=1:row=" in f.locator and ":cell=2" in f.locator and ":row=1:" not in f.locator) == 14
    assert len(requirements) == 14
    assert not any("市场预测" in f.text or "客户痛点" in f.text for f in narrative_fragments)
    assert all(requirement.quantity is not None for requirement in requirements)
    assert all(requirement.planned_unit_price is not None for requirement in requirements)
    assert all(requirement.planned_unit_price.tax_basis.value == "UNKNOWN" for requirement in requirements)

    if case == "1":
        summary_conflicts = extract_summary_quantity_conflicts(fragments, project_id="official-case-1")
        assert any(
            conflict.field == "summary_procurement_quantity_claims"
            and {value.value for value in conflict.values_with_source} == {"58万台", "63万台"}
            and all(value.source_ref and value.source_quote for value in conflict.values_with_source)
            for conflict in summary_conflicts
        )

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
