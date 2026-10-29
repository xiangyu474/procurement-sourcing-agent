"""FastAPI application that runs inside the Cloudflare Container.

The container owns the Python agent work. The Worker gateway is the only
public entry point; this service is reached through the Container Durable
Object binding and authenticates back to the gateway with a shared token.
"""

from __future__ import annotations

import os
import time
from dataclasses import replace
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from procurement_agent.domain.requirements import (
    SourceFragment,
)
from procurement_agent.domain.sourcing import ResearchBudget
from procurement_agent.infra import load_settings
from procurement_agent.infra.llm import build_chat_model
from procurement_agent.infra.search import TavilyContentProvider, TavilySearchProvider
from procurement_agent.ingestion.pptx import extract_pptx_fragments
from procurement_agent.ingestion.text import extract_text_fragments
from procurement_agent.ingestion.xlsx import import_historical_xlsx
from procurement_agent.services.demand_intake import build_demand_intake
from procurement_agent.services.sourcing_research import (
    ResearchBudgetExceeded,
    ResearchInputError,
    run_sourcing_research,
    serialize_bundle_for_gateway,
)

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


class ResearchRunRequest(BaseModel):
    """Internal request for one bounded M2 Supervisor/Researcher run."""

    project_id: str
    run_id: str
    gateway_url: str
    token: str
    runtime_config: dict[str, str] = Field(default_factory=dict)
    research_budget: ResearchBudget = Field(
        default_factory=lambda: ResearchBudget(
            max_search_calls=4, max_fetches=4, max_tasks=2, max_rounds=2, max_model_calls=15
        )
    )


class SpecEvaluationRequest(BaseModel):
    """Internal request for the M3-A technical check of one project."""

    project_id: str
    gateway_url: str
    token: str
    runtime_config: dict[str, str] = Field(default_factory=dict)
    requirement_ids: list[str] = Field(default_factory=list, max_length=50)
    candidate_ids: list[str] = Field(default_factory=list, max_length=300)


def _apply_runtime_config(runtime_config: dict[str, str]) -> None:
    """Install runtime configuration supplied by the Worker for this run.

    Secrets are passed per request instead of being baked into the image, so
    the container never stores them on disk.
    """
    for key, value in runtime_config.items():
        if key and value:
            os.environ[key] = value


def _redact(message: str) -> str:
    """Remove the credentials a provider error message may quote."""
    for name in ("GENESIS_ACCESS_TOKEN", "TAVILY_API_KEY", "LANGSMITH_API_KEY"):
        secret = os.environ.get(name)
        if secret:
            message = message.replace(secret, "[REDACTED]")
    return message


@app.exception_handler(Exception)
async def _unhandled_error(_request: Request, exc: Exception) -> JSONResponse:
    """Report what failed, so the gateway can store the reason."""
    return JSONResponse(
        status_code=500,
        content={
            "error_type": type(exc).__name__,
            "detail": _redact(str(exc))[:400],
        },
    )


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
        # Keep all extracted fragments for conflict detection and provenance.
        # Context selection happens inside the service/compiler; do not discard
        # summary values such as PPT overview quantities here.
        fragments.extend(pptx_fragments)

    if not fragments:
        raise HTTPException(status_code=422, detail="at least one non-empty text/PPTX demand source is required")

    model = build_chat_model(load_settings(), timeout=600)
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


