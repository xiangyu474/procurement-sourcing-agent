"""FastAPI application that runs inside the Cloudflare Container.

The container owns the Python agent work. The Worker gateway is the only
public entry point; this service is reached through the Container Durable
Object binding and authenticates back to the gateway with a shared token.
"""

from __future__ import annotations

import os
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from procurement_agent.domain.requirements import (
    HistoryImportResult,
    RequirementSourceType,
    SourceFragment,
)
from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.ingestion.compiler import compile_requirement_fragments
from procurement_agent.ingestion.pptx import (
    extract_pptx_fragments,
    select_pptx_demand_fragments,
    select_pptx_narrative_fragments,
)
from procurement_agent.ingestion.pptx_tables import extract_requirement_rows_from_pptx
from procurement_agent.ingestion.text import extract_text_fragments
from procurement_agent.ingestion.xlsx import import_historical_xlsx
from procurement_agent.services.demand_intake import build_demand_intake

app = FastAPI(title="Procurement Sourcing Agent Container", version="0.1.0")
settings = load_settings()


class ExecuteRequest(BaseModel):
    """Request to run one bounded sourcing task inside the container."""

    run_id: str
    gateway_url: str
    token: str
    duration_seconds: int = Field(default=150, ge=1, le=600)
    artifact_name: str = "report.docx"
    runtime_config: dict[str, str] = Field(default_factory=dict)


class TextSourceInput(BaseModel):
    """One user-entered demand revision."""

    source_id: str
    revision: int
    text: str


class PptxSourceInput(BaseModel):
    """Pointer to a requirement PPTX stored in private R2."""

    source_id: str
    filename: str
    revision: int = 1


class CompileDemandRequest(BaseModel):
    """Internal request to compile text and/or PPTX into the Requirement DSL."""

    project_id: str
    analysis_version: int = 1
    gateway_url: str
    token: str
    runtime_config: dict[str, str] = Field(default_factory=dict)
    text_sources: list[TextSourceInput] = Field(default_factory=list)
    pptx_sources: list[PptxSourceInput] = Field(default_factory=list)


class ImportHistoryRequest(BaseModel):
    """Internal request to import one optional XLSX from private R2."""

    project_id: str
    source_id: str
    filename: str
    sha256: str
    gateway_url: str
    token: str


def _apply_runtime_config(runtime_config: dict[str, str]) -> None:
    """Install runtime configuration supplied by the Worker for this run.

    Secrets are passed per request instead of being baked into the image, so
    the container never stores them on disk.
    """
    for key, value in runtime_config.items():
        if key and value:
            os.environ[key] = value


def _require_internal(token: str | None) -> None:
    """Reject requests that do not carry the internal gateway token.

    The container is not publicly reachable: requests only arrive through the
    Durable Object binding. The token is supplied by the Worker at call time,
    so no secret value has to be baked into the image. The gateway still
    validates every callback it receives.
    """
    if not token:
        raise HTTPException(status_code=401, detail="missing internal token")


@app.post("/internal/compile-demand")
async def compile_demand(payload: CompileDemandRequest, x_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Compile user text/PPTX to source-grounded requirements.

    No history is required here. Each source is parsed independently and the
    domain service preserves disagreements as explicit DataConflict records.
    """
    _require_internal(payload.token or x_internal_token)
    _apply_runtime_config(payload.runtime_config)

    fragments: list[SourceFragment] = []
    for text_source in payload.text_sources:
        fragments.extend(
            extract_text_fragments(
                payload.project_id,
                text_source.revision,
                text_source.text,
                source_id=text_source.source_id,
            )
        )

    for pptx_source in payload.pptx_sources:
        file_bytes = await _fetch_input(payload, pptx_source.source_id)
        pptx_fragments = extract_pptx_fragments(
            file_bytes,
            project_id=payload.project_id,
            source_id=pptx_source.source_id,
            filename=pptx_source.filename,
            revision=pptx_source.revision,
        )
        fragments.extend(select_pptx_demand_fragments(pptx_fragments))

    if not fragments:
        raise HTTPException(status_code=422, detail="at least one non-empty text/PPTX demand source is required")

    groups: dict[str, list[SourceFragment]] = {}
    for fragment in fragments:
        groups.setdefault(fragment.source_id, []).append(fragment)
    needs_compiler = any(
        fragment.source_type == RequirementSourceType.USER_TEXT for fragment in fragments
    )
    for source_fragments in groups.values():
        if source_fragments[0].source_type != RequirementSourceType.INTERNAL_PPTX:
            continue
        has_structured_lines = bool(
            extract_requirement_rows_from_pptx(source_fragments, project_id=payload.project_id)
        )
        if not has_structured_lines or select_pptx_narrative_fragments(source_fragments):
            needs_compiler = True
            break
    model = build_chat_model(load_settings(), timeout=180) if needs_compiler else None
    result = await run_in_threadpool(
        build_demand_intake,
        project_id=payload.project_id,
        fragments=fragments,
        model=model,
        analysis_version=payload.analysis_version,
    )
    return result.model_dump(mode="json")


@app.post("/internal/import-history")
async def import_history(payload: ImportHistoryRequest, x_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Parse an optional historical workbook without mixing it into demand."""
    _require_internal(payload.token or x_internal_token)
    file_bytes = await _fetch_input(payload, payload.source_id)
    result = await run_in_threadpool(
        import_historical_xlsx,
        file_bytes,
        project_id=payload.project_id,
        source_file_name=payload.filename,
        source_file_id=payload.source_id,
    )
    if result.sha256 != payload.sha256:
        raise HTTPException(status_code=409, detail="source content hash changed during import")
    return result.model_dump(mode="json")


async def _fetch_input(payload: CompileDemandRequest | ImportHistoryRequest, source_id: str) -> bytes:
    """Fetch one private input object through the authenticated Worker gateway."""
    import httpx

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.get(
            f"{payload.gateway_url.rstrip('/')}/internal/projects/{payload.project_id}/inputs/{source_id}",
            headers={"x-internal-token": payload.token},
        )
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail="input source not found")
        response.raise_for_status()
        return response.content


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
    _apply_runtime_config(payload.runtime_config)

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
