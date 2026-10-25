from __future__ import annotations

import hashlib
import importlib
from io import BytesIO

import openpyxl
from fastapi.testclient import TestClient
from pptx import Presentation
from pptx.util import Inches

from procurement_agent.domain.requirements import (
    ConstraintOrigin,
    ConstraintOperator,
    Importance,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.ingestion.text import extract_text_fragments


class _FixedModel:
    def __init__(self, payload):
        self.payload = payload

    def with_structured_output(self, _schema, **_kwargs):
        return self

    def invoke(self, _messages):
        return self.payload


def make_xlsx() -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "历史采购明细"
    ws.append(["模拟数据，供应商名称、合同和交易状态均为虚构"])
    for _ in range(6):
        ws.append([None])
    ws.append(["采购订单号", "订单行号", "产品编码", "产品名称", "采购数量", "供应商编码", "供应商名称"])
    ws.append(["PO-1", "1", "SKU-1", "镜头模组", 2, "S001", "模拟供应商"])
    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def make_requirement_pptx() -> bytes:
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = slide.shapes.add_table(2, 3, Inches(1), Inches(1), Inches(6), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "预估/框架数量（套）"
    table.cell(0, 2).text = "预计采购单价（元/套）"
    table.cell(1, 0).text = "通用摄像头"
    table.cell(1, 1).text = "100"
    table.cell(1, 2).text = "125"
    output = BytesIO()
    presentation.save(output)
    return output.getvalue()


def make_pptx_with_overview_conflict() -> bytes:
    presentation = Presentation()
    detail = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = detail.shapes.add_table(2, 3, Inches(1), Inches(1), Inches(6), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "预估/框架数量（套）"
    table.cell(0, 2).text = "预估采购单价（元/套）"
    table.cell(1, 0).text = "通用摄像头"
    table.cell(1, 1).text = "100"
    table.cell(1, 2).text = "125"
    for value, label in (("58万台", "采购数量"), ("63万台", "本次短名单采购计划")):
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        summary = slide.shapes.add_table(2, 2, Inches(1), Inches(1), Inches(4), Inches(2)).table
        summary.cell(0, 0).text = value
        summary.cell(0, 1).text = ""
        summary.cell(1, 0).text = label
        summary.cell(1, 1).text = ""
    output = BytesIO()
    presentation.save(output)
    return output.getvalue()


def test_internal_text_compilation_returns_requirement_and_not_provided_history(monkeypatch):
    api = importlib.import_module("procurement_agent.api.app")
    fragment = extract_text_fragments("p1", 1, "电源模块额定功率至少7.5kW", source_id="text-1")[0]
    compiled = RequirementCompilation.model_validate(
        {
            "requirements": [
                {
                    "requirement_id": "r1",
                    "project_id": "p1",
                    "product_name": "电源模块",
                    "source_refs": [fragment.locator],
                    "constraints": [
                        {
                            "constraint_id": "c1",
                            "requirement_id": "r1",
                            "attribute_key": "rated_output_power",
                            "attribute_definition": "额定输出功率",
                            "value_type": "NUMBER",
                            "operator": "GTE",
                            "value": "7.5",
                            "unit": "kW",
                            "importance": "HARD",
                            "origin": "USER_EXPLICIT",
                            "source_ref": fragment.locator,
                            "source_quote": "额定功率至少7.5kW",
                        }
                    ],
                }
            ]
        }
    )
    monkeypatch.setattr(api, "build_chat_model", lambda settings, **kwargs: _FixedModel(compiled))
    client = TestClient(api.app)

    response = client.post(
        "/internal/compile-demand",
        headers={"x-internal-token": "internal"},
        json={
            "project_id": "p1",
            "analysis_version": 1,
            "gateway_url": "https://gateway.invalid",
            "token": "internal",
            "text_sources": [{"source_id": "text-1", "revision": 1, "text": "电源模块额定功率至少7.5kW"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["requirements"][0]["constraints"][0]["parse_status"] == "RESOLVED"
    assert body["history_availability"] == "NOT_PROVIDED"


def test_internal_pptx_table_intake_does_not_require_history_or_llm(monkeypatch):
    api = importlib.import_module("procurement_agent.api.app")
    payload = make_requirement_pptx()

    async def fetch(_payload, _source_id):
        return payload

    monkeypatch.setattr(api, "_fetch_input", fetch)
    monkeypatch.setattr(api, "build_chat_model", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no narrative constraints to compile")))
    client = TestClient(api.app)
    response = client.post(
        "/internal/compile-demand",
        headers={"x-internal-token": "internal"},
        json={
            "project_id": "p2",
            "analysis_version": 1,
            "gateway_url": "https://gateway.invalid",
            "token": "internal",
            "pptx_sources": [{"source_id": "ppt-1", "filename": "req.pptx", "revision": 1}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["history_availability"] == "NOT_PROVIDED"
    assert len(body["requirements"]) == 1
    requirement = body["requirements"][0]
    assert requirement["product_name"] == "通用摄像头"
    assert requirement["quantity"] == "100"
    assert requirement["planned_unit_price"]["kind"] == "PLANNED_PRICE"
    assert requirement["planned_unit_price"]["tax_basis"] == "UNKNOWN"


def test_internal_pptx_api_preserves_overview_conflict_sources(monkeypatch):
    api = importlib.import_module("procurement_agent.api.app")
    payload = make_pptx_with_overview_conflict()

    async def fetch(_payload, _source_id):
        return payload

    monkeypatch.setattr(api, "_fetch_input", fetch)
    # The PPT has a structured SKU table and no narrative technical constraint;
    # table parsing and summary conflict detection are deterministic.
    monkeypatch.setattr(api, "build_chat_model", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("model should not run")))
    client = TestClient(api.app)
    response = client.post(
        "/internal/compile-demand",
        headers={"x-internal-token": "internal"},
        json={
            "project_id": "p3",
            "analysis_version": 1,
            "gateway_url": "https://gateway.invalid",
            "token": "internal",
            "pptx_sources": [{"source_id": "ppt-conflict", "filename": "conflict.pptx", "revision": 1}],
        },
    )

    assert response.status_code == 200
    compilation = response.json()
    conflicts = compilation["conflicts"]
    assert len(compilation["requirements"]) == 1
    assert len(conflicts) == 1
    assert {item["value"] for item in conflicts[0]["values_with_source"]} == {"58万台", "63万台"}
    assert all(item["source_ref"] and item["source_quote"] for item in conflicts[0]["values_with_source"])


def test_internal_history_import_keeps_simulated_supplier_namespace(monkeypatch):
    api = importlib.import_module("procurement_agent.api.app")
    content = make_xlsx()
    monkeypatch.setattr(api, "_fetch_input", lambda _payload, _source_id: _async_bytes(content))
    client = TestClient(api.app)

    response = client.post(
        "/internal/import-history",
        headers={"x-internal-token": "internal"},
        json={
            "project_id": "p1",
            "source_id": "history-1",
            "filename": "history.xlsx",
            "sha256": hashlib.sha256(content).hexdigest(),
            "gateway_url": "https://gateway.invalid",
            "token": "internal",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["row_count"] == 1
    assert body["header_row"] == 8
    assert body["is_synthetic"] is True
    assert body["transactions"][0]["supplier_namespace"] == "HISTORICAL_SUPPLIER_SIMULATED"


async def _async_bytes(content: bytes) -> bytes:
    return content
