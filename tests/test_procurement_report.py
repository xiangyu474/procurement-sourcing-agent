"""Tests for the formal procurement report.

The report is what a buyer reads, so the tests read it too: they open the
document that was produced and check that the facts, the caveats, and the
divisions are all there.
"""

from __future__ import annotations

import io

from docx import Document

from procurement_agent.reports.procurement_report import ReportInput, build_procurement_docx


def report_input() -> ReportInput:
    return ReportInput(
        project_id="p1",
        project_title="工业相机采购",
        run_id="run-1",
        demand_revision=2,
        decision_version="abc123",
        requirements=[
            {
                "requirement_id": "r1",
                "product_name": "5MP 工业网络摄像机",
                "quantity": "10",
                "quantity_unit": "套",
                "planned_unit_price": {"value": "500", "currency": "CNY", "unit": "元/套"},
                "constraints": [
                    {
                        "constraint_id": "c1",
                        "attribute_key": "output_resolution",
                        "attribute_definition": "视频输出分辨率",
                        "operator": "GTE",
                        "value": "5",
                        "unit": "MP",
                        "importance": "HARD",
                        "source_quote": "输出分辨率 ≥ 5MP",
                    }
                ],
                "open_questions": ["5MP 是标称档位还是最低像素数？"],
            }
        ],
        candidates=[
            {
                "candidate_id": "cand1",
                "requirement_id": "r1",
                "supplier_name": "甲供应商",
                "product_model": "CAM-A",
                "stage": "RFQ_SHORTLIST",
                "evidence_ids": ["ev1"],
            },
            {
                "candidate_id": "cand2",
                "requirement_id": "r1",
                "supplier_name": "乙供应商",
                "product_model": "CAM-B",
                "stage": "NEEDS_VERIFICATION",
                "evidence_ids": ["ev2"],
            },
            {
                "candidate_id": "cand3",
                "requirement_id": "r1",
                "supplier_name": "丙供应商",
                "product_model": "CAM-C",
                "stage": "EXCLUDED",
                "evidence_ids": ["ev3"],
            },
        ],
        assessments=[
            {
                "requirement_id": "r1",
                "product_candidate_id": "cand1",
                "product_model_ref": "CAM-A",
                "hard_spec_overall": "PASS",
                "overall_reason_codes": ["VERIFIED_COMPARISON"],
                "checks": [
                    {
                        "constraint_id": "c1",
                        "status": "PASS",
                        "reason_code": "VERIFIED_COMPARISON",
                        "operation": "5 MP GTE 5 MP",
                        "explanation": "output_resolution is 5 MP and the requirement asks GTE 5 MP: PASS",
                        "evidence_ids": ["ev1"],
                    }
                ],
            },
            {
                "requirement_id": "r1",
                "product_candidate_id": "cand2",
                "product_model_ref": "CAM-B",
                "hard_spec_overall": "UNKNOWN",
                "overall_reason_codes": ["ATTRIBUTE_NOT_ALIGNED"],
                "checks": [
                    {
                        "constraint_id": "c1",
                        "status": "UNKNOWN",
                        "reason_code": "ATTRIBUTE_NOT_ALIGNED",
                        "operation": "",
                        "explanation": "the claim does not state the output resolution",
                        "evidence_ids": [],
                    }
                ],
            },
            {
                "requirement_id": "r1",
                "product_candidate_id": "cand3",
                "product_model_ref": "CAM-C",
                "hard_spec_overall": "FAIL",
                "overall_reason_codes": ["VERIFIED_COMPARISON"],
                "checks": [
                    {
                        "constraint_id": "c1",
                        "status": "FAIL",
                        "reason_code": "VERIFIED_COMPARISON",
                        "operation": "4 MP GTE 5 MP",
                        "explanation": "the output is 4 MP",
                        "evidence_ids": ["ev3"],
                    }
                ],
            },
        ],
        decisions=[
            {
                "requirement_id": "r1",
                "product_candidate_id": "cand1",
                "product_model_ref": "CAM-A",
                "recommendation": "SHORTLIST",
                "technical_verdict": "VERIFIED_PASS",
                "hard_spec_overall": "PASS",
                "accepted": True,
                "rationale": "输出分辨率满足硬约束",
                "gaps": [],
                "next_actions": ["索取正式报价"],
                "evidence_ids": ["ev1"],
                "priority_rank": 1,
            },
            {
                "requirement_id": "r1",
                "product_candidate_id": "cand2",
                "product_model_ref": "CAM-B",
                "recommendation": "INVESTIGATE",
                "technical_verdict": "UNVERIFIED",
                "hard_spec_overall": "UNKNOWN",
                "accepted": True,
                "rationale": "证据不足",
                "gaps": ["来源没有说明输出分辨率"],
                "next_actions": ["向供应商索取输出分辨率规格"],
                "evidence_ids": ["ev2"],
            },
            {
                "requirement_id": "r1",
                "product_candidate_id": "cand3",
                "product_model_ref": "CAM-C",
                "recommendation": "EXCLUDE",
                "technical_verdict": "VERIFIED_FAIL",
                "hard_spec_overall": "FAIL",
                "accepted": True,
                "rationale": "硬约束不满足",
                "gaps": [],
                "next_actions": [],
                "evidence_ids": ["ev3"],
            },
        ],
        price_contexts=[
            {
                "requirement_id": "r1",
                "scope": "TABLE_OVERVIEW",
                "scope_note": "The imported history holds 14 other items.",
                "statistics": None,
                "overview_statistics": {
                    "count": 1000,
                    "minimum": "77",
                    "median": "113",
                    "mean": "171.51",
                    "maximum": "1255",
                    "currency": "CNY",
                    "unit": "元/台",
                },
                "findings": [],
                "notes": ["These rows are not a price baseline for this requirement."],
            }
        ],
        evidence=[
            {
                "evidence_id": "ev1",
                "title": "产品规格",
                "url": "https://example.invalid/cam-a",
                "quote": "Output resolution: 5 MP",
                "content_sha256": "a" * 64,
            }
        ],
        open_questions=["5MP 是标称档位还是最低像素数？"],
    )


