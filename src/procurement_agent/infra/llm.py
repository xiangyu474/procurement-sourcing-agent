"""Chat model adapter for the configured OpenAI-compatible endpoint.

The endpoint, model id, and key all come from the environment. Structured
output is requested through function calling because the endpoint may return
fenced JSON in its default mode, which Pydantic cannot parse.
"""

from __future__ import annotations

from typing import Any

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
