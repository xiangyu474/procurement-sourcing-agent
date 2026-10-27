"""Live search capability check for the configured search provider."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime

from dotenv import load_dotenv

from procurement_agent.infra import load_settings
from procurement_agent.infra.search import TavilySearchProvider


def main() -> int:
    load_dotenv()
    settings = load_settings()
    if not settings.tavily_api_key:
        print(json.dumps({"status": "BLOCKED", "missing_env": ["TAVILY_API_KEY"]}))
        return 2

    provider = TavilySearchProvider(settings.tavily_api_key)
    started = datetime.now(UTC)
    results = provider.search(
        "Cloudflare Containers official documentation",
        purpose="FIND_PRODUCT_DATASHEET",
        max_results=3,
    )
    print(
        json.dumps(
            {
                "status": "PASS" if results else "NO_RESULTS",
                "started_at": started.isoformat(),
                "provider": "tavily",
                "results": [{"title": r.title, "url": r.url} for r in results],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(main())
