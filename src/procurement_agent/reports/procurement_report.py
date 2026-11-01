"""The formal procurement report.

This is not the deployment draft of M0. It is the document a buyer reads: the
demand, the candidates with their exact models, the technical verdicts with
the calculation that produced them, the prices with the basis they belong to,
the RFQ advice, the open questions, and the evidence the whole thing rests on.

Two rules shape every part of it:

- A long list is not a qualified list. The report says which candidates passed
  a hard check, which ones still need evidence, and which ones are out. A
  verdict of UNKNOWN is never written as a pass.
- A price without its basis is not a price. The historical figures are shown
  with the scope they were computed in, and a catalogue-wide figure is never
  written as the price of one item.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt

VERDICT_LABELS = {
    "PASS": "通过",
    "FAIL": "不通过",
    "UNKNOWN": "未知（证据不足）",
}

RECOMMENDATION_LABELS = {
    "SHORTLIST": "建议询价",
    "INVESTIGATE": "待补充证据",
    "EXCLUDE": "建议排除",
}

STAGE_LABELS = {
    "DISCOVERED_LONG_LIST": "长名单",
    "SCREENED": "已初筛",
    "NEEDS_VERIFICATION": "待核验",
    "RFQ_SHORTLIST": "询价短名单",
    "EXCLUDED": "已排除",
}

PRICE_BASIS_LABELS = {
    "PLANNED_BUDGET": "计划价",
    "HISTORICAL_TRANSACTION": "历史成交价",
    "PUBLIC_REFERENCE": "公开参考价",
    "FORMAL_QUOTATION": "正式报价",
}


@dataclass
class ReportInput:
    """Everything the report is built from.

    The data is plain: the report is built from what the database holds, and
    nothing in it is decided while the document is written.
    """

    project_id: str
    project_title: str
    run_id: str | None = None
    demand_revision: int = 1
    decision_version: str | None = None
    requirements: list[dict[str, Any]] = field(default_factory=list)
    candidates: list[dict[str, Any]] = field(default_factory=list)
    assessments: list[dict[str, Any]] = field(default_factory=list)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    price_contexts: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    calculator_version: str = "0.1.0"
    dsl_version: str = "1.0"
    generated_at: datetime | None = None

    def requirement(self, requirement_id: str) -> dict[str, Any]:
        for item in self.requirements:
            if item.get("requirement_id") == requirement_id:
                return item
        return {}

    def assessment_for(self, requirement_id: str, candidate_id: str) -> dict[str, Any]:
        for item in self.assessments:
            if (
                item.get("requirement_id") == requirement_id
                and item.get("product_candidate_id") == candidate_id
            ):
                return item
        return {}

    def decision_for(self, requirement_id: str, candidate_id: str) -> dict[str, Any]:
        for item in self.decisions:
            if (
                item.get("requirement_id") == requirement_id
                and item.get("product_candidate_id") == candidate_id
            ):
                return item
        return {}


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value)


def _table(document: Document, headers: list[str], rows: list[list[str]]) -> Any:
    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    for index, header in enumerate(headers):
        table.rows[0].cells[index].text = header
    for row in rows:
        cells = table.add_row().cells
        for index, value in enumerate(row):
            cells[index].text = value
    return table


def _money(value: Any, currency: str | None = None, unit: str | None = None) -> str:
    text = _text(value)
    if not text:
        return ""
    return f"{text} {currency or ''} {unit or ''}".strip()


def _requirement_summary(requirement: dict[str, Any]) -> list[str]:
    """The demand of one requirement, with the source of every hard rule."""
    product = _text(requirement.get("product_name")) or "（未命名品项）"
    quantity = _text(requirement.get("quantity"))
    unit = _text(requirement.get("quantity_unit"))
    budget = _text(requirement.get("planned_unit_price") or requirement.get("planned_total_budget"))
    lines = [f"品名：{product}"]
    if quantity:
        lines.append(f"数量：{quantity} {unit}".strip())
    if budget:
        lines.append(f"计划价：{budget}")
    constraints = requirement.get("constraints") or []
    if not constraints:
        lines.append("硬约束：（本需求没有结构化硬约束）")
        return lines
    for constraint in constraints:
        operator = _text(constraint.get("operator"))
        value = _text(constraint.get("value"))
        unit_text = _text(constraint.get("unit"))
        importance = _text(constraint.get("importance")) or "HARD"
        attribute = _text(constraint.get("attribute_key"))
        definition = _text(constraint.get("attribute_definition"))
        quote = _text(constraint.get("source_quote"))
        line = f"[{importance}] {attribute}"
        if definition:
            line += f"（{definition}）"
        line += f"：{operator} {value} {unit_text}".rstrip()
        if quote:
            line += f"；原文：“{quote}”"
        lines.append(line)
    return lines


def _price_section(document: Document, data: ReportInput) -> None:
    document.add_heading("四、价格与口径", level=1)
    document.add_paragraph(
        "价格先说口径，再说数字。不同口径的价格之间不做比较，历史价格只在它所属的品项范围内成立。"
    )
    if not data.price_contexts:
        document.add_paragraph("本项目没有导入历史采购数据，因此没有历史价格基准。")
        return
    for context in data.price_contexts:
        requirement = data.requirement(_text(context.get("requirement_id")))
        document.add_heading(f"品项：{_text(requirement.get('product_name')) or '未命名品项'}", level=2)
        scope = _text(context.get("scope"))
        note = _text(context.get("scope_note"))
        if scope == "ITEM":
            document.add_paragraph(f"历史价格基准范围：本品项（{note}）")
        elif scope == "TABLE_OVERVIEW":
            document.add_paragraph(
                "历史价格基准范围：全表概览（仅供了解采购目录，不能作为本品的比价、排名或节支依据）"
            )
            if note:
                document.add_paragraph(note)
        statistics = context.get("statistics") or {}
        if statistics and scope == "ITEM":
            rows = [
                ["笔数", _text(statistics.get("count"))],
                ["最低", _money(statistics.get("minimum"), statistics.get("currency"), statistics.get("unit"))],
                ["中位数", _money(statistics.get("median"), statistics.get("currency"), statistics.get("unit"))],
                ["均值", _money(statistics.get("mean"), statistics.get("currency"), statistics.get("unit"))],
                ["P25", _money(statistics.get("p25"), statistics.get("currency"), statistics.get("unit"))],
                ["P75", _money(statistics.get("p75"), statistics.get("currency"), statistics.get("unit"))],
                ["最高", _money(statistics.get("maximum"), statistics.get("currency"), statistics.get("unit"))],
                ["采购总量", _text(statistics.get("total_quantity"))],
            ]
            _table(document, ["统计项", "数值"], rows)
        elif statistics:
            document.add_paragraph(
                "全表概览：{count} 笔，最低 {low}，中位 {median}，均值 {mean}，最高 {high}。".format(
                    count=_text(statistics.get("count")),
                    low=_money(statistics.get("minimum"), statistics.get("currency"), statistics.get("unit")),
                    median=_money(statistics.get("median"), statistics.get("currency"), statistics.get("unit")),
                    mean=_money(statistics.get("mean"), statistics.get("currency"), statistics.get("unit")),
                    high=_money(statistics.get("maximum"), statistics.get("currency"), statistics.get("unit")),
                )
            )
        findings = context.get("findings") or []
        if findings:
            rows = []
            for finding in findings:
                basis = _text(finding.get("basis"))
                rows.append(
                    [
                        PRICE_BASIS_LABELS.get(basis, basis),
                        _money(finding.get("lowest"), finding.get("currency"), finding.get("unit")),
                        _money(finding.get("saving"), finding.get("currency"), finding.get("unit")),
                        _text(finding.get("comparability")),
                        _text(finding.get("explanation")),
                    ]
                )
            _table(document, ["口径", "最低价", "节支", "可比性", "说明"], rows)
        else:
            document.add_paragraph("本需求没有产生可比较的价格结论。")
        for note_text in context.get("notes") or []:
            document.add_paragraph(_text(note_text))


def _decision_section(document: Document, data: ReportInput) -> None:
    document.add_heading("五、询价建议", level=1)
    document.add_paragraph(
        "建议分为三档：通过硬约束核对的建议询价；证据不足的待补充证据；其余不建议进入本轮询价。"
        "“采纳”指该条决策通过了程序化闸门并留档，不等于技术合格。"
    )
    groups = {
        "SHORTLIST": [],
        "INVESTIGATE": [],
        "EXCLUDE": [],
    }
    for decision in data.decisions:
        recommendation = _text(decision.get("recommendation")) or "INVESTIGATE"
        groups.setdefault(recommendation, []).append(decision)

    for recommendation, title in (
        ("SHORTLIST", "建议询价（技术核对通过）"),
        ("INVESTIGATE", "待补充证据（不进入本轮询价）"),
        ("EXCLUDE", "建议排除"),
    ):
        rows = []
        for decision in groups.get(recommendation, []):
            candidate = next(
                (
                    item
                    for item in data.candidates
                    if item.get("candidate_id") == decision.get("product_candidate_id")
                ),
                {},
            )
            assessment = data.assessment_for(
                _text(decision.get("requirement_id")), _text(decision.get("product_candidate_id"))
            )
            rows.append(
                [
                    _text(decision.get("product_model_ref")) or _text(candidate.get("product_model")),
                    _text(candidate.get("supplier_name")),
                    VERDICT_LABELS.get(_text(assessment.get("hard_spec_overall")), _text(assessment.get("hard_spec_overall"))),
                    _text(decision.get("priority_rank")),
                    _text(decision.get("rationale")),
                    "；".join(_text(item) for item in (decision.get("gaps") or [])),
                ]
            )
        document.add_heading(title, level=2)
        if not rows:
            document.add_paragraph("（无）")
            continue
        _table(document, ["型号", "供应商", "技术结论", "优先级", "理由", "缺口"], rows)


def _technical_section(document: Document, data: ReportInput) -> None:
    document.add_heading("三、关键技术判定", level=1)
    document.add_paragraph(
        "每条判定都由程序化计算得出：模型负责理解语义，代码负责单位换算与比较。"
        "UNKNOWN 表示证据不足，不代表合格。"
    )
    if not data.assessments:
        document.add_paragraph("本项目没有技术核对结果。")
        return
    for assessment in data.assessments:
        candidate_id = _text(assessment.get("product_candidate_id"))
        candidate = next((item for item in data.candidates if item.get("candidate_id") == candidate_id), {})
        requirement = data.requirement(_text(assessment.get("requirement_id")))
        overall = _text(assessment.get("hard_spec_overall"))
        document.add_heading(
            "{model}（{supplier}）｜{verdict}".format(
                model=_text(assessment.get("product_model_ref"))
                or _text(candidate.get("product_model"))
                or candidate_id,
                supplier=_text(candidate.get("supplier_name")) or "未知供应商",
                verdict=VERDICT_LABELS.get(overall, overall),
            ),
            level=2,
        )
        document.add_paragraph(
            "需求：{product}；结论码：{codes}".format(
                product=_text(requirement.get("product_name")) or "未命名品项",
                codes=", ".join(_text(code) for code in (assessment.get("overall_reason_codes") or [])) or "—",
            )
        )
        rows = []
        for check in assessment.get("checks") or []:
            rows.append(
                [
                    _text(check.get("constraint_id")),
                    _text(check.get("operation")) or "—",
                    VERDICT_LABELS.get(_text(check.get("status")), _text(check.get("status"))),
                    _text(check.get("reason_code")),
                    _text(check.get("explanation")),
                    ", ".join(_text(item) for item in (check.get("evidence_ids") or [])) or "—",
                ]
            )
        if rows:
            _table(document, ["约束", "计算", "结果", "原因码", "说明", "证据"], rows)


def _candidate_section(document: Document, data: ReportInput) -> None:
    document.add_heading("二、候选与型号", level=1)
    document.add_paragraph(
        "下表是本次公开寻源发现的所有候选。长名单不是合格名单：只有技术核对通过并经过程序化闸门的候选才会进入建议询价。"
    )
    rows = []
    for candidate in data.candidates:
        candidate_id = _text(candidate.get("candidate_id"))
        assessment = data.assessment_for(_text(candidate.get("requirement_id")), candidate_id)
        decision = data.decision_for(_text(candidate.get("requirement_id")), candidate_id)
        rows.append(
            [
                _text(candidate.get("supplier_name")) or "未知供应商",
                _text(candidate.get("product_model")) or "（型号未确认）",
                STAGE_LABELS.get(_text(candidate.get("stage")), _text(candidate.get("stage"))),
                VERDICT_LABELS.get(
                    _text(assessment.get("hard_spec_overall")), _text(assessment.get("hard_spec_overall")) or "—"
                ),
                RECOMMENDATION_LABELS.get(_text(decision.get("recommendation")), _text(decision.get("recommendation")) or "—"),
                str(len(candidate.get("evidence_ids") or [])),
            ]
        )
    if rows:
        _table(document, ["供应商", "型号", "阶段", "技术结论", "建议", "证据数"], rows)
    else:
        document.add_paragraph("（没有候选）")


def _evidence_section(document: Document, data: ReportInput) -> None:
    document.add_heading("七、证据引用", level=1)
    document.add_paragraph("每条证据都带有来源地址与内容哈希，报告中出现的结论都可以回到这些快照。")
    rows = []
    for item in data.evidence:
        rows.append(
            [
                _text(item.get("evidence_id")),
                _text(item.get("title")) or _text(item.get("url")),
                _text(item.get("url")),
                _text(item.get("quote"))[:180],
                _text(item.get("content_sha256"))[:16],
            ]
        )
    if rows:
        _table(document, ["证据 ID", "来源", "地址", "摘录", "内容哈希"], rows)
    else:
        document.add_paragraph("（没有证据快照）")


def build_procurement_docx(data: ReportInput) -> bytes:
    """Build the formal procurement report."""
    document = Document()
    style = document.styles["Normal"]
    style.font.size = Pt(10.5)

    title = document.add_heading("采购寻源技术与价格分析报告", level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    moment = data.generated_at or datetime.now(UTC)

    document.add_heading("报告标识", level=1)
    rows = [
        ["项目", data.project_title or data.project_id],
        ["项目编号", data.project_id],
        ["寻源运行", data.run_id or "—"],
        ["需求修订", str(data.demand_revision)],
        ["决策版本", data.decision_version or "—"],
        ["生成时间", moment.isoformat()],
        ["需求 DSL 版本", data.dsl_version],
        ["计算器版本", data.calculator_version],
    ]
    _table(document, ["项", "值"], rows)

    document.add_heading("阅读须知", level=1)
    for line in (
        "本报告只使用已经落库的候选、核对与决策，不包含任何未落库的推测。",
        "技术结论分为通过、不通过、未知三值；未知表示证据不足，不能当作合格。",
        "长名单不等于合格名单，只有“建议询价”一档的候选通过了硬约束核对。",
        "价格按口径分别给出，不同口径之间不做比较，也不产生节支。",
        "历史价格只在它所属的品项范围内成立；全表概览不作为单个产品的比价依据。",
    ):
        document.add_paragraph(line, style="List Bullet")

    document.add_heading("一、需求摘要", level=1)
    if not data.requirements:
        document.add_paragraph("（没有整理出结构化需求）")
    for requirement in data.requirements:
        document.add_heading(
            f"{_text(requirement.get('requirement_id'))}｜{_text(requirement.get('product_name')) or '未命名品项'}",
            level=2,
        )
        for line in _requirement_summary(requirement):
            document.add_paragraph(line, style="List Bullet")

    _candidate_section(document, data)
    _technical_section(document, data)
    _price_section(document, data)
    _decision_section(document, data)

    document.add_heading("六、未解决问题与下一步", level=1)
    open_questions = list(data.open_questions)
    for decision in data.decisions:
        for gap in decision.get("gaps") or []:
            open_questions.append(f"[{_text(decision.get('product_model_ref')) or '候选'}] {_text(gap)}")
        for action in decision.get("next_actions") or []:
            open_questions.append(f"[下一步] {_text(action)}")
    if open_questions:
        for question in open_questions:
            document.add_paragraph(_text(question), style="List Bullet")
    else:
        document.add_paragraph("（没有记录未解决的问题）")

    _evidence_section(document, data)

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