def document_of(data: ReportInput):
    document = Document(io.BytesIO(build_procurement_docx(data)))
    return document


def table_text(table) -> str:
    return "\n".join(cell.text for row in table.rows for cell in row.cells)


def all_text(document) -> str:
    parts = [paragraph.text for paragraph in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                parts.append(cell.text)
    return "\n".join(parts)


def test_rejected_shortlist_is_not_shown_as_inquiry_advice() -> None:
    data = report_input()
    data.decisions[0]["accepted"] = False
    data.decisions[0]["violations"] = ["HARD_FAIL"]
    doc = document_of(data)
    heading_index = next(i for i, p in enumerate(doc.paragraphs) if p.text == "建议询价（技术核对通过）")
    assert doc.paragraphs[heading_index + 1].text == "（无）"
    assert "[未采纳] CAM-A" in all_text(doc)


def test_frozen_price_context_uses_real_dto_fields() -> None:
    data = report_input()
    data.price_contexts = [{
        "requirement_id": "r1", "history_scope": "ITEM",
        "history": {"scope_note": "confirmed", "statistics": {"count": 1, "minimum": "88", "currency": "CNY", "unit": "元/套"}},
        "findings": [{"lowest_basis": "HISTORICAL_TRANSACTION", "lowest_value": "88", "saving": "12", "comparability": "COMPARABLE"}],
    }]
    text = all_text(document_of(data))
    assert "历史成交价" in text
    assert "88" in text
    assert "12" in text


def test_the_report_names_the_project_the_run_and_the_decision_version() -> None:
    document = document_of(report_input())
    text = all_text(document)

    assert "采购寻源技术与价格分析报告" in text
    assert "工业相机采购" in text
    assert "run-1" in text
    assert "abc123" in text


def test_the_report_states_the_demand_with_its_source() -> None:
    text = all_text(document_of(report_input()))

    assert "5MP 工业网络摄像机" in text
    assert "output_resolution" in text
    assert "输出分辨率 ≥ 5MP" in text


def test_the_report_keeps_the_three_verdicts_apart() -> None:
    text = all_text(document_of(report_input()))

    assert "通过" in text
    assert "未知（证据不足）" in text
    assert "不通过" in text


def test_a_long_list_is_not_written_as_a_qualified_list() -> None:
    """The candidates that did not pass are not in the advice to inquire."""
    document = document_of(report_input())
    text = all_text(document)

    assert "长名单不是合格名单" in text
    assert "待补充证据（不进入本轮询价）" in text
    assert "建议询价（技术核对通过）" in text

    # CAM-B is UNKNOWN, so it must not appear in the table of the advice to
    # inquire, and CAM-C must not appear there either.
    advice = [
        table
        for table in document.tables
        if [cell.text for cell in table.rows[0].cells][:2] == ["型号", "供应商"]
        and "CAM-A" in table_text(table)
    ]
    assert advice, "the table of the advice to inquire is missing"
    advice_text = table_text(advice[0])
    assert "CAM-B" not in advice_text
    assert "CAM-C" not in advice_text

    investigate = [
        table
        for table in document.tables
        if [cell.text for cell in table.rows[0].cells][:2] == ["型号", "供应商"]
        and "CAM-B" in table_text(table)
    ]
    assert investigate, "the table of the candidates that need evidence is missing"
    assert "CAM-A" not in table_text(investigate[0])


def test_the_price_section_states_the_scope_of_every_number() -> None:
    text = all_text(document_of(report_input()))

    assert "全表概览" in text
    assert "不能作为本品的比价、排名或节支依据" in text
    assert "not a price baseline" in text


def test_the_report_lists_the_open_questions_and_the_gaps() -> None:
    text = all_text(document_of(report_input()))

    assert "未解决问题与下一步" in text
    assert "5MP 是标称档位还是最低像素数？" in text
    assert "来源没有说明输出分辨率" in text


def test_the_report_lists_the_evidence_with_its_hash() -> None:
    text = all_text(document_of(report_input()))

    assert "证据引用" in text
    assert "ev1" in text
    assert "a" * 16 in text


def test_the_report_is_a_word_document() -> None:
    data = build_procurement_docx(report_input())

    assert data[:2] == b"PK"
    assert len(data) > 10_000
