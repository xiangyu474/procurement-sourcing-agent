"""Measure the same evaluation twice: the first run fills the cache, the second
reads it. The point is the difference in model calls, tokens, and time."""

from __future__ import annotations

import io
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
os.environ["LANGSMITH_TRACING"] = "false"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(".env", override=True)
os.environ["LANGSMITH_TRACING"] = "false"
sys.path.insert(0, "scripts")

from live_m3_spec_evaluation import _candidates, _claims, _models, _run_project  # noqa: E402
from live_m3_token_profile import TokenCounter  # noqa: E402
from pptx import Presentation  # noqa: E402
from pptx.util import Inches  # noqa: E402

from procurement_agent.infra import load_settings  # noqa: E402
from procurement_agent.infra.llm import build_chat_model  # noqa: E402
from procurement_agent.ingestion.pptx import extract_pptx_fragments  # noqa: E402
from procurement_agent.services.demand_intake import build_demand_intake  # noqa: E402
from procurement_agent.services.judgment_cache import InMemoryJudgmentCache  # noqa: E402
from procurement_agent.services.spec_evaluation import evaluate_candidates  # noqa: E402


def material() -> bytes:
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
    textbox.text_frame.text = (
        "采购需求：5MP 工业网络摄像机，支持ONVIF协议，采购数量 10 套，预计采购单价 100 元/套。"
    )
    table = slide.shapes.add_table(2, 3, Inches(1), Inches(2), Inches(6), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "采购数量（套）"
    table.cell(0, 2).text = "预计采购单价（元/套）"
    table.cell(1, 0).text = "5MP 工业网络摄像机"
    table.cell(1, 1).text = "10"
    table.cell(1, 2).text = "100"
    buffer = io.BytesIO()
    presentation.save(buffer)
    return buffer.getvalue()


def main() -> int:
    settings = load_settings()
    run_id = "4ca31b39-a755-4794-af49-20954ccfdbe3"
    project_id = _run_project(run_id)
    fragments = extract_pptx_fragments(
        material(), project_id="m3-cache", source_id="m3-cache", filename="m3-cache.pptx"
    )
    intake = build_demand_intake(
        project_id="m3-cache",
        fragments=fragments,
        model=build_chat_model(settings, timeout=600),
    )
    candidates = _candidates(project_id)
    claims = _claims(project_id)
    models = _models(project_id)
    evidence_hashes = {
        claim.evidence_id: "hash-" + claim.evidence_id for claim in claims
    }

    cache = InMemoryJudgmentCache()
    report = {"run_id": run_id, "candidates": len(candidates), "claims": len(claims)}
    for attempt in (1, 2):
        counter = TokenCounter()
        model = build_chat_model(
            settings,
            timeout=settings.model_timeout_seconds,
            temperature=settings.model_temperature,
        )
        typing_model = build_chat_model(
            settings,
            timeout=settings.model_timeout_seconds,
            reasoning_effort=settings.model_reasoning_effort,
            temperature=settings.model_temperature,
        )
        started = time.monotonic()
        assessments = evaluate_candidates(
            requirements=intake.requirements,
            candidates=candidates,
            claims=claims,
            model=model,
            model_by_product=models,
            evidence=evidence_hashes,
            evidence_hashes=evidence_hashes,
            typing_model=typing_model,
            cache=cache,
            config={"callbacks": [counter]},
            source_run_id=run_id,
            source_project_id=project_id,
            model_config={"model": settings.llm_model, "temperature": settings.model_temperature},
        )
        elapsed = time.monotonic() - started
        summary = counter.summary()
        report[f"attempt_{attempt}"] = {
            "wall_seconds": round(elapsed, 1),
            "model_calls": summary["calls"],
            "prompt_tokens": summary["prompt_tokens"],
            "completion_tokens": summary["completion_tokens"],
            "by_stage": summary["by_stage"],
            "assessments": len(assessments),
            "by_overall": {
                key: len([item for item in assessments if item.hard_spec_overall.value == key])
                for key in sorted({item.hard_spec_overall.value for item in assessments})
            },
        }
    report["cache_entries"] = len(cache.entries)
    report["cache_conflicts"] = len(cache.conflicts)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
