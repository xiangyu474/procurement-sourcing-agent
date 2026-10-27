from io import BytesIO

import openpyxl

from procurement_agent.ingestion.xlsx import import_historical_xlsx


def make_book() -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "历史采购明细"
    sheet.append(["说明", "模拟数据，供应商名称、合同和交易状态均为虚构"])
    for _ in range(6):
        sheet.append([None])
    sheet.append(["采购订单号", "订单行号", "产品编码", "产品名称", "采购数量", "供应商编码", "供应商名称"])
    sheet.append(["PO-1", "1", "SKU-1", "枪式摄像机", 20, "S001", "模拟供应商"])
    sheet.append(["PO-1", "2", "SKU-2", "球机", 5, "S008", "另一模拟供应商"])
    stream = BytesIO()
    workbook.save(stream)
    return stream.getvalue()


def test_xlsx_header_is_detected_without_hardcoding_row_8():
    result = import_historical_xlsx(
        make_book(),
        project_id="p1",
        source_file_name="history.xlsx",
        source_file_id="f1",
    )
    assert result.header_row == 8
    assert result.row_count == 2
    assert result.column_count == 7
    assert result.is_synthetic is True
    assert result.supplier_namespace == "HISTORICAL_SUPPLIER_SIMULATED"
    assert result.transactions[0].supplier_entity_id.startswith("HISTORICAL_SUPPLIER_SIMULATED:")
    assert result.transactions[0].source_row_ref.endswith("row=9")


def test_duplicate_history_upload_has_stable_dataset_id_and_duplicate_flag():
    content = make_book()
    first = import_historical_xlsx(
        content, project_id="p1", source_file_name="history.xlsx", source_file_id="f1"
    )
    second = import_historical_xlsx(
        content,
        project_id="p1",
        source_file_name="history-copy.xlsx",
        source_file_id="f2",
        previously_imported_hashes={first.sha256},
    )
    assert first.dataset_id == second.dataset_id
    assert second.duplicate_import is True


def test_same_history_file_in_distinct_projects_has_distinct_dataset_identity():
    content = make_book()
    one = import_historical_xlsx(
        content, project_id="project-one", source_file_name="history.xlsx", source_file_id="f1"
    )
    two = import_historical_xlsx(
        content, project_id="project-two", source_file_name="history.xlsx", source_file_id="f2"
    )
    assert one.sha256 == two.sha256
    assert one.dataset_id != two.dataset_id
    assert one.transactions[0].project_id != two.transactions[0].project_id
