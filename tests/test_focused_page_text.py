"""The researcher must see the specification table, not the cover page."""

from __future__ import annotations

from procurement_agent.services.sourcing_research import _focused_page_text


def test_a_deep_specification_table_is_shown_to_the_researcher() -> None:
    head = "\n".join(f"cover line {index}" for index in range(300))
    table = "| Resolution | 5 Megapixel |\n| Frame rate | 30 fps |\n| Ingress | IP67 |"
    tail = "\n".join(f"footer line {index}" for index in range(300))
    content = f"{head}\n{table}\n{tail}"

    focused = _focused_page_text(content)

    assert "5 Megapixel" in focused
    assert "30 fps" in focused
    assert len(focused) < len(content)


def test_a_short_page_is_returned_unchanged() -> None:
    content = "| Resolution | 5 Megapixel |"
    assert _focused_page_text(content) == content


def test_a_page_without_specifications_keeps_its_beginning() -> None:
    content = "\n".join(f"paragraph {index}" for index in range(1000))
    focused = _focused_page_text(content)
    assert focused.startswith("paragraph 0")
