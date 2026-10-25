"""Runtime configuration loaded from environment variables only.

No secret values are stored in the repository. In Cloudflare deployments the
same variable names are provided as Worker/Container secrets.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _optional(name: str) -> str | None:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else None


@dataclass(frozen=True)
class Settings:
    """Runtime settings for the agent process."""

    llm_base_url: str | None
    llm_api_key: str | None
    llm_model: str | None
    tavily_api_key: str | None
    r2_bucket: str | None
    r2_s3_endpoint: str | None
    r2_access_key_id: str | None
    r2_secret_access_key: str | None
    internal_gateway_token: str | None
    max_search_calls: int
    max_web_fetches: int
    max_research_rounds: int
    max_concurrent_researchers: int
    max_model_calls: int
    intelligence_stale_after_days: int

    @property
    def has_llm(self) -> bool:
        """Report whether a chat model endpoint is fully configured."""
        return bool(self.llm_base_url and self.llm_api_key and self.llm_model)


def load_settings() -> Settings:
    """Build settings from the environment, applying conservative defaults."""
    return Settings(
        llm_base_url=_optional("GENESIS_BASE_URL"),
        llm_api_key=_optional("GENESIS_ACCESS_TOKEN"),
        llm_model=_optional("GENESIS_MODEL_ID"),
        tavily_api_key=_optional("TAVILY_API_KEY"),
        r2_bucket=_optional("R2_BUCKET"),
        r2_s3_endpoint=_optional("R2_S3_ENDPOINT"),
        r2_access_key_id=_optional("R2_ACCESS_KEY_ID"),
        r2_secret_access_key=_optional("R2_SECRET_ACCESS_KEY"),
        internal_gateway_token=_optional("INTERNAL_GATEWAY_TOKEN"),
        max_search_calls=max(1, min(int(os.getenv("SOURCING_MAX_SEARCH_CALLS", "12")), 12)),
        max_web_fetches=max(1, min(int(os.getenv("SOURCING_MAX_WEB_FETCHES", "24")), 24)),
        max_research_rounds=max(1, min(int(os.getenv("SOURCING_MAX_RESEARCH_ROUNDS", "3")), 3)),
        max_concurrent_researchers=max(1, min(int(os.getenv("SOURCING_MAX_CONCURRENT_RESEARCHERS", "3")), 3)),
        max_model_calls=max(1, min(int(os.getenv("SOURCING_MAX_MODEL_CALLS", "18")), 30)),
        intelligence_stale_after_days=max(1, int(os.getenv("SOURCING_INTELLIGENCE_STALE_DAYS", "180"))),
    )
