"""Plain-text demand intake with revisioned source coordinates."""

from __future__ import annotations

from procurement_agent.domain.requirements import RequirementSourceType, SourceFragment


def extract_text_fragments(
    project_id: str,
    revision: int,
    text: str,
    source_id: str | None = None,
) -> list[SourceFragment]:
    """Split text into source-located fragments without rewriting its content.

    Each fragment carries exact offsets into the submitted revision. Blank
    lines are omitted, while line text and spacing within a non-empty line are
    retained so the compiler can cite exact source quotes.
    """
    if not text or not text.strip():
        return []

    fragments: list[SourceFragment] = []
    offset = 0
    for line_number, raw_line in enumerate(text.splitlines(keepends=True), start=1):
        line = raw_line.rstrip("\r\n")
        start = offset
        end = start + len(line)
        if line.strip():
            stable_source_id = source_id or f"text-rev-{revision}"
            fragments.append(
                SourceFragment(
                    source_id=stable_source_id,
                    source_type=RequirementSourceType.USER_TEXT,
                    locator=(
                        f"user_text:project={project_id}:source={stable_source_id}:rev_{revision}:"
                        f"line_{line_number}:span_{start}_{end}"
                    ),
                    text=line,
                    revision=revision,
                )
            )
        offset += len(raw_line)

    # splitlines() returns no lines for one empty string; non-empty text with
    # no trailing newline still yields one fragment above.
    return fragments


def join_fragments(fragments: list[SourceFragment]) -> str:
    """Return a readable compilation input while preserving fragment order."""
    return "\n".join(fragment.text for fragment in fragments)
