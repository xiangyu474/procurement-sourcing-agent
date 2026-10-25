"""Deterministic extraction of tabular procurement demand from PPTX fragments.

This parser maps table columns by header meaning rather than slide number. It
extracts explicit values only; product names do not imply technical specs.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation

from procurement_agent.domain.requirements import (
    ConflictValue,
    DataConflict,
    PlannedAmount,
    Requirement,
    SourceFragment,
    TaxBasis,
)

CELL_LOCATOR = re.compile(r":slide=(\d+):table=(\d+):row=(\d+):cell=(\d+)$")
PRODUCT_HEADERS = ("产品名称", "品名", "采购品项", "设备名称", "物料名称")
QUANTITY_HEADERS = ("采购数量", "预估/框架数量", "预计采购数量", "数量（", "数量(")
PRICE_HEADERS = ("预估采购单价", "预计采购单价", "计划采购单价", "采购单价")
SALES_HEADERS = ("预估销售单价", "预计销售单价", "计划销售单价")
BUDGET_HEADERS = ("含税总预算", "项目预算", "总预算")
TAX_HEADERS = ("税率",)
CATEGORY_HEADERS = ("产品分类", "采购类型", "品类", "产品类别")
SKU_HEADERS = ("产品编码", "sku", "物料编码", "商品编码")


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text).replace("\u3000", "").lower()


def _find_column(headers: list[str], aliases: tuple[str, ...]) -> int | None:
    normalized = [_norm(value) for value in headers]
    for index, header in enumerate(normalized):
        if any(_norm(alias) in header for alias in aliases):
            return index
    return None


def extract_summary_quantity_conflicts(
    fragments: list[SourceFragment],
    *,
    project_id: str,
) -> list[DataConflict]:
    """Preserve competing project procurement-summary quantities.

    The extractor only compares explicit labels such as “采购数量” or “本次
    短名单采购计划” to the value in the same summary-table column. It also
    captures explicit narrative procurement totals. Market-capacity figures
    alone are not treated as purchase demand. Scope remains unresolved until
    a user or later analysis confirms the figures refer to the same quantity.
    """
    quantity_pattern = re.compile(r"(?P<value>\d+(?:\.\d+)?)\s*(?P<scale>万|千)?\s*(?P<unit>台|套|件|个)")
    claims_by_value: dict[str, ConflictValue] = {}
    tables: dict[tuple[str, str, str], dict[int, dict[int, SourceFragment]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for fragment in fragments:
        match = CELL_LOCATOR.search(fragment.locator)
        if match:
            slide, table, row, cell = match.groups()
            tables[(fragment.source_id, slide, table)][int(row)][int(cell)] = fragment
            continue
        # Narrative totals must explicitly describe procurement, not merely
        # market capacity or historical sales volume.
        if not any(cue in fragment.text for cue in ("本次拟", "采购数量", "采购计划", "预计采购", "拟采购")):
            continue
        for match in quantity_pattern.finditer(fragment.text):
            value = f"{match.group('value')}{match.group('scale') or ''}{match.group('unit')}"
            claims_by_value.setdefault(
                value,
                ConflictValue(value=value, source_ref=fragment.locator, source_quote=match.group(0)),
            )

    label_cues = ("采购数量", "采购计划", "本次采购", "短名单采购")
    for rows in tables.values():
        # Exclude detail tables: those have product+quantity column headers and
        # represent separate SKUs, not project summary totals.
        table_cells = [cell for row in rows.values() for cell in row.values()]
        header_text = " ".join(cell.text for cell in rows.get(1, {}).values())
        if any(term in header_text for term in PRODUCT_HEADERS) and any(
            term in header_text for term in QUANTITY_HEADERS
        ):
            continue
        for row_number, cells in rows.items():
            for column_number, label_cell in cells.items():
                if not any(cue in label_cell.text for cue in label_cues):
                    continue
                # Summary tables commonly put values above their labels. Check
                # adjacent rows in the same column, keeping exact cell refs.
                for value_row in (row_number - 1, row_number + 1):
                    value_cell = rows.get(value_row, {}).get(column_number)
                    if not value_cell:
                        continue
                    match = quantity_pattern.search(value_cell.text)
                    if not match:
                        continue
                    value = f"{match.group('value')}{match.group('scale') or ''}{match.group('unit')}"
                    claims_by_value.setdefault(
                        value,
                        ConflictValue(
                            value=value,
                            source_ref=value_cell.locator,
                            source_quote=match.group(0),
                            source_refs=[value_cell.locator, label_cell.locator],
                        ),
                    )

    claims = list(claims_by_value.values())
    distinct_values = {claim.value for claim in claims}
    if len(distinct_values) < 2:
        return []
    unit_suffixes = {re.sub(r"^[0-9.]+", "", value) for value in distinct_values}
    if len(unit_suffixes) != 1:
        return []
    digest = hashlib.sha256("|".join(sorted(distinct_values)).encode("utf-8")).hexdigest()[:20]
    return [
        DataConflict(
            conflict_id=f"ppt_summary_qty_{digest}",
            project_id=project_id,
            field="summary_procurement_quantity_claims",
            values_with_source=claims,
            severity="REVIEW_SCOPE",
            status="UNRESOLVED",
        )
    ]


def _money_value(text: str) -> str | None:
    cleaned = text.replace(",", "").strip()
    match = re.search(r"[-+]?\d+(?:\.\d+)?", cleaned)
    if not match:
        return None
    try:
        return str(Decimal(match.group(0)))
    except InvalidOperation:
        return None


def _unit_from_header(header: str) -> str | None:
    match = re.search(r"[（(]([^）)]+)[）)]", header)
    return match.group(1).strip() if match else None


def extract_requirement_rows_from_pptx(
    fragments: list[SourceFragment],
    *,
    project_id: str,
    revision: int = 1,
) -> list[Requirement]:
    """Convert recognizable procurement tables into Requirements.

    A table is accepted only when a row contains both a product-name header and
    a quantity header. Other presentation tables remain source evidence but are
    not guessed to be purchase line items.
    """
    grouped: dict[tuple[str, str, str], dict[int, dict[int, SourceFragment]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for fragment in fragments:
        match = CELL_LOCATOR.search(fragment.locator)
        if not match:
            continue
        slide, table, row, cell = match.groups()
        grouped[(fragment.source_id, slide, table)][int(row)][int(cell)] = fragment

    requirements: list[Requirement] = []
    for (source_id, _slide, table_index), rows in grouped.items():
        header_row_number: int | None = None
        product_column: int | None = None
        quantity_column: int | None = None
        header_cells: dict[int, SourceFragment] = {}
        for row_number in sorted(rows)[:8]:
            candidate = rows[row_number]
            width = max(candidate, default=0)
            headers = [candidate.get(index).text if index in candidate else "" for index in range(1, width + 1)]
            product_column = _find_column(headers, PRODUCT_HEADERS)
            quantity_column = _find_column(headers, QUANTITY_HEADERS)
            if product_column is not None and quantity_column is not None:
                header_row_number = row_number
                header_cells = candidate
                # _find_column uses zero-based positions; source table cells are
                # one-based. Convert here and keep all later indexing explicit.
                product_column += 1
                quantity_column += 1
                break
        if header_row_number is None or product_column is None or quantity_column is None:
            continue

        width = max(header_cells, default=0)
        headers = [header_cells[i].text if i in header_cells else "" for i in range(1, width + 1)]
        price_column = _find_column(headers, PRICE_HEADERS)
        sales_column = _find_column(headers, SALES_HEADERS)
        budget_column = _find_column(headers, BUDGET_HEADERS)
        tax_column = _find_column(headers, TAX_HEADERS)
        category_column = _find_column(headers, CATEGORY_HEADERS)
        sku_column = _find_column(headers, SKU_HEADERS)
        # Header lookups above are zero-based; table row maps are one-based.
        price_column = price_column + 1 if price_column is not None else None
        sales_column = sales_column + 1 if sales_column is not None else None
        budget_column = budget_column + 1 if budget_column is not None else None
        tax_column = tax_column + 1 if tax_column is not None else None
        category_column = category_column + 1 if category_column is not None else None
        sku_column = sku_column + 1 if sku_column is not None else None
        quantity_unit = _unit_from_header(headers[quantity_column - 1])
        previous_category: str | None = None
        previous_category_ref: str | None = None

        for row_number in sorted(rows):
            if row_number <= header_row_number:
                continue
            row = rows[row_number]
            product_cell = row.get(product_column)
            product_name = product_cell.text.strip() if product_cell else ""
            if not product_name:
                continue
            quantity_cell = row.get(quantity_column)
            quantity = _money_value(quantity_cell.text) if quantity_cell else None
            category_cell = row.get(category_column) if category_column else None
            if category_cell and category_cell.text.strip():
                previous_category = category_cell.text.strip()
                previous_category_ref = category_cell.locator

            source_refs = [cell.locator for cell in row.values()]
            if previous_category_ref and previous_category_ref not in source_refs:
                source_refs.append(previous_category_ref)
            requirement_id = "req_" + hashlib.sha256(
                f"{source_id}|table={table_index}|row={row_number}|{product_name}".encode("utf-8")
            ).hexdigest()[:20]
            open_questions: list[str] = []
            parse_status = "RESOLVED"
            if quantity is None:
                open_questions.append("采购数量未能从表格单元格解析。")
                parse_status = "AMBIGUOUS"

            price = _planned_amount(
                row, price_column, headers, kind="PLANNED_PRICE", tax_basis=TaxBasis.UNKNOWN,
                tax_rate_cell=row.get(tax_column) if tax_column else None,
            )
            sales_price = _planned_amount(
                row, sales_column, headers, kind="PLANNED_SALES_PRICE", tax_basis=TaxBasis.UNKNOWN,
                tax_rate_cell=row.get(tax_column) if tax_column else None,
            )
            total_budget = _planned_amount(
                row, budget_column, headers, kind="PLANNED_BUDGET", tax_basis=TaxBasis.INCLUSIVE,
                tax_rate_cell=row.get(tax_column) if tax_column else None,
            )
            sku_cell = row.get(sku_column) if sku_column else None

            requirements.append(
                Requirement(
                    requirement_id=requirement_id,
                    project_id=project_id,
                    revision=revision,
                    match_key=re.sub(r"[\W_]+", "", product_name.casefold()),
                    product_name=product_name,
                    product_category=previous_category,
                    source_product_code=sku_cell.text.strip() if sku_cell and sku_cell.text.strip() else None,
                    quantity=quantity,
                    quantity_unit=quantity_unit,
                    planned_unit_price=price,
                    planned_sales_unit_price=sales_price,
                    planned_total_budget=total_budget,
                    tax_rate=(row.get(tax_column).text.strip() if tax_column and row.get(tax_column) else None),
                    constraints=[],
                    source_refs=source_refs,
                    parse_status=parse_status,
                    open_questions=open_questions,
                )
            )

    return requirements


def _planned_amount(
    row: dict[int, SourceFragment],
    column: int | None,
    headers: list[str],
    *,
    kind: str,
    tax_basis: TaxBasis,
    tax_rate_cell: SourceFragment | None,
) -> PlannedAmount | None:
    if column is None:
        return None
    cell = row.get(column)
    if cell is None:
        return None
    value = _money_value(cell.text)
    if value is None:
        return None
    header = headers[column - 1]
    if "不含税" in header or "未税" in header:
        tax_basis = TaxBasis.EXCLUSIVE
    elif "含税" in header:
        tax_basis = TaxBasis.INCLUSIVE
    return PlannedAmount(
        kind=kind,
        value=value,
        currency="CNY",
        unit=_unit_from_header(header),
        tax_basis=tax_basis,
        tax_rate=tax_rate_cell.text.strip() if tax_rate_cell else None,
        source_ref=cell.locator,
        source_quote=cell.text,
    )
