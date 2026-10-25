"""PPTX text/table extraction with stable slide and cell locators."""

from __future__ import annotations

import re
from collections import defaultdict
from io import BytesIO

from pptx import Presentation

from procurement_agent.domain.requirements import RequirementSourceType, SourceFragment

MAX_PPTX_BYTES = 25 * 1024 * 1024
MAX_EXTRACTED_CHARS = 300_000
MAX_DEMAND_CHARS = 60_000
PRODUCT_HEADERS = ("产品名称", "品名", "采购品项", "设备名称", "物料名称")
QUANTITY_HEADERS = ("采购数量", "预估/框架数量", "预计采购数量", "数量（", "数量(")
PROCUREMENT_CUES = ("采购", "寻源", "需求", "预算", "标的")
EXPLICIT_REQUIREMENT_CUES = (
    "必须", "至少", "不低于", "不得低于", "不超过", "不得超过", "≥", "<=", ">=",
    "应达到", "要求达到", "必须支持", "需要支持", "技术要求", "技术参数", "规格要求", "性能指标",
)
PREFERENCE_CUES = ("最好支持", "优先支持", "优先考虑", "倾向采购", "偏好")
NON_REQUIREMENT_CONTEXT_CUES = ("市场容量", "市场预测", "竞争态势", "客户痛点", "产品优势", "产品介绍", "商业模式", "市场判断")


def extract_pptx_fragments(
    file_bytes: bytes,
    *,
    project_id: str,
    source_id: str,
    filename: str,
    revision: int = 1,
) -> list[SourceFragment]:
    """Extract slide text and table cells from a PPTX with exact locators."""
    if len(file_bytes) > MAX_PPTX_BYTES:
        raise ValueError(f"PPTX exceeds the {MAX_PPTX_BYTES}-byte limit")
    if not file_bytes.startswith(b"PK"):
        raise ValueError("input is not a ZIP-based PPTX document")

    presentation = Presentation(BytesIO(file_bytes))
    fragments: list[SourceFragment] = []
    char_count = 0

    def add(locator: str, text: str) -> None:
        nonlocal char_count
        cleaned = text.strip()
        if not cleaned:
            return
        char_count += len(cleaned)
        if char_count > MAX_EXTRACTED_CHARS:
            raise ValueError("PPTX extracted text exceeds the configured limit")
        fragments.append(
            SourceFragment(
                source_id=source_id,
                source_type=RequirementSourceType.INTERNAL_PPTX,
                locator=locator,
                text=cleaned,
                revision=revision,
            )
        )

    for slide_number, slide in enumerate(presentation.slides, start=1):
        table_number = 0
        for shape_index, shape in enumerate(slide.shapes):
            if shape.has_table:
                table_number += 1
                for row_index, row in enumerate(shape.table.rows, start=1):
                    for col_index, cell in enumerate(row.cells, start=1):
                        add(
                            f"pptx:project={project_id}:source={source_id}:file={filename}:slide={slide_number}:table={table_number}:row={row_index}:cell={col_index}",
                            cell.text,
                        )
            elif shape.has_text_frame:
                for paragraph_index, paragraph in enumerate(shape.text_frame.paragraphs, start=1):
                    add(
                        f"pptx:project={project_id}:source={source_id}:file={filename}:slide={slide_number}:shape={shape_index}:paragraph={paragraph_index}",
                        paragraph.text,
                    )
    return fragments


def select_pptx_demand_fragments(
    fragments: list[SourceFragment],
    *,
    max_chars: int = MAX_DEMAND_CHARS,
) -> list[SourceFragment]:
    """Select detailed requirement tables plus compact procurement summaries.

    Table selection is header-driven rather than tied to page six. This
    function reduces model context; it does not discard the original complete
    extraction, which remains available for source auditing.
    """
    table_groups: dict[tuple[str, str, str], list[SourceFragment]] = defaultdict(list)
    text_fragments: list[SourceFragment] = []
    table_pattern = re.compile(r":slide=(\d+):table=(\d+):row=(\d+):cell=(\d+)$")
    for fragment in fragments:
        match = table_pattern.search(fragment.locator)
        if match:
            slide, table, _, _ = match.groups()
            table_groups[(fragment.source_id, slide, table)].append(fragment)
        else:
            text_fragments.append(fragment)

    selected: list[SourceFragment] = []
    for cells in table_groups.values():
        header_cells = [f.text for f in cells if ":row=1:" in f.locator]
        header_text = " ".join(header_cells)
        if any(h in header_text for h in PRODUCT_HEADERS) and any(h in header_text for h in QUANTITY_HEADERS):
            selected.extend(cells)

    quantity_pattern = re.compile(r"\d+(?:\.\d+)?\s*(?:万台|万套|台|套|件|个)")
    for fragment in text_fragments:
        text = fragment.text
        looks_like_summary = quantity_pattern.search(text) and any(cue in text for cue in PROCUREMENT_CUES)
        looks_like_requirement = any(cue in text for cue in EXPLICIT_REQUIREMENT_CUES)
        if looks_like_summary or looks_like_requirement:
            selected.append(fragment)

    if not selected:
        selected = fragments

    selected_locators = {fragment.locator for fragment in selected}
    output: list[SourceFragment] = []
    used = 0
    for fragment in fragments:
        if fragment.locator not in selected_locators:
            continue
        if used + len(fragment.text) > max_chars and output:
            continue
        output.append(fragment)
        used += len(fragment.text)
    return output


def select_pptx_narrative_fragments(fragments: list[SourceFragment]) -> list[SourceFragment]:
    """Select explicit technical requirement prose, excluding market copy.

    Whole-project totals are audited separately as potential conflicts. They
    are not sent to the compiler as SKU requirements.
    """
    selected: list[SourceFragment] = []
    used = 0
    for fragment in fragments:
        if ":table=" in fragment.locator:
            continue
        text = fragment.text.strip()
        if len(text) < 16:
            continue  # headings such as “采购需求汇报” are not constraints
        has_explicit_constraint = any(cue in text for cue in EXPLICIT_REQUIREMENT_CUES)
        has_explicit_preference = any(cue in text for cue in PREFERENCE_CUES) and any(
            cue in text for cue in ("分辨率", "像素", "功率", "电压", "接口", "协议", "温度", "规格", "型号")
        )
        is_marketing_or_market_context = any(cue in text for cue in NON_REQUIREMENT_CONTEXT_CUES)
        if is_marketing_or_market_context and not has_explicit_constraint:
            continue
        if not (has_explicit_constraint or has_explicit_preference):
            continue
        if used + len(text) > 20_000 and selected:
            continue
        selected.append(fragment)
        used += len(text)
    return selected
