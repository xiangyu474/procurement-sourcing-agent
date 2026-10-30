"""M3-B product equivalence: how history and public leads are put together.

Two records are fused when a confirmed equivalence says they describe the same
thing. The supplier name is never the key: two companies can sell the same
product, one company can sell several products under different names, and a
simulated history supplier is not a company at all.

An equivalence has to be confirmed. An unconfirmed guess is kept as a
candidate relation and is not used to fuse anything.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from procurement_agent.domain.pricing import PriceObservation


class EquivalenceStatus(StrEnum):
    """How sure an equivalence relation is."""

    CONFIRMED = "CONFIRMED"
    CANDIDATE = "CANDIDATE"
    REJECTED = "REJECTED"


class ProductEquivalence(BaseModel):
    """A statement that two product references describe the same thing."""

    model_config = ConfigDict(extra="forbid")

    equivalence_key: str
    product_ref: str
    requirement_id: str | None = None
    sku: str | None = None
    status: EquivalenceStatus = EquivalenceStatus.CONFIRMED
    confirmed_by: str = Field(min_length=4, max_length=500)
    source_ref: str | None = None

    @property
    def is_usable(self) -> bool:
        return self.status == EquivalenceStatus.CONFIRMED


class FusedGroup(BaseModel):
    """One confirmed equivalence group with the records that belong to it."""

    model_config = ConfigDict(extra="forbid")

    equivalence_key: str
    requirement_id: str | None = None
    sku: str | None = None
    history_observation_ids: list[str] = Field(default_factory=list)
    public_observation_ids: list[str] = Field(default_factory=list)
    public_supplier_ids: list[str] = Field(default_factory=list)
    synthetic_supplier_ids: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


def build_equivalence_index(
    equivalences: Iterable[ProductEquivalence],
) -> dict[str, str]:
    """Map every confirmed product reference and SKU to its equivalence key."""
    index: dict[str, str] = {}
    for equivalence in equivalences:
        if not equivalence.is_usable:
            continue
        index[equivalence.product_ref] = equivalence.equivalence_key
        if equivalence.sku:
            index[equivalence.sku] = equivalence.equivalence_key
    return index


def equivalence_key_for(
    *,
    product_ref: str | None,
    requirement_id: str | None,
    sku: str | None,
    index: dict[str, str],
) -> str | None:
    """Find the equivalence key of one record.

    A confirmed product reference wins. A requirement or SKU is used only when
    the index already knows it, so nothing is invented here.
    """
    if product_ref and product_ref in index:
        return index[product_ref]
    for key in (requirement_id, sku):
        if key and key in index:
            return index[key]
    return None


def fuse_by_equivalence(
    *,
    history_observations: Sequence[PriceObservation],
    public_observations: Sequence[PriceObservation],
    equivalences: Iterable[ProductEquivalence],
) -> list[FusedGroup]:
    """Put the history and the public leads together by confirmed equivalence.

    Records without a confirmed equivalence stay on their own. The supplier
    name is never used to join two records.
    """
    index = build_equivalence_index(equivalences)
    groups: dict[str, FusedGroup] = {}
    ungrouped: list[PriceObservation] = []

    def group_for(key: str) -> FusedGroup:
        if key not in groups:
            groups[key] = FusedGroup(equivalence_key=key)
        return groups[key]

    for observation in history_observations:
        key = equivalence_key_for(
            product_ref=None,
            requirement_id=observation.requirement_id,
            sku=observation.sku,
            index=index,
        )
        if key is None:
            ungrouped.append(observation)
            continue
        group = group_for(key)
        group.history_observation_ids.append(observation.observation_id)
        if observation.supplier_id:
            if observation.is_synthetic_supplier:
                if observation.supplier_id not in group.synthetic_supplier_ids:
                    group.synthetic_supplier_ids.append(observation.supplier_id)
            elif observation.supplier_id not in group.public_supplier_ids:
                group.public_supplier_ids.append(observation.supplier_id)

    for observation in public_observations:
        key = equivalence_key_for(
            product_ref=observation.product_equivalence_key,
            requirement_id=observation.requirement_id,
            sku=None,
            index=index,
        )
        if key is None:
            ungrouped.append(observation)
            continue
        group = group_for(key)
        group.public_observation_ids.append(observation.observation_id)
        if observation.supplier_id and observation.supplier_id not in group.public_supplier_ids:
            group.public_supplier_ids.append(observation.supplier_id)

    for group in groups.values():
        if group.synthetic_supplier_ids and group.public_supplier_ids:
            group.notes.append(
                "This group holds rows of the simulated history and rows of public leads. They are "
                "fused because the equivalence was confirmed, not because the supplier names match."
            )
    return list(groups.values())


def ungrouped_count(groups: Sequence[FusedGroup], observations: Sequence[PriceObservation]) -> int:
    """How many records stayed outside every confirmed group."""
    placed = sum(len(group.history_observation_ids) + len(group.public_observation_ids) for group in groups)
    return max(0, len(observations) - placed)
