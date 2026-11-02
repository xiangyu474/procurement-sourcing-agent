"""The pipeline report reads and verifies the exact frozen decision snapshot."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json

import httpx
import pytest
from docx import Document
from fastapi import HTTPException

from procurement_agent.api.app import BuildReportRequest, build_report


def _context() -> dict:
    return {
        "project_id": "p1", "pipeline_id": "pipeline-1", "run_id": "run-1", "demand_revision": 2,
        "project_title": "Frozen project",
        "requirements": [{"requirement_id": "r1", "product_name": "摄像机", "constraints": []}],
        "candidates": [{"candidate_id": "c1", "requirement_id": "r1", "supplier_name": "Supplier A", "product_model": "M1", "stage": "DISCOVERED_LONG_LIST", "evidence_ids": ["e1"]}],
        "assessments": [{"assessment_id": "a1", "requirement_id": "r1", "product_candidate_id": "c1", "hard_spec_overall": "UNKNOWN", "checks": []}],
        "decisions": [{"requirement_id": "r1", "product_candidate_id": "c1", "recommendation": "INVESTIGATE", "technical_verdict": "UNVERIFIED", "hard_spec_overall": "UNKNOWN", "accepted": True, "gaps": ["缺少证据"]}],
        "price_contexts": [{"requirement_id": "r1", "history_scope": "NONE", "history": {}, "findings": []}],
        "evidence": [{"evidence_id": "e1", "title": "产品页", "url": "https://example.test", "quote": "5MP", "content_sha256": "a" * 64}],
    }


def _client(context: dict, captured: dict):
    raw = json.dumps(context, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()

    class Client:
        def __init__(self, *, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, url: str, **kwargs):
            assert url.endswith("/internal/pipelines/pipeline-1/snapshots/FINAL_CONTEXT")
            assert kwargs["params"] == {"project_id": "p1"}
            return httpx.Response(200, content=raw, headers={"x-snapshot-sha256": digest}, request=httpx.Request("GET", url))

        async def post(self, url: str, **kwargs):
            assert url.endswith("/internal/projects/p1/report-artifact")
            captured.update(kwargs)
            document = kwargs["content"]
            return httpx.Response(200, json={"key": "private-key", "bytes": len(document), "sha256": hashlib.sha256(document).hexdigest()}, request=httpx.Request("POST", url))

    return Client, digest


def test_report_uses_frozen_pipeline_snapshot_and_embeds_version(monkeypatch):
    captured: dict = {}
    client, digest = _client(_context(), captured)
    monkeypatch.setattr(httpx, "AsyncClient", client)
    request = BuildReportRequest(project_id="p1", run_id="run-1", pipeline_id="pipeline-1", decision_version=digest, gateway_url="https://gateway.test", token="internal")
    result = asyncio.run(build_report(request))
    assert result["decision_version"] == digest
    assert captured["params"]["pipeline_id"] == "pipeline-1"
    doc = Document(io.BytesIO(captured["content"]))
    text = "\n".join([p.text for p in doc.paragraphs] + [cell.text for table in doc.tables for row in table.rows for cell in row.cells])
    assert digest in text and "run-1" in text and "Supplier A" in text
    assert "未知（证据不足）" in text and "缺少证据" in text


def test_report_refuses_mismatched_version_without_upload(monkeypatch):
    captured: dict = {}
    client, _digest = _client(_context(), captured)
    monkeypatch.setattr(httpx, "AsyncClient", client)
    request = BuildReportRequest(project_id="p1", run_id="run-1", pipeline_id="pipeline-1", decision_version="0" * 64, gateway_url="https://gateway.test", token="internal")
    with pytest.raises(HTTPException) as error:
        asyncio.run(build_report(request))
    assert error.value.status_code == 409
    assert not captured
