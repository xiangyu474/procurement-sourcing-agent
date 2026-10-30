"""Measure the model tokens that the M3-A evaluation spends on real data.

The run reads the real M2 output from D1, runs the typing, the alignment, and
the calculation, and reports the tokens per stage. The price per token is not
exposed by the model gateway, so this report is the input for the money
budget rather than the budget itself.

Usage:
    uv run --python 3.11 python scripts/live_m3_token_profile.py --run <run_id>
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langchain_core.callbacks import BaseCallbackHandler

from procurement_agent.domain.requirements import Requirement
from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.services.spec_evaluation import evaluate_candidates

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_m3_spec_evaluation import _candidates, _claims, _d1, _models, _run_project  # noqa: E402


class TokenCounter(BaseCallbackHandler):
    """Counts the tokens and the seconds of every model call."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self._started: float | None = None

    def on_llm_start(self, serialized: dict[str, Any], prompts: list[Any], **kwargs: Any) -> None:
        self._started = time.monotonic()

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        # A streamed answer reports its usage in the result, not on the message.
        usage: Any = None
        llm_output = getattr(response, "llm_output", None)
        if isinstance(llm_output, dict):
            usage = llm_output.get("token_usage") or llm_output.get("usage")
        if not isinstance(usage, dict):
            for group in getattr(response, "generations", []) or []:
                for generation in group:
                    message_usage = getattr(getattr(generation, "message", None), "usage_metadata", None)
                    if isinstance(message_usage, dict):
                        usage = message_usage
                        break
                if isinstance(usage, dict):
                    break
        prompt = usage.get("prompt_tokens", usage.get("input_tokens", 0)) if isinstance(usage, dict) else 0
        completion = usage.get("completion_tokens", usage.get("output_tokens", 0)) if isinstance(usage, dict) else 0
        self.calls.append(
            {
                "prompt_tokens": int(prompt or 0),
                "completion_tokens": int(completion or 0),
                "usage_observed": isinstance(usage, dict),
                "seconds": round(time.monotonic() - (self._started or time.monotonic()), 1),
            }
        )

    def summary(self) -> dict[str, Any]:
        prompt = sum(call["prompt_tokens"] for call in self.calls)
        completion = sum(call["completion_tokens"] for call in self.calls)
        seconds = sum(call["seconds"] for call in self.calls)
        return {
            "calls": len(self.calls),
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "seconds": round(seconds, 1),
            "per_call": {
                "prompt_tokens": round(prompt / len(self.calls)) if self.calls else 0,
                "completion_tokens": round(completion / len(self.calls)) if self.calls else 0,
                "seconds": round(seconds / len(self.calls), 1) if self.calls else 0,
            },
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True, help="a finished M2 run ID")
    args = parser.parse_args()

    load_dotenv(".env")
    settings = load_settings()
    if not settings.has_llm:
        print(json.dumps({"status": "BLOCKED", "reason": "GENESIS_* is not configured"}))
        return 2

    project_id = _run_project(args.run)
    candidates = _candidates(project_id)
    claims = _claims(project_id)
    models = _models(project_id)
    requirements = _requirements_for(project_id)

    counter = TokenCounter()
    model = build_chat_model(settings, timeout=settings.model_timeout_seconds)
    assessments = evaluate_candidates(
        requirements=requirements,
        candidates=candidates,
        claims=claims,
        model=model,
        model_by_product=models,
        typing_batch_size=settings.spec_typing_batch_size,
        alignment_batch_size=settings.spec_alignment_candidates,
        config={"callbacks": [counter]},
    )
    report = {
        "status": "OK",
        "run_id": args.run,
        "project_id": project_id,
        "requirements": len(requirements),
        "candidates": len(candidates),
        "claims": len(claims),
        "assessments": len(assessments),
        "settings": {
            "spec_typing_batch_size": settings.spec_typing_batch_size,
            "spec_alignment_candidates": settings.spec_alignment_candidates,
            "model_timeout_seconds": settings.model_timeout_seconds,
            "model_max_output_tokens": settings.model_max_output_tokens,
        },
        "tokens": counter.summary(),
        "note": "The model gateway exposes no price per token, so no money figure is claimed here.",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _requirements_for(project_id: str) -> list[Requirement]:
    """Read the compiled demand of a project from D1."""
    rows = _d1(
        "SELECT compilation_json FROM demand_compilations "
        f"WHERE project_id = '{project_id}' ORDER BY demand_revision DESC LIMIT 1"
    )
    if not rows:
        return []
    compilation = json.loads(rows[0]["compilation_json"])
    return [Requirement.model_validate(item) for item in compilation.get("requirements") or []]


if __name__ == "__main__":
    sys.exit(main())
