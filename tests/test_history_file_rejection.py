"""A workbook that cannot be read is rejected with a reason a buyer can read."""

from __future__ import annotations

from io import BytesIO

import openpyxl
import pytest

from procurement_agent.ingestion.xlsx import HistoryFileRejected, import_historical_xlsx


def _workbook(rows: list[list[str]]) -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    for row in rows:
        sheet.append(row)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_a_workbook_without_a_usable_header_is_rejected_with_a_reason() -> None:
    bytes_ = _workbook([["随便写的一行"], ["还是无法识别"]])
    with pytest.raises(HistoryFileRejected) as error:
        import_historical_xlsx(bytes_, project_id="p1", source_file_name="history.xlsx", source_file_id="s1")
    assert error.value.reason_code == "history_file_header_not_found"
    assert "表头" in error.value.message
    assert "Exception" not in error.value.message


def test_a_file_that_is_not_a_workbook_is_rejected() -> None:
    with pytest.raises(HistoryFileRejected) as error:
        import_historical_xlsx(b"not a workbook", project_id="p1", source_file_name="history.xlsx", source_file_id="s1")
    assert error.value.reason_code == "history_file_not_a_workbook"
    assert "Excel" in error.value.message


def test_a_broken_workbook_is_rejected_without_a_parser_error() -> None:
    with pytest.raises(HistoryFileRejected) as error:
        import_historical_xlsx(b"PK\x03\x04broken", project_id="p1", source_file_name="history.xlsx", source_file_id="s1")
    assert error.value.reason_code == "history_file_unreadable"
    assert "无法打开" in error.value.message
