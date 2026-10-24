"""FastAPI application that runs inside the Cloudflare Container.

The container owns the Python agent work. The Worker gateway is the only
public entry point; this service is reached through the Container Durable
Object binding and authenticates back to the gateway with a shared token.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from procurement_agent.infra import load_settings

app = FastAPI(title="Procurement Sourcing Agent Container", version="0.1.0")
settings = load_settings()


class ExecuteRequest(BaseModel):
    """Request to run one bounded sourcing task inside the container."""

    run_id: str
    gateway_url: str
    token: str
    duration_seconds: int = Field(default=150, ge=1, le=600)
    artifact_name: str = "report.docx"


def _require_internal(token: str | None) -> None:
    """Reject requests that do not carry the internal gateway token."""
    expected = settings.internal_gateway_token
    if not expected:
        raise HTTPException(status_code=503, detail="INTERNAL_GATEWAY_TOKEN is not configured")
    if token != expected:
        raise HTTPException(status_code=401, detail="invalid internal token")


@app.get("/health")
def health() -> dict[str, Any]:
    """Report container readiness without exposing configuration values."""
    return {
        "status": "ok",
        "llm_configured": settings.has_llm,
        "search_configured": bool(settings.tavily_api_key),
        "max_search_calls": settings.max_search_calls,
    }


@app.post("/internal/execute")
async def execute(payload: ExecuteRequest, x_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Run a bounded task, stream stage events, and persist one DOCX artifact.

    This is the M0 spike endpoint: it proves a multi-minute task survives
    without a browser connection, that progress is visible through the
    gateway, and that a real document can be written to object storage.
    """
    _require_internal(payload.token or x_internal_token)

    from procurement_agent.reports import build_spike_docx

    stages = [
        ("INGESTING", "需求已解析：1 个采购条目，历史文件未提供"),
        ("INTERNAL_ANALYSIS", "寻源计划已制定；未提供历史数据，已跳过历史统计"),
        ("WEB_RESEARCH", "完成公开渠道调查，长名单 0 家（Spike 未接入检索）"),
        ("MATCHING", "已执行规格核验骨架，UNKNOWN 保持未知"),
        ("VALIDATING", "已复核证据与价格口径，未产生可比较报价"),
        ("REPORTING", "生成报告草稿与 DOCX"),
    ]

    deadline = time.monotonic() + payload.duration_seconds
    per_stage = max(1, payload.duration_seconds // len(stages))

    for stage, detail in stages:
        await _post_event(payload, stage, detail)
        time.sleep(min(per_stage, max(0, deadline - time.monotonic())))
        if time.monotonic() >= deadline:
            break

    document = build_spike_docx(run_id=payload.run_id, stages=stages)
    artifact = await _post_artifact(payload, payload.artifact_name, document)
    return {
        "status": "completed",
        "run_id": payload.run_id,
        "artifact": artifact,
        "duration_seconds": payload.duration_seconds,
    }


async def _post_event(payload: ExecuteRequest, stage: str, detail: str) -> None:
    """Report one stage event to the gateway, ignoring transient failures."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            await client.post(
                f"{payload.gateway_url.rstrip('/')}/internal/runs/{payload.run_id}/events",
                headers={"x-internal-token": payload.token},
                json={"stage": stage, "detail": detail},
            )
    except Exception:  # progress reporting must never abort the run
        return


async def _post_artifact(payload: ExecuteRequest, name: str, document: bytes) -> dict[str, Any]:
    """Upload the generated document to the gateway for R2 persistence."""
    import httpx

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{payload.gateway_url.rstrip('/')}/internal/runs/{payload.run_id}/artifacts",
            headers={"x-internal-token": payload.token},
            content=document,
            params={"name": name, "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
        )
        response.raise_for_status()
        return dict(response.json())
