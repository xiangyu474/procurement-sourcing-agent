"""Run the M3-Q1 check live: does the compiler turn a stated specification
into a constraint, and does the verification classify the project total.

The script reads the local test material and the official case 2 presentation
when they are present, and prints the constraints and the verification
findings. It never writes to D1 or R2 and never prints a key.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv
from pptx import Presentation
from pptx.util import Inches

from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.ingestion.pptx import extract_pptx_fragments
from procurement_agent.services.demand_intake import build_demand_intake

SOURCE_ROOT = (
    Path(__file__).resolve().parents[2]
    / "参赛要求与官方资料"
    / "命题赛道素材_已解压"
    / "命题赛道素材"
    / "寻价比源素材"
    / "2"
)
CASE_TWO = "智能视觉感知探头生产采购项目_v2.pptx"
PRODUCT_NAME = "5MP 工业网络摄像机"


def test_requirement_pptx() -> bytes:
    """Build the small presentation the M2 acceptance uses."""
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
    textbox.text_frame.text = (
        f"采购需求：{PRODUCT_NAME}，采购数量 10 套，预计采购单价 100 元/套。"
    )
    table = slide.shapes.add_table(2, 3, Inches(1), Inches(2), Inches(6), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "采购数量（套）"
    table.cell(0, 2).text = "预计采购单价（元/套）"
    table.cell(1, 0).text = PRODUCT_NAME
    table.cell(1, 1).text = "10"
    table.cell(1, 2).text = "100"
    buffer = Path("m3q-check.pptx")
    presentation.save(buffer)
    data = buffer.read_bytes()
    buffer.unlink()
    return data


def _describe(intake) -> dict:
    return {
        "requirements": len(intake.requirements),
        "constraints": [
            {
                "requirement_id": requirement.requirement_id,
                "product_name": requirement.product_name,
                "quantity": requirement.quantity,
                "attribute_key": constraint.attribute_key,
                "operator": constraint.operator.value,
                "value": constraint.value,
                "unit": constraint.unit,
                "importance": constraint.importance.value,
                "parse_status": constraint.parse_status.value,
                "source_quote": constraint.source_quote,
                "validation_issues": constraint.validation_issues,
            }
            for requirement in intake.requirements
            for constraint in requirement.constraints
        ],
        "unstructured_count": len(intake.unstructured_requirements),
        "issues": intake.issues[:12],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-two", action="store_true", help="also compile the official case 2 presentation")
    args = parser.parse_args()

    load_dotenv()
    settings = load_settings()
    if not settings.has_llm:
        print(json.dumps({"status": "BLOCKED", "reason": "GENESIS_* is not configured"}))
        return 2

    model = build_chat_model(settings, timeout=600)
    report: dict[str, object] = {"status": "OK"}

    fragments = extract_pptx_fragments(
        test_requirement_pptx(),
        project_id="m3q-check",
        source_id="m3q-check",
        filename="m3q-check.pptx",
    )
    intake = build_demand_intake(
        project_id="m3q-check",
        fragments=fragments,
        model=model,
    )
    report["test_material"] = _describe(intake)

    if args.case_two:
        path = SOURCE_ROOT / CASE_TWO
        if not path.exists():
            report["case_two"] = {"status": "SKIPPED", "reason": "the official file is not present"}
        else:
            case_fragments = extract_pptx_fragments(
                path.read_bytes(),
                project_id="official-case-2",
                source_id="official-case-2",
                filename=CASE_TWO,
            )
            case_intake = build_demand_intake(
                project_id="official-case-2",
                fragments=case_fragments,
                model=model,
            )
            described = _describe(case_intake)
            described["conflicts"] = [
                {
                    "field": conflict.field,
                    "values": [value.value for value in conflict.values_with_source],
                }
                for conflict in case_intake.conflicts
            ]
            report["case_two"] = described

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
