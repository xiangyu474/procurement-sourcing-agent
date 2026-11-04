"""One measurement must meet another under one key."""

from __future__ import annotations

from procurement_agent.domain.attributes import canonical_attribute_key
from procurement_agent.services.spec_alignment import APPROVED_ALIASES


def test_a_reviewed_alias_is_written_in_the_canonical_spelling() -> None:
    assert canonical_attribute_key("video_output_resolution") == "output_resolution"
    assert canonical_attribute_key("resolution") == "output_resolution"
    assert canonical_attribute_key("Video Output Resolution") == "output_resolution"
    assert canonical_attribute_key("ip_rating") == "ingress_rating"
    # A key that no reviewed group covers is left alone.
    assert canonical_attribute_key("sensor_resolution") == "sensor_resolution"
    assert canonical_attribute_key("warranty_period") == "warranty_period"


def test_every_group_member_maps_to_its_canonical_key() -> None:
    for canonical, members in APPROVED_ALIASES.items():
        for member in members:
            assert canonical_attribute_key(member) == canonical
