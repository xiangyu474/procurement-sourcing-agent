"""Live M1 smoke check: text demand -> source-grounded Requirement DSL."""

from __future__ import annotations

import json
import sys

from dotenv import load_dotenv

from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.ingestion.compiler import compile_requirement_fragments
from procurement_agent.ingestion.text import extract_text_fragments


def main() -> int:
    load_dotenv()
    settings = load_settings()
    if not settings.has_llm:
        print(json.dumps({"status": "BLOCKED", "reason": "GENESIS_* is not configured"}))
        return 2

    text = "采购电源模块100台，额定输出功率至少7.5kW，最好支持CAN接口。"
    fragments = extract_text_fragments("m1-live-smoke", 1, text)
    try:
        result = compile_requirement_fragments(
            project_id="m1-live-smoke",
            fragments=fragments,
            model=build_chat_model(settings),
            revision=1,
        )
        payload = result.compilation.model_dump(mode="json")
        payload["grounding_issues"] = list(result.grounding_issues)
        payload["status"] = "PASS" if result.compilation.requirements else "NO_REQUIREMENT"
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if payload["status"] == "PASS" else 1
    except Exception as exc:
        print(json.dumps({"status": "FAIL", "error_type": type(exc).__name__, "error": str(exc)[:600]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
