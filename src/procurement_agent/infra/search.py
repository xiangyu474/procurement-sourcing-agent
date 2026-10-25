"""Search provider abstraction.

Tavily is the only implemented live provider. The interface exists so the
agent code never depends on a vendor SDK directly, and so tests can run
against a fake provider without network access.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SearchResult:
    """One candidate source returned by a search provider."""

    url: str
    title: str
    snippet: str
    rank: int
    provider: str


class SearchProvider(Protocol):
    """Minimal contract for public web search."""

    def search(
        self,
        query: str,
        *,
        purpose: str,
        max_results: int = 5,
        channel_hint: str | None = None,
    ) -> list[SearchResult]:
        """Return candidate sources for one research question."""
        ...


class TavilySearchProvider:
    """Live search provider backed by Tavily."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def search(
        self,
        query: str,
        *,
        purpose: str,
        max_results: int = 5,
        channel_hint: str | None = None,
    ) -> list[SearchResult]:
        """Return candidate sources. Snippets are discovery hints, not evidence."""
        from tavily import TavilyClient

        client = TavilyClient(api_key=self._api_key)
        response = client.search(
            query=query,
            max_results=max_results,
            search_depth="basic",
            include_answer=False,
        )
        return [
            SearchResult(
                url=item.get("url", ""),
                title=item.get("title", ""),
                snippet=item.get("content", ""),
                rank=index + 1,
                provider="tavily",
            )
            for index, item in enumerate(response.get("results", []))
        ]


@dataclass(frozen=True)
class FetchedPage:
    """Text extracted from a public source; it is untrusted evidence, not instructions."""

    url: str
    title: str
    content: str
    publisher: str | None = None
    locator: str = "tavily-extract:document"


class PublicContentProvider(Protocol):
    """Provider contract for extracting page content from a search result URL."""

    def fetch(self, url: str, *, query: str, max_chars: int = 80_000) -> FetchedPage:
        """Return source text for an already-discovered URL."""
        ...


class TavilyContentProvider:
    """Use Tavily Extract to retrieve readable public content, not snippets."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def fetch(self, url: str, *, query: str, max_chars: int = 80_000) -> FetchedPage:
        from tavily import TavilyClient

        response = TavilyClient(api_key=self._api_key).extract(
            urls=[url],
            extract_depth="basic",
            format="markdown",
            timeout=30,
            query=query[:500],
        )
        results = response.get("results", [])
        if not results:
            raise RuntimeError("Tavily Extract returned no source content")
        result = results[0]
        content = str(result.get("raw_content") or result.get("content") or "").strip()
        if not content:
            raise RuntimeError("Tavily Extract returned an empty source")
        return FetchedPage(
            url=str(result.get("url") or url),
            title=str(result.get("title") or ""),
            content=content[:max_chars],
            publisher=None,
        )


class FakeContentProvider:
    """Deterministic page extractor used by tests and offline runs."""

    def __init__(self, pages: dict[str, FetchedPage] | None = None) -> None:
        self._pages = pages or {}
        self.calls: list[tuple[str, str]] = []

    def fetch(self, url: str, *, query: str, max_chars: int = 80_000) -> FetchedPage:
        self.calls.append((url, query))
        page = self._pages.get(url)
        if page is None:
            raise RuntimeError("source page is not configured in the fake provider")
        return FetchedPage(
            url=page.url,
            title=page.title,
            content=page.content[:max_chars],
            publisher=page.publisher,
            locator=page.locator,
        )


class FakeSearchProvider:
    """Deterministic provider used by tests and offline runs."""

    def __init__(self, results: list[SearchResult] | None = None) -> None:
        self._results = results or []
        self.calls: list[tuple[str, str]] = []

    def search(
        self,
        query: str,
        *,
        purpose: str,
        max_results: int = 5,
        channel_hint: str | None = None,
    ) -> list[SearchResult]:
        """Record the call and return the configured fixture results."""
        self.calls.append((query, purpose))
        return self._results[:max_results]
