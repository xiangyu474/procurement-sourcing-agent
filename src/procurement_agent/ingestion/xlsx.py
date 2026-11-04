"""Optional historical purchase workbook importer.

This module is deliberately separate from PPTX/text demand parsing. A workbook
is never required to create or parse demand, and imported supplier identifiers
remain in a history-only namespace (especially for the official synthetic
competition data).
"""

from __future__ import annotations

import hashlib
import re
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
from typing import Any

import openpyxl

from procurement_agent.domain.requirements import HistoricalTransaction, HistoryImportResult

MAX_XLSX_BYTES = 32 * 1024 * 1024
MAX_HEADER_SCAN_ROWS = 30


class HistoryFileRejected(ValueError):
    """The workbook cannot be read as a historical purchase table.

    The reason is written for a buyer to read, and it carries a code the
    gateway can pass on without exposing an exception class.
    """

    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message

FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "order_id": ("采购订单号", "订单号", "采购单号", "采购订单"),
    "line_id": ("订单行号", "行号", "采购订单行号"),
    "order_date": ("订单日期", "采购日期", "下单日期"),
    "sku": ("产品编码", "SKU", "物料编码", "商品编码"),
    "product_name": ("产品名称", "品名", "物料名称", "商品名称"),
    "specification": ("规格型号", "规格", "型号"),
    "supplier_code": ("供应商编码", "供应商代码", "供应商编号"),
    "supplier_name": ("供应商名称", "供应商"),
    "quantity": ("采购数量（套）", "采购数量", "数量", "订单数量"),
    "unit_price_ex_tax": ("不含税单价（元/套）", "不含税单价", "未税单价"),
    "amount_ex_tax": ("不含税金额（元）", "不含税金额", "未税金额"),
    "tax_rate": ("税率", "税率（%）"),
    "tax_amount": ("税额（元）", "税额"),
    "amount_inc_tax": ("含税金额（元）", "含税金额", "价税合计"),
    "currency": ("币种", "货币"),
}


def _norm(value: Any) -> str:
    """Normalize a cell for header matching only."""
    return re.sub(r"\s+", "", str(value or "")).replace("\u3000", "")


def _find_header(sheet: Any) -> tuple[int, list[str]]:
    """Find a likely table header among the first 30 rows."""
    alias_sets = {key: {_norm(alias) for alias in aliases} for key, aliases in FIELD_ALIASES.items()}
    best: tuple[int, int, list[str]] | None = None
    for row_number, row in enumerate(
        sheet.iter_rows(min_row=1, max_row=MAX_HEADER_SCAN_ROWS, values_only=True),
        start=1,
    ):
        headers = [_norm(value) for value in row]
        found = {
            key for key, aliases in alias_sets.items() if any(header in aliases for header in headers)
        }
        # To avoid matching title/disclaimer rows, require order identity and
        # at least one product field plus quantity.
        required = {"order_id", "quantity"}
        product_field = bool(found & {"sku", "product_name"})
        if not required.issubset(found) or not product_field:
            continue
        score = len(found)
        candidate = (score, row_number, headers)
        if best is None or candidate[0] > best[0]:
            best = candidate
    if best is None:
        raise ValueError("could not locate a row containing order id, product, and quantity headers")
    return best[1], best[2]


def _field_map(headers: list[str]) -> dict[str, int]:
    result: dict[str, int] = {}
    for index, header in enumerate(headers):
        if not header:
            continue
        for field, aliases in FIELD_ALIASES.items():
            if header in {_norm(alias) for alias in aliases}:
                result.setdefault(field, index)
    return result


def _string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    text = str(value).strip()
    return text or None


