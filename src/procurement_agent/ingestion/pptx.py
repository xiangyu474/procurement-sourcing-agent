"""PPTX text and table extraction with stable slide and row locators.

Tables are extracted one row per fragment so the model can read them as
rows. Cell wording is preserved verbatim; cells are joined with a single
separator and spanned cells are left empty, which reproduces the visual grid.
"""

from __future__ import annotations

from io import BytesIO

from pptx import Presentation

from procurement_agent.domain.requirements import RequirementSourceType, SourceFragment

MAX_PPTX_BYTES = 25 * 1024 * 1024
MAX_EXTRACTED_CHARS = 300_000
CELL_SEPARATOR = " | "


def extract_pptx_fragments(
    file_bytes: bytes,
    *,
    project_id: str,
    source_id: str,
    filename: str,
    revision: int = 1,
) -> list[SourceFragment]:
    """Extract every slide paragraph and every table row with exact locators."""
    if len(file_bytes) > MAX_PPTX_BYTES:
        raise ValueError(f"PPTX exceeds the {MAX_PPTX_BYTES}-byte limit")
    if not file_bytes.startswith(b"PK"):
        raise ValueError("input is not a ZIP-based PPTX document")

    presentation = Presentation(BytesIO(file_bytes))
    fragments: list[SourceFragment] = []
    char_count = 0

    def add(locator: str, text: str) -> None:
        nonlocal char_count
        cleaned = text.strip()
        if not cleaned:
            return
        char_count += len(cleaned)
        if char_count > MAX_EXTRACTED_CHARS:
            raise ValueError("PPTX extracted text exceeds the configured limit")
        fragments.append(
            SourceFragment(
                source_id=source_id,
                source_type=RequirementSourceType.INTERNAL_PPTX,
                locator=locator,
                text=cleaned,
                revision=revision,
            )
        )

    for slide_number, slide in enumerate(presentation.slides, start=1):
        table_number = 0
        for shape_index, shape in enumerate(slide.shapes):
            if shape.has_table:
                table_number += 1
                for row_index, row in enumerate(shape.table.rows, start=1):
                    cells = [
                        "" if cell.is_spanned else cell.text
                        for cell in row.cells
                    ]
                    add(
                        f"pptx:project={project_id}:source={source_id}:file={filename}:slide={slide_number}:table={table_number}:row={row_index}",
                        CELL_SEPARATOR.join(cells),
                    )
            elif shape.has_text_frame:
                for paragraph_index, paragraph in enumerate(shape.text_frame.paragraphs, start=1):
                    add(
                        f"pptx:project={project_id}:source={source_id}:file={filename}:slide={slide_number}:shape={shape_index}:paragraph={paragraph_index}",
                        paragraph.text,
                    )
    return fragments
