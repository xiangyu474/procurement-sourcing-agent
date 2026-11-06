"""The search result says what kind of page it is."""

from __future__ import annotations

from procurement_agent.services.sourcing_research import page_kind


def test_a_datasheet_is_marked_as_the_specification_page() -> None:
    assert page_kind("https://example.com/files/camera_datasheet.pdf", "Camera datasheet") == "SPECIFICATION"
    assert page_kind("https://example.com/files/manual.pdf", "WV-X2551LN") == "SPECIFICATION"
    assert page_kind("https://example.com/product/wv-x2551ln", "WV-X2551LN | i-PRO Products") == "OTHER"