@app.post("/internal/research")
async def research_run(payload: ResearchRunRequest, x_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Run the M2 Supervisor/Researcher pool and persist its bounded result bundle."""
    _require_internal(payload.token or x_internal_token)
    _apply_runtime_config(payload.runtime_config)
    research_settings = load_settings()
    requested_budget = payload.research_budget
    research_settings = replace(
        research_settings,
        max_search_calls=min(research_settings.max_search_calls, requested_budget.max_search_calls),
        max_web_fetches=min(research_settings.max_web_fetches, requested_budget.max_fetches),
        max_concurrent_researchers=min(research_settings.max_concurrent_researchers, requested_budget.max_tasks),
        max_research_rounds=min(research_settings.max_research_rounds, requested_budget.max_rounds),
        max_model_calls=min(research_settings.max_model_calls, requested_budget.max_model_calls),
    )
    if not research_settings.has_llm:
        raise HTTPException(status_code=503, detail="M2 research requires a configured chat model")
    if not research_settings.tavily_api_key:
        raise HTTPException(status_code=503, detail="M2 research requires the Tavily search provider")

    import httpx

    await _post_event(payload, "INTERNAL_ANALYSIS", "已读取结构化需求与工作区内可复用的公开情报")
    async with httpx.AsyncClient(timeout=60) as client:
        context_response = await client.get(
            f"{payload.gateway_url.rstrip('/')}/internal/projects/{payload.project_id}/sourcing-context",
            params={"run_id": payload.run_id},
            headers={"x-internal-token": payload.token},
        )
        if context_response.status_code == 404:
            raise HTTPException(status_code=404, detail="project or compiled demand not found")
        context_response.raise_for_status()
        context = context_response.json()

    await _post_event(payload, "WEB_RESEARCH", "SourcingPlan 已生成；Supervisor 正在按预算委派公开研究任务")
    try:
        # A research run holds one model call open for minutes. The plan call
        # and the supervisor calls already run past three minutes.
        model = build_chat_model(research_settings, timeout=600)
        bundle = await run_sourcing_research(
            model=model,
            compilation=context["compilation"],
            project_id=payload.project_id,
            run_id=payload.run_id,
            settings=research_settings,
            search_provider=TavilySearchProvider(research_settings.tavily_api_key),
            content_provider=TavilyContentProvider(research_settings.tavily_api_key),
            existing_intelligence=context.get("existing_intelligence", []),
            history_availability=context.get("history_availability", "NOT_PROVIDED"),
        )
    except ResearchBudgetExceeded as exc:
        raise HTTPException(status_code=429, detail={"reason_code": "BUDGET_EXHAUSTED"}) from exc
    except ResearchInputError as exc:
        raise HTTPException(status_code=422, detail={"reason_code": "INVALID_RESEARCH_INPUT"}) from exc
    except Exception as exc:
        error_type = type(exc).__name__
        lower_name = error_type.casefold()
        if "timeout" in lower_name:
            status_code, reason_code = 504, "MODEL_TIMEOUT"
        elif "ratelimit" in lower_name:
            status_code, reason_code = 429, "MODEL_RATE_LIMIT"
        else:
            status_code, reason_code = 502, "RESEARCH_EXECUTION_FAILED"
        raise HTTPException(
            status_code=status_code,
            detail={"reason_code": reason_code, "error_type": error_type},
        ) from exc
    serialized = serialize_bundle_for_gateway(bundle)
    async with httpx.AsyncClient(timeout=120) as client:
        stored_response = await client.post(
            f"{payload.gateway_url.rstrip('/')}/internal/runs/{payload.run_id}/research-results",
            headers={"x-internal-token": payload.token},
            json=serialized,
        )
        if not stored_response.is_success:
            raise HTTPException(
                status_code=stored_response.status_code,
                detail=f"research result persistence failed: {stored_response.text[:500]}",
            )
    await _post_event(
        payload,
        "WEB_RESEARCH" if bundle.candidates else "PARTIAL",
        f"公开研究结束：候选 {len(bundle.candidates)}，证据 {len(bundle.evidence)}，搜索 {bundle.search_calls} 次；未进行 M3 技术合格判定",
    )
    return {
        "run_id": bundle.run_id,
        "status": bundle.status.value,
        "stop_reason_code": bundle.stop_reason_code,
        "plan_id": bundle.plan.plan_id,
        "plan_revision": bundle.plan.plan_revision,
        "researcher_tasks": len(bundle.tasks),
        "candidate_count": len(bundle.candidates),
        "evidence_count": len(bundle.evidence),
        "claim_count": len(bundle.claims),
        "search_calls": bundle.search_calls,
        "fetch_calls": bundle.fetch_calls,
        "model_calls": bundle.model_calls,
        "prompt_tokens": bundle.prompt_tokens,
        "completion_tokens": bundle.completion_tokens,
        "token_usage_observed": bundle.token_usage_observed,
        "model_call_details": [item.model_dump(mode="json") for item in bundle.model_call_details],
        "trace_run_ids": bundle.trace_run_ids,
        "langsmith_tracing_enabled": bundle.langsmith_tracing_enabled,
        "reused_intelligence_count": len(bundle.reused_intelligence_ids),
        "refreshed_intelligence_count": len(bundle.refreshed_intelligence_ids),
        "ignored_intelligence_count": len(bundle.ignored_intelligence_ids),
        "warnings": bundle.warnings,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    """Report container readiness without exposing configuration values."""
    return {
        "status": "ok",
        "llm_configured": settings.has_llm,
        "search_configured": bool(settings.tavily_api_key),
        "max_search_calls": settings.max_search_calls,
    }


def _unresolved_demand_by_requirement(
    requirements: list[Any],
    unstructured: list[Any],
) -> dict[str, list[str]]:
    """Attach the project statements that could not become constraints.

    A statement that names the product of a requirement is an unresolved demand
    of that requirement, so its check cannot be a PASS. The statements that do
    not name a product stay with the project, and the decision stage reads
    them.
    """
    result: dict[str, list[str]] = {}
    for requirement in requirements:
        name = str(getattr(requirement, "product_name", "") or "").strip()
        matched: list[str] = []
        if name:
            for item in unstructured:
                text = str(getattr(item, "text", "") or "")
                if text and name in text:
                    matched.append(text)
        result[str(getattr(requirement, "requirement_id", ""))] = matched
    return result


@app.post("/internal/evaluate-spec")
async def evaluate_spec(payload: SpecEvaluationRequest, x_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Judge every requirement against every candidate of a project.

    The container asks the gateway for the compiled demand, the project
    candidates, and the product claims, then types the claims, aligns them with
    the constraints, and hands the result to the calculator. The verdicts go
    back to the gateway, which stores them in D1.
    """
    _require_internal(payload.token or x_internal_token)
    _apply_runtime_config(payload.runtime_config)

    import httpx

    from procurement_agent.domain.requirements import Requirement
    from procurement_agent.domain.sourcing import ClaimDraft, ResearchCandidate
    from procurement_agent.services.spec_evaluation import evaluate_candidates, summarize

    async with httpx.AsyncClient(timeout=120) as client:
        context_response = await client.get(
            f"{payload.gateway_url.rstrip('/')}/internal/projects/{payload.project_id}/spec-context",
            params={
                "requirement_ids": ",".join(payload.requirement_ids),
                "candidate_ids": ",".join(payload.candidate_ids),
            },
            headers={"x-internal-token": payload.token},
        )
        if context_response.status_code == 404:
            raise HTTPException(status_code=404, detail="project or compiled demand not found")
        context_response.raise_for_status()
        context = context_response.json()

    evaluation_settings = load_settings()
    if not evaluation_settings.has_llm:
        raise HTTPException(status_code=503, detail="M3-A evaluation requires a configured chat model")

    requirements = [Requirement.model_validate(item) for item in context.get("requirements") or []]
    candidates = [ResearchCandidate.model_validate(item) for item in context.get("candidates") or []]
    claims = [ClaimDraft.model_validate(item) for item in context.get("claims") or []]
    models = {str(key): str(value) for key, value in (context.get("model_by_product") or {}).items()}
    unresolved = _unresolved_demand_by_requirement(
        requirements,
        context.get("unstructured_requirements") or [],
    )

    try:
        # The typing and the alignment hold one model call open for minutes.
        model = build_chat_model(evaluation_settings, timeout=600)
        assessments = evaluate_candidates(
            requirements=requirements,
            candidates=candidates,
            claims=claims,
            model=model,
            model_by_product=models,
            unresolved_demand=unresolved,
        )
    except Exception as exc:
        error_type = type(exc).__name__
        lower_name = error_type.casefold()
        if "timeout" in lower_name:
            status_code, reason_code = 504, "MODEL_TIMEOUT"
        elif "ratelimit" in lower_name:
            status_code, reason_code = 429, "MODEL_RATE_LIMIT"
        else:
            status_code, reason_code = 502, "SPEC_EVALUATION_FAILED"
        raise HTTPException(
            status_code=status_code,
            detail={"reason_code": reason_code, "error_type": error_type},
        ) from exc

    serialized = [
        {
            "requirement_id": assessment.requirement_id,
            "product_candidate_id": assessment.product_candidate_id,
            "product_model_ref": assessment.product_model_ref,
            "hard_spec_overall": assessment.hard_spec_overall.value,
            "overall_reason_codes": [code.value for code in assessment.overall_reason_codes],
            "hard_constraint_count": assessment.hard_constraint_count,
            "calculator_version": assessment.calculator_version,
            "dsl_schema_version": assessment.dsl_schema_version,
            "evaluated_at": assessment.evaluated_at.isoformat(),
            "assessment": assessment.model_dump(mode="json"),
        }
        for assessment in assessments
    ]
    async with httpx.AsyncClient(timeout=120) as client:
        stored = await client.post(
            f"{payload.gateway_url.rstrip('/')}/internal/projects/{payload.project_id}/spec-results",
            headers={"x-internal-token": payload.token},
            json={"demand_revision": context.get("demand_revision", 1), "assessments": serialized},
        )
        if not stored.is_success:
            raise HTTPException(
                status_code=stored.status_code,
                detail=f"spec assessment persistence failed: {stored.text[:500]}",
            )
    summary = summarize(assessments)
    return {
        "project_id": payload.project_id,
        "status": "COMPLETED",
        "assessments": len(assessments),
        "by_overall": summary["by_overall"],
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


async def _post_event(payload: ExecuteRequest | ResearchRunRequest, stage: str, detail: str) -> None:
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
