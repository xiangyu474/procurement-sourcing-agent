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
    ) -> list[SearchResult]:
        """Record the call and return the configured fixture results."""
        self.calls.append((query, purpose))
        return self._results[:max_results]
