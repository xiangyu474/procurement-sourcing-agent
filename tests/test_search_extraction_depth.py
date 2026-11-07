"""A specification table must survive the extraction."""

from __future__ import annotations

import sys
import types

from procurement_agent.infra.search import TavilyContentProvider


class _FakeTavily:
    calls: list[dict[str, object]] = []

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    def extract(self, **kwargs):
        _FakeTavily.calls.append(kwargs)
        depth = kwargs.get("extract_depth")
        if depth == "advanced":
            return {"results": [{"url": "https://example.test/spec", "title": "Spec",
                                 "raw_content": "| Resolution | 5 Megapixel |"}]}
        return {"results": [{"url": "https://example.test/spec", "title": "Spec",
                              "raw_content": "| Resolution | 1080p |"}]}


def test_the_full_extraction_is_used_and_the_cheap_one_is_the_fallback(monkeypatch):
    fake = types.ModuleType("tavily")
    fake.TavilyClient = _FakeTavily  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tavily", fake)
    _FakeTavily.calls = []

    page = TavilyContentProvider("key").fetch("https://example.test/spec", query="resolution")

    assert "5 Megapixel" in page.content
    assert _FakeTavily.calls[0]["extract_depth"] == "advanced"


def test_the_cheap_extraction_is_used_when_the_full_one_has_nothing(monkeypatch):
    class _Empty(_FakeTavily):
        def extract(self, **kwargs):
            _FakeTavily.calls.append(kwargs)
            if kwargs.get("extract_depth") == "advanced":
                return {"results": []}
            return {"results": [{"url": "https://example.test/spec", "title": "Spec",
                                 "raw_content": "| Resolution | 1080p |"}]}

    fake = types.ModuleType("tavily")
    fake.TavilyClient = _Empty  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tavily", fake)
    _FakeTavily.calls = []

    page = TavilyContentProvider("key").fetch("https://example.test/spec", query="resolution")

    assert "1080p" in page.content
    assert [call["extract_depth"] for call in _FakeTavily.calls] == ["advanced", "basic"]