def _serializable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def import_historical_xlsx(
    file_bytes: bytes,
    *,
    project_id: str,
    source_file_name: str,
    source_file_id: str,
    previously_imported_hashes: set[str] | None = None,
) -> HistoryImportResult:
    """Parse a workbook and preserve row-level provenance.

    The function performs no network access and never merges history suppliers
    with public suppliers. Re-importing identical bytes yields the same dataset
    id and an explicit duplicate flag.
    """
    if len(file_bytes) > MAX_XLSX_BYTES:
        raise HistoryFileRejected(
            "history_file_too_large",
            f"历史数据文件超过 {MAX_XLSX_BYTES // (1024 * 1024)}MB 上限。",
        )
    if not file_bytes.startswith(b"PK"):
        raise HistoryFileRejected("history_file_not_a_workbook", "这个文件不是 Excel 工作簿。")

    digest = hashlib.sha256(file_bytes).hexdigest()
    # Dataset identity is workspace/project scoped: the same file imported to
    # two projects must not collide in D1 or leak one project's provenance into
    # another project's history namespace.
    dataset_id = "hist_" + hashlib.sha256(f"{project_id}:{digest}".encode()).hexdigest()[:24]
    duplicate = digest in (previously_imported_hashes or set())
    try:
        workbook = openpyxl.load_workbook(BytesIO(file_bytes), read_only=True, data_only=True)
    except HistoryFileRejected:
        raise
    except Exception as exc:
        raise HistoryFileRejected(
            "history_file_unreadable",
            "这个 Excel 文件无法打开，可能已损坏或不是标准的工作簿。",
        ) from exc

    chosen: tuple[Any, int, list[str], dict[str, int]] | None = None
    for sheet in workbook.worksheets:
        try:
            header_row, headers = _find_header(sheet)
        except ValueError:
            continue
        chosen = (sheet, header_row, headers, _field_map(headers))
        break
    if chosen is None:
        raise HistoryFileRejected(
            "history_file_header_not_found",
            "工作表没有可用的表头：需要采购订单号、产品名称和数量这些列。",
        )

    sheet, header_row, normalized_headers, mapping = chosen
    # Read the original header cells, not the normalized names, for stored rows.
    original_header_row = next(
        sheet.iter_rows(min_row=header_row, max_row=header_row, values_only=True)
    )
    headers = [str(value).strip() if value is not None else "" for value in original_header_row]
    width = len(headers)

    disclaimer_parts: list[str] = []
    for row in sheet.iter_rows(min_row=1, max_row=min(header_row - 1, 7), values_only=True):
        disclaimer_parts.extend(str(value) for value in row if value is not None)
    disclaimer = " ".join(disclaimer_parts)
    is_synthetic = any(marker in disclaimer for marker in ("模拟数据", "均为虚构", "虚构"))
    supplier_namespace = "HISTORICAL_SUPPLIER_SIMULATED" if is_synthetic else "HISTORICAL_SUPPLIER_INTERNAL"

    transactions: list[HistoricalTransaction] = []
    warnings: list[str] = []
    for excel_row, row in enumerate(sheet.iter_rows(min_row=header_row + 1, values_only=True), start=header_row + 1):
        if not any(value is not None and str(value).strip() for value in row):
            continue
        cells = list(row[:width])
        if len(cells) < width:
            cells.extend([None] * (width - len(cells)))
        raw_values = {
            headers[index] or f"column_{index + 1}": _serializable(value)
            for index, value in enumerate(cells)
        }

        def value_for(field: str) -> Any:
            index = mapping.get(field)
            return cells[index] if index is not None and index < len(cells) else None

        order_id = _string(value_for("order_id"))
        line_id = _string(value_for("line_id"))
        supplier_code = _string(value_for("supplier_code"))
        supplier_name = _string(value_for("supplier_name"))
        # Preserve the simulated namespace in entity ids; never join on name.
        supplier_entity_id = (
            f"{supplier_namespace}:{project_id}:{dataset_id}:{supplier_code or 'UNKNOWN'}"
            if supplier_code or supplier_name
            else None
        )
        transaction_id = f"{dataset_id}:{order_id or 'UNKNOWN'}:{line_id or excel_row}"

        transactions.append(
            HistoricalTransaction(
                transaction_id=transaction_id,
                dataset_id=dataset_id,
                project_id=project_id,
                source_row_ref=f"xlsx:source={source_file_id}:file={source_file_name}:sheet={sheet.title}:row={excel_row}",
                order_id=order_id,
                line_id=line_id,
                order_date=_string(value_for("order_date")),
                sku=_string(value_for("sku")),
                product_name=_string(value_for("product_name")),
                specification=_string(value_for("specification")),
                supplier_code=supplier_code,
                supplier_display_name=supplier_name,
                supplier_entity_id=supplier_entity_id,
                supplier_namespace=supplier_namespace,
                is_synthetic_supplier=is_synthetic,
                quantity=_string(value_for("quantity")),
                unit_price_ex_tax=_string(value_for("unit_price_ex_tax")),
                amount_ex_tax=_string(value_for("amount_ex_tax")),
                tax_rate=_string(value_for("tax_rate")),
                tax_amount=_string(value_for("tax_amount")),
                amount_inc_tax=_string(value_for("amount_inc_tax")),
                currency=_string(value_for("currency")),
                raw_values=raw_values,
            )
        )

    if not transactions:
        warnings.append("No non-empty transaction rows found after the detected header.")
    if width != 38 and is_synthetic:
        warnings.append(f"Official sample expected 38 columns; found {width}.")
    if is_synthetic:
        warnings.append("Supplier names/contracts/trade statuses are labeled as simulated; never identity-match by name.")

    return HistoryImportResult(
        dataset_id=dataset_id,
        project_id=project_id,
        source_file_name=source_file_name,
        sha256=digest,
        sheet_name=sheet.title,
        header_row=header_row,
        column_count=width,
        row_count=len(transactions),
        is_synthetic=is_synthetic,
        supplier_namespace=supplier_namespace,
        schema_mapping_version="history-map-m1-0.1.0",
        duplicate_import=duplicate,
        warnings=warnings,
        transactions=transactions,
    )
