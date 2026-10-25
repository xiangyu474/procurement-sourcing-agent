"""Run live requirement DSL compilation against the official PPTX cases.

The official PPTX/XLSX files stay in the parent workspace and are never
copied into or committed to this repository. This script only reads the PPTX
files and prints parsed product names, constraint counts, and source locators.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.ingestion.pptx import extract_pptx_fragments, select_pptx_narrative_fragments
from procurement_agent.services.demand_intake import build_demand_intake

SOURCE_ROOT = (
    Path(__file__).resolve().parents[2]
    / "参赛要求与官方资料"
    / "命题赛道素材_已解压"
    / "命题赛道素材"
    / "寻价比源素材"
)
CASES = {
    "1": "智能视频采集终端生产采购项目_v1.pptx",
    "2": "智能视觉感知探头生产采购项目_v2.pptx",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=("1", "2", "all"), default="all")
    args = parser.parse_args()

    load_dotenv()
    settings = load_settings()
    if not settings.has_llm:
        print(json.dumps({"status": "BLOCKED", "reason": "GENESIS_* is not configured"}))
        return 2

    model = build_chat_model(settings, timeout=180)
    results = []
    cases = CASES.items() if args.case == "all" else [(args.case, CASES[args.case])]
    for case, filename in cases:
        path = SOURCE_ROOT / case / filename
        if not path.exists():
            print(json.dumps({"status": "BLOCKED", "missing_file": str(path)}, ensure_ascii=False))
            return 2
        fragments = extract_pptx_fragments(
            path.read_bytes(),
            project_id=f"official-case-{case}",
            source_id=f"official-pptx-{case}",
            filename=filename,
        )
        narrative_fragments = select_pptx_narrative_fragments(fragments)
        intake = build_demand_intake(
            project_id=f"official-case-{case}",
            fragments=fragments,
            model=model,
            analysis_version=1,
        )
        detail = {
            "case": case,
            "slides": 7,
            "extracted_fragments": len(fragments),
            "narrative_compiler_fragments": len(narrative_fragments),
            "narrative_compiler_chars": sum(len(f.text) for f in narrative_fragments),
            "requirements": len(intake.requirements),
            "products": [requirement.product_name for requirement in intake.requirements],
            "constraint_count": sum(len(r.constraints) for r in intake.requirements),
            "unstructured_count": len(intake.unstructured_requirements),
            "conflicts": [conflict.model_dump(mode="json") for conflict in intake.conflicts],
            "issues": intake.issues,
        }
        results.append(detail)
        print(json.dumps(detail, ensure_ascii=False, indent=2))

    expected = 14
    status = "PASS" if all(item["requirements"] == expected for item in results) else "PARTIAL"
    print(json.dumps({"official_ppt_dsl_status": status, "expected_purchase_line_items_per_case": expected}, ensure_ascii=False))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
