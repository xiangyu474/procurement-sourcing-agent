from procurement_agent.infra import load_settings
from procurement_agent.infra.search import (
    FakeContentProvider,
    FakeSearchProvider,
    FetchedPage,
    SearchResult,
)


def test_settings_report_missing_llm_configuration(monkeypatch):
    for name in ("GENESIS_BASE_URL", "GENESIS_ACCESS_TOKEN", "GENESIS_MODEL_ID"):
        monkeypatch.delenv(name, raising=False)
    settings = load_settings()
    assert settings.has_llm is False


def test_settings_detect_complete_llm_configuration(monkeypatch):
    monkeypatch.setenv("GENESIS_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("GENESIS_ACCESS_TOKEN", "token")
    monkeypatch.setenv("GENESIS_MODEL_ID", "model-x")
    settings = load_settings()
    assert settings.has_llm is True


def test_fake_search_provider_records_purpose_and_limits_results():
    provider = FakeSearchProvider(
        [
            SearchResult(url="https://a.example", title="A", snippet="a", rank=1, provider="fake"),
            SearchResult(url="https://b.example", title="B", snippet="b", rank=2, provider="fake"),
        ]
    )
    results = provider.search("camera", purpose="DISCOVER_SUPPLIER", max_results=1, channel_hint="MANUFACTURER_DIRECT")
    assert len(results) == 1
    assert provider.calls == [("camera", "DISCOVER_SUPPLIER")]


def test_fake_content_provider_returns_page_text_not_search_snippet():
    provider = FakeContentProvider(
        {"https://manufacturer.example/products/x": FetchedPage(
            url="https://manufacturer.example/products/x",
            title="Model X",
            content="Model X supports an explicit 5MP sensor.",
        )}
    )
    page = provider.fetch("https://manufacturer.example/products/x", query="5MP sensor")
    assert "5MP" in page.content
    assert provider.calls == [("https://manufacturer.example/products/x", "5MP sensor")]
