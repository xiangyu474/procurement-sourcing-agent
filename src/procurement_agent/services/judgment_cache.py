"""The client side of the judgement cache.

The container asks the gateway for the cached judgements and hands back the
new ones. The gateway owns the database, so the cache lives where the
database lives, and no second piece of infrastructure is introduced.

A cache that is used is a cache that is written: every miss is stored with
the run that produced it, the model configuration, the versions of the rules,
and the digests of the evidence the judgement rests on.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from procurement_agent.domain.judgment_cache import CacheEntry, CacheLayer, canonical_json


@dataclass
class CacheLookup:
    """What the cache had, and what it did not have."""

    layer: CacheLayer
    found: dict[str, dict[str, Any]]
    missing: list[str]

    def payload(self, digest: str) -> dict[str, Any] | None:
        return self.found.get(digest)


class BaseJudgmentCache:
    """The behaviour every cache has: look up, store, and map digests to owners."""

    def lookup(self, layer: CacheLayer, digests: Sequence[str]) -> CacheLookup:  # pragma: no cover
        raise NotImplementedError

    def store(self, entries: Sequence[CacheEntry]) -> dict[str, Any]:  # pragma: no cover
        raise NotImplementedError

    def lookup_many(
        self,
        layer: CacheLayer,
        digests: Mapping[str, str],
    ) -> tuple[dict[str, dict[str, Any]], list[str]]:
        """Look up several digests and report which ones were not found.

        The mapping is from an owner to its digest, so the caller learns which
        owners have to be judged again.
        """
        result = self.lookup(layer, list(digests.values()))
        by_digest = {value: key for key, value in digests.items()}
        found: dict[str, dict[str, Any]] = {}
        missing: list[str] = []
        for digest, payload in result.found.items():
            owner = by_digest.get(digest)
            if owner is not None:
                found[owner] = payload
        for digest in result.missing:
            owner = by_digest.get(digest)
            if owner is not None:
                missing.append(owner)
        return found, missing


class InMemoryJudgmentCache(BaseJudgmentCache):
    """A cache that lives in the process, for local runs and for the tests.

    It keeps the same rules as the database: the first answer for a digest
    wins, and a later different answer is kept as a conflict.
    """

    def __init__(self) -> None:
        self.entries: dict[tuple[str, str], dict[str, Any]] = {}
        self.conflicts: list[dict[str, Any]] = []
        self.lookups = 0
        self.stores = 0

    def lookup(self, layer: CacheLayer, digests: Sequence[str]) -> CacheLookup:
        self.lookups += 1
        found: dict[str, dict[str, Any]] = {}
        missing: list[str] = []
        for digest in dict.fromkeys(digests):
            payload = self.entries.get((layer.value, digest))
            if payload is None:
                missing.append(digest)
            else:
                found[digest] = payload
        return CacheLookup(layer=layer, found=found, missing=missing)

    def store(self, entries: Sequence[CacheEntry]) -> dict[str, Any]:
        self.stores += 1
        stored = 0
        for entry in entries:
            key = (entry.layer.value, entry.input_digest)
            existing = self.entries.get(key)
            if existing is None:
                self.entries[key] = entry.payload
                stored += 1
            elif canonical_json(existing) != canonical_json(entry.payload):
                self.conflicts.append(
                    {
                        "layer": entry.layer.value,
                        "input_digest": entry.input_digest,
                        "payload": entry.payload,
                    }
                )
        return {"stored": stored, "conflicts": len(self.conflicts)}


class JudgmentCacheClient(BaseJudgmentCache):
    """Reads and writes the cached judgements through the gateway."""

    def __init__(self, gateway_url: str, token: str, timeout: int = 60) -> None:
        self._gateway_url = gateway_url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def lookup(self, layer: CacheLayer, digests: Sequence[str]) -> CacheLookup:
        """Ask for the cached payloads of these digests."""
        wanted = list(dict.fromkeys(digests))
        if not wanted:
            return CacheLookup(layer=layer, found={}, missing=[])
        with httpx.Client(timeout=self._timeout) as client:
            response = client.post(
                f"{self._gateway_url}/internal/judgment-cache/lookup",
                headers={"x-internal-token": self._token},
                json={"layer": layer.value, "digests": wanted},
            )
        if not response.is_success:
            # A cache that cannot be read is a cache that is empty. The
            # judgements are then made again, which is slower but correct.
            return CacheLookup(layer=layer, found={}, missing=wanted)
        body = response.json()
        found = {str(key): value for key, value in (body.get("payloads") or {}).items()}
        return CacheLookup(
            layer=layer,
            found=found,
            missing=[digest for digest in wanted if digest not in found],
        )

    def store(self, entries: Sequence[CacheEntry]) -> dict[str, Any]:
        """Hand the new judgements to the gateway."""
        if not entries:
            return {"stored": 0, "conflicts": 0}
        payload = {
            "entries": [
                {
                    "layer": entry.layer.value,
                    "input_digest": entry.input_digest,
                    "payload": entry.payload,
                    "versions": entry.versions,
                    "model_config": entry.model_config,
                    "evidence_hashes": entry.evidence_hashes,
                    "source_run_id": entry.source_run_id,
                    "source_project_id": entry.source_project_id,
                    "verdict": entry.verdict,
                    "reason_codes": entry.reason_codes,
                }
                for entry in entries
            ]
        }
        with httpx.Client(timeout=self._timeout) as client:
            response = client.post(
                f"{self._gateway_url}/internal/judgment-cache/store",
                headers={"x-internal-token": self._token},
                json=payload,
            )
        if not response.is_success:
            return {"stored": 0, "conflicts": 0}
        return response.json()

