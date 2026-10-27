"""Report building for sourcing runs.

Report content is generated from structured, verified findings only. The M0
spike ships a minimal builder; the full report builder is added in the report
slice of the plan.
"""

from __future__ import annotations

import io
from datetime import UTC, datetime

from docx import Document


def build_spike_docx(run_id: str, stages: list[tuple[str, str]]) -> bytes:
    """Return a DOCX that proves document generation works end to end.

    The document is intentionally factual: it lists the run identifier and the
    stage transitions that actually executed, and it carries an explicit
    draft disclaimer.
    """
    document = Document()
    document.add_heading("采购寻源调查与参考比价报告（DRAFT / 部署验证草稿）", level=0)

    paragraph = document.add_paragraph()
    paragraph.add_run("生成时间：").bold = True
    paragraph.add_run(datetime.now(UTC).isoformat())

    paragraph = document.add_paragraph()
    paragraph.add_run("运行标识：").bold = True
    paragraph.add_run(run_id)

    document.add_heading("说明", level=1)
    document.add_paragraph(
        "本文件为 M0 部署验证草稿，仅记录本次运行的阶段流转。"
        "尚未执行公开检索、规格核验或价格比对，不构成供应商准入、报价结论或定标建议。"
    )

    document.add_heading("阶段记录", level=1)
    table = document.add_table(rows=1, cols=3)
    table.style = "Table Grid"
    header = table.rows[0].cells
    header[0].text = "序号"
    header[1].text = "阶段"
    header[2].text = "说明"
    for index, (stage, detail) in enumerate(stages, start=1):
        cells = table.add_row().cells
        cells[0].text = str(index)
        cells[1].text = stage
        cells[2].text = detail

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
