from procurement_agent.reports import build_spike_docx


def test_spike_docx_is_a_valid_docx_with_stage_rows():
    stages = [("INGESTING", "需求已解析"), ("REPORTING", "生成报告草稿")]
    payload = build_spike_docx(run_id="run-1", stages=stages)

    assert payload[:2] == b"PK"

    from io import BytesIO

    from docx import Document

    document = Document(BytesIO(payload))
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    assert "采购寻源调查与参考比价报告" in text
    assert "run-1" in text
    assert "不构成供应商准入" in text
    assert len(document.tables) == 1
    assert len(document.tables[0].rows) == len(stages) + 1
