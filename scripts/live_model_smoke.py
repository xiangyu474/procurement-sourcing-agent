"""Live capability check for the configured chat model endpoint.

This is intentionally a live probe, not a mock: it verifies ordinary chat, a
bounded context request, raw tool calling, real Deep Agents tool execution,
and Pydantic structured output against the configured provider. It never
prints credential values.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime

from dotenv import load_dotenv
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from procurement_agent.agents.sourcing import create_sourcing_agent


class SmokeResult(BaseModel):
    """Small schema used only for the structured-output capability check."""

    ok: bool = Field(description="Whether the requested check passed")
    message: str


@tool
def smoke_tool(value: str) -> str:
    """Return a fixed result to verify tool schema handling."""
    return f"tool-ok:{value}"


def main() -> int:
    load_dotenv()
    required = ("GENESIS_BASE_URL", "GENESIS_ACCESS_TOKEN", "GENESIS_MODEL_ID")
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        print(json.dumps({"status": "BLOCKED", "missing_env": missing}, ensure_ascii=False))
        return 2

    model = ChatOpenAI(
        base_url=os.environ["GENESIS_BASE_URL"],
        api_key=os.environ["GENESIS_ACCESS_TOKEN"],
        model=os.environ["GENESIS_MODEL_ID"],
        timeout=45,
        max_retries=0,
    )
    trace: dict[str, object] = {
        "started_at": datetime.now(UTC).isoformat(),
        "provider": "OpenAI-compatible chat endpoint",
        "model": os.environ["GENESIS_MODEL_ID"],
    }
    try:
        response = model.invoke("Reply with exactly: plain-ok")
        trace["plain_chat"] = "PASS" if "plain-ok" in str(response.content) else "UNEXPECTED_RESPONSE"

        context_payload = "Context: " + ("bounded context probe " * 512)
        context_response = model.invoke(f"{context_payload}\nReturn exactly CONTEXT-OK.")
        trace["context_probe_chars"] = len(context_payload)
        trace["context_probe"] = "PASS" if "CONTEXT-OK" in str(context_response.content) else "FAIL"

        tool_response = model.bind_tools([smoke_tool]).invoke(
            "Call smoke_tool exactly once with value='trace' and do not answer directly."
        )
        calls = getattr(tool_response, "tool_calls", []) or []
        trace["tool_calling"] = "PASS" if any(c.get("name") == "smoke_tool" for c in calls) else "FAIL"

        agent_result = create_sourcing_agent(model).invoke(
            {
                "messages": [
                    {"role": "user", "content": "Call hello_tool exactly once with message='m0-live'."}
                ]
            },
            config={"recursion_limit": 10},
        )
        tool_results = [
            str(message.content)
            for message in agent_result.get("messages", [])
            if isinstance(message, ToolMessage) and message.name == "hello_tool"
        ]
        trace["deep_agent_tool_execution"] = "PASS" if "hello: m0-live" in tool_results else "FAIL"
        trace["deep_agent_tool_result"] = tool_results[-1] if tool_results else None

        structured = model.with_structured_output(SmokeResult, method="function_calling").invoke(
            "Return a SmokeResult with ok=true and message='structured-ok'."
        )
        trace["structured_output"] = "PASS" if structured.ok and structured.message else "FAIL"
        trace["completed_at"] = datetime.now(UTC).isoformat()
        trace["status"] = (
            "PASS"
            if all(
                trace.get(key) == "PASS"
                for key in (
                    "plain_chat",
                    "context_probe",
                    "tool_calling",
                    "deep_agent_tool_execution",
                    "structured_output",
                )
            )
            else "FAIL"
        )
    except Exception as exc:
        trace.update(
            status="FAIL",
            failed_at=datetime.now(UTC).isoformat(),
            error_type=type(exc).__name__,
            error=str(exc).replace(os.environ["GENESIS_ACCESS_TOKEN"], "[REDACTED]")[:500],
        )
    print(json.dumps(trace, ensure_ascii=False, indent=2))
    return 0 if trace.get("status") == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
