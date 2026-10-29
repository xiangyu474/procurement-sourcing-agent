"""Regression: the Case 2 project total against the sum of its line items.

The competition material states a project total of 5888.66 万元 and its own
purchase table adds up to 5888.64 万元. The 0.02 万元 gap is neither an
arithmetic mistake of ours nor a disagreement inside the source: every row
budget is rounded to two decimals, and the unrounded rows add up to
5888.656 万元, which is the 5888.66 万元 the document states.

This test recomputes both sides and asserts that the difference is classified
as a rounding difference.

The official files stay outside the repository. When they are not present
beside the repo, the test skips; CI uses the synthetic fixture below.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from procurement_agent.domain.requirements import (
    ConflictValue,
    DataConflict,
    PlannedAmount,
    Requirement,
    RequirementCompilation,
)
from procurement_agent.ingestion.pptx import extract_pptx_fragments
from procurement_agent.services.requirement_verification import verify_project_total

SOURCE_ROOT = (
    Path(__file__).resolve().parents[2]
    / "参赛要求与官方资料"
    / "命题赛道素材_已解压"
    / "命题赛道素材"
    / "寻价比源素材"
    / "2"
)
PPTX_NAME = "智能视觉感知探头生产采购项目_v2.pptx"

STATED_TOTAL = Decimal("5888.66")
ROW_SUM = Decimal("5888.64")
UNROUNDED_SUM = Decimal("5888.656")


def _cells(fragment_text: str) -> list[str]:
    return [cell.strip() for cell in fragment_text.split(" | ")]


def _column_index(header: list[str], needle: str) -> int:
    for index, cell in enumerate(header):
        if needle in cell:
            return index
    raise AssertionError(f"the header has no column named {needle}: {header}")


def _purchase_rows(fragments) -> tuple[list[str], list[list[str]]]:
    """Read the purchase table of the official document.

    This helper belongs to the test. Production code does not read the
    document by column position.
    """
    header = None
    rows: list[list[str]] = []
    for fragment in fragments:
        if ":slide=6:table=1:row=" not in fragment.locator:
            continue
        cells = _cells(fragment.text)
        if header is None:
            header = cells
            continue
        rows.append(cells)
    assert header is not None
    return header, rows


def _build_compilation(header: list[str], rows: list[list[str]]) -> RequirementCompilation:
    """Turn the purchase table into the compilation the model would report."""
    quantity_index = _column_index(header, "数量")
    budget_index = _column_index(header, "含税总预算")
    requirements = []
    for index, cells in enumerate(rows, start=1):
        budget = PlannedAmount(
            kind="PLANNED_BUDGET",
            value=cells[budget_index],
            currency="CNY",
            unit="万元",
            source_ref="pptx:slide=6:table=1:row=" + str(index + 1),
            source_quote=cells[budget_index],
        )
        requirements.append(
            Requirement(
                requirement_id=f"pptx_1:r{index}",
                project_id="case-2",
                product_name=cells[1],
                quantity=cells[quantity_index],
                quantity_unit="套",
                planned_total_budget=budget,
                source_refs=[budget.source_ref],
            )
        )
    conflict = DataConflict(
        conflict_id="case2-total",
        project_id="case-2",
        field="planned_total_budget",
        values_with_source=[
            ConflictValue(
                value="5888.66万元（含税）",
                source_ref="pptx:slide=2:table=1:row=1",
                source_quote="5888.66万元（含税）",
            ),
            ConflictValue(
                value="5888.64万元",
                source_ref="pptx:slide=6:table=1:row=2",
                source_quote="含税总预算（万元）",
            ),
        ],
    )
    return RequirementCompilation(project_id="case-2", requirements=requirements, conflicts=[conflict])


def _unrounded_sum(header: list[str], rows: list[list[str]]) -> Decimal:
    """Recompute the rows without the rounding the document applies."""
    quantity_index = _column_index(header, "数量")
    price_index = _column_index(header, "预计采购单价")
    total = Decimal(0)
    for cells in rows:
        quantity = Decimal(cells[quantity_index])
        price = Decimal(cells[price_index])
        total += quantity * price * Decimal("1.13")
    return total / Decimal(10_000)


def test_case2_total_is_a_rounding_difference_not_a_mistake():
    pptx_path = SOURCE_ROOT / PPTX_NAME
    if not pptx_path.exists():
        pytest.skip("the official competition materials are not present in this local workspace")

    fragments = extract_pptx_fragments(
        pptx_path.read_bytes(),
        project_id="case-2",
        source_id="case-2-pptx",
        filename=PPTX_NAME,
    )
    header, rows = _purchase_rows(fragments)
    assert len(rows) == 14

    compilation = _build_compilation(header, rows)
    result = verify_project_total(compilation)

    # Our arithmetic agrees with the sum the document's own rows add up to.
    assert Decimal(result.computed_sum) == ROW_SUM

    # The unrounded rows explain the total the document states.
    unrounded = _unrounded_sum(header, rows)
    assert unrounded == UNROUNDED_SUM
    assert unrounded.quantize(Decimal("0.01")) == STATED_TOTAL

    # So the 0.02 万元 gap is the rounding of the row budgets.
    assert result.classification == "ROUNDING"
    assert Decimal(result.difference or "0") == STATED_TOTAL - ROW_SUM


def test_case2_total_fixture_agrees_with_the_official_document():
    """The synthetic fixture the CI uses matches the official reading."""
    rows = [
        ["新采", "通用超清轻智能语音对讲云台探头", "5000", "125", "145", "70.62", "13%"],
        ["新采", "通用超清轻智能磁吸监测探头", "6000", "165", "195", "111.87", "13%"],
        ["新采", "通用超清中智能音柱一体球形探头", "4000", "275", "320", "124.30", "13%"],
        ["新采", "通用超清中智能移动监测探头", "5000", "485", "565", "274.02", "13%"],
        ["新采", "通用超清轻智能饲喂观察探头", "4000", "235", "275", "106.22", "13%"],
        ["增补", "通用超清云台探头", "8000", "82", "96", "74.13", "13%"],
        ["增补", "通用超清枪式探头", "8000", "92", "108", "83.17", "13%"],
        ["增补", "通用超清轻智能枪式探头", "200000", "106", "124", "2395.60", "13%"],
        ["增补", "通用超清轻智能半球探头", "25000", "146", "170", "412.45", "13%"],
        ["增补", "通用超清轻智能4G探头", "25000", "265", "309", "748.62", "13%"],
        ["增补", "通用超清轻智能4G探头（标准版）", "15000", "140", "164", "237.30", "13%"],
        ["增补", "通用超清轻智能4G探头（本地存储版）", "5000", "188", "220", "106.22", "13%"],
        ["增补", "通用超清轻智能4G探头（60W太阳能版）", "5000", "905", "1045", "511.32", "13%"],
        ["增补", "通用超清轻智能4G探头（80W太阳能版）", "5000", "1120", "1295", "632.80", "13%"],
    ]
    header = [
        "采购类型",
        "产品名称",
        "预估/框架数量（套）",
        "预计采购单价（元/套）",
        "预计销售单价（元/套）",
        "含税总预算（万元）",
        "税率",
    ]
    compilation = _build_compilation(header, rows)
    result = verify_project_total(compilation)
    assert Decimal(result.computed_sum) == ROW_SUM
    assert result.classification == "ROUNDING"
    assert result.difference == "0.02"
    assert _unrounded_sum(header, rows) == UNROUNDED_SUM


def test_a_total_that_no_row_explains_is_a_source_difference():
    rows = [["新采", "某设备", "100", "10", "12", "0.13", "13%"]]
    header = [
        "采购类型",
        "产品名称",
        "预估/框架数量（套）",
        "预计采购单价（元/套）",
        "预计销售单价（元/套）",
        "含税总预算（万元）",
        "税率",
    ]
    compilation = _build_compilation(header, rows)
    compilation.conflicts[0].values_with_source = [
        ConflictValue(
            value="0.13万元",
            source_ref="pptx:slide=6:table=1:row=2",
            source_quote="0.13",
        ),
        ConflictValue(
            value="9.00万元",
            source_ref="pptx:slide=2:table=1:row=1",
            source_quote="9.00万元",
        ),
    ]
    result = verify_project_total(compilation)
    assert result.classification == "SOURCE_DIFFERENCE"
