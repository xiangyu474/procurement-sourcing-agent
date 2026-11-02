"""Pipeline stage retries reuse the immutable result, not a second model call."""

from __future__ import annotations

import asyncio

import httpx

from procurement_agent.api.app import DecisionRequest, SpecEvaluationRequest, decide, evaluate_spec


class _Client:
    def __init__(self, *, timeout: int):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def get(self, url: str, **kwargs):
        assert kwargs["params"]["project_id"] == "p1"
        if url.endswith("/SPEC_RESULTS"):
            body = {"assessments": [{"hard_spec_overall": "PASS"}, {"hard_spec_overall": "UNKNOWN"}]}
        elif url.endswith("/DECISION_RESULTS"):
            body = {"decisions": [{"accepted": True}, {"accepted": False}]}
        else:
            raise AssertionError(f"unexpected model/context request: {url}")
        return httpx.Response(200, json=body, request=httpx.Request("GET", url))


def test_pipeline_spec_retry_reuses_stored_assessment(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    payload = SpecEvaluationRequest(project_id="p1", pipeline_id="pipe", gateway_url="https://gateway.test", token="internal")
    result = asyncio.run(evaluate_spec(payload))
    assert result["reused"] is True
    assert result["assessments"] == 2
    assert result["by_overall"] == {"PASS": 1, "UNKNOWN": 1}


def test_pipeline_decision_retry_reuses_stored_decision(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    payload = DecisionRequest(project_id="p1", pipeline_id="pipe", gateway_url="https://gateway.test", token="internal")
    result = asyncio.run(decide(payload))
    assert result["reused"] is True
    assert result["accepted"] == 1
    assert result["rejected"] == 1
