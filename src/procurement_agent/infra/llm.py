"""Chat model adapter for the configured OpenAI-compatible endpoint.

The endpoint, model id, and key all come from the environment. Structured
output is requested through function calling because the endpoint may return
fenced JSON in its default mode, which Pydantic cannot parse.
"""

from __future__ import annotations

import json
import re
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.utils.function_calling import convert_to_openai_function
from langchain_openai import ChatOpenAI

from procurement_agent.infra import Settings


def build_chat_model(settings: Settings, *, timeout: int = 45) -> ChatOpenAI:
    """Create the chat model client from environment-backed settings."""
    if not settings.has_llm:
        raise RuntimeError(
            "chat model is not configured: set GENESIS_BASE_URL, GENESIS_ACCESS_TOKEN, and GENESIS_MODEL_ID"
        )
    return ChatOpenAI(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
        timeout=timeout,
        max_retries=0,
    )


def structured(model: ChatOpenAI, schema: Any) -> Any:
    """Bind a Pydantic schema using function-calling structured output."""
    return model.with_structured_output(schema, method="function_calling")


def stream_tool_call(
    model: BaseChatModel,
    messages: list[Any],
    schema: Any,
    *,
    max_tokens: int = 32_000,
    config: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Return the arguments of every tool call and the text the model wrote.

    The gateway drops long non-streaming requests, so the call is streamed and
    the tool call arguments are accumulated. The tool call is required, which
    is the form this endpoint answers in a schema. The model sometimes answers
    a long document with one call per item, so every call is returned.
    """
    tool = convert_to_openai_function(schema)
    bound = model.bind_tools([tool], tool_choice=tool["name"])
    aggregated: Any = None
    for chunk in bound.stream(messages, config={"max_tokens": max_tokens, **(config or {})}):
        aggregated = chunk if aggregated is None else aggregated + chunk
    if aggregated is None:
        raise ValueError("The model returned no response")
    calls = getattr(aggregated, "tool_calls", None) or []
    payloads: list[dict[str, Any]] = []
    for call in calls:
        arguments = call.get("args")
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        if not isinstance(arguments, dict):
            raise ValueError("The tool call arguments must be a JSON object")
        payloads.append(arguments)
    content = getattr(aggregated, "content", "")
    return payloads, content if isinstance(content, str) else ""


def stream_tool_arguments(
    model: BaseChatModel,
    messages: list[Any],
    schema: Any,
    *,
    max_tokens: int = 32_000,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Collect the arguments of every tool call in a streamed response."""
    payloads, _text = stream_tool_call(
        model, messages, schema, max_tokens=max_tokens, config=config
    )
    if not payloads:
        raise ValueError("The model did not call the required tool")
    return payloads


def json_object_from_text(text: str) -> dict[str, Any] | None:
    """Read a JSON object from a message, alone or inside a fenced block.

    The model sometimes answers with prose that carries the answer as a JSON
    block instead of calling the tool.
    """
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            value = None
        if isinstance(value, dict):
            return value
    for block in re.findall(r"```(?:json)?\s*(.*?)```", text, re.DOTALL):
        try:
            value = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None
