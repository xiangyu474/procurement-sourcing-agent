from io import BytesIO

from pptx import Presentation
from pptx.util import Inches

from procurement_agent.domain.requirements import RequirementSourceType
from procurement_agent.ingestion.pptx import extract_pptx_fragments
from procurement_agent.ingestion.text import extract_text_fragments


def test_text_fragments_keep_revision_and_exact_offsets():
    fragments = extract_text_fragments("proj-1", 3, "找工业摄像头\n至少 5MP\n", source_id="source-1")
    assert [fragment.text for fragment in fragments] == ["找工业摄像头", "至少 5MP"]
    assert fragments[0].locator == "user_text:project=proj-1:source=source-1:rev_3:line_1:span_0_6"
    assert fragments[1].text in "找工业摄像头\n至少 5MP\n"
    assert all(fragment.source_type == RequirementSourceType.USER_TEXT for fragment in fragments)


def test_pptx_extracts_text_and_table_cell_coordinates():
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
    textbox.text = "采购工业摄像头"
    table = slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(5), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "数量"
    table.cell(1, 0).text = "枪式摄像机"
    table.cell(1, 1).text = "20"
    stream = BytesIO()
    presentation.save(stream)

    fragments = extract_pptx_fragments(
        stream.getvalue(), project_id="p1", source_id="file-ppt", filename="need.pptx"
    )
    assert any(fragment.text == "采购工业摄像头" and "slide=1:shape=" in fragment.locator and "source=file-ppt" in fragment.locator for fragment in fragments)
    assert any(fragment.text == "20" and "table=1:row=2:cell=2" in fragment.locator for fragment in fragments)
