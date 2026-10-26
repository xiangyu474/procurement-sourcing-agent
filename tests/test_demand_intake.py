from io import BytesIO

from pptx import Presentation
from pptx.util import Inches

from procurement_agent.domain.requirements import (
    ConflictValue,
    DataConflict,
    Requirement,
    RequirementCompilation,
    RequirementSourceType,
    SourceFragment,
)
from procurement_agent.services.demand_intake import (
    build_demand_intake,
    bump_analysis_version,
)


class _ToolCallChunk:
    def __init__(self, arguments):
        self.tool_calls = [{"name": "RequirementCompilation", "args": arguments}]

    def __add__(self, _other):
        return self


class FakeModel:
    """Streams one tool call per source, the way the real compiler consumes the endpoint."""

    def __init__(self, results):
        self.results = results

    def bind_tools(self, tools, tool_choice=None):
        return self

    def stream(self, _messages, config=None):
        result = self.results.pop(0)
        payload = (
            result.model_dump(mode="json", exclude_none=True)
            if isinstance(result, RequirementCompilation)
            else result
        )
        yield _ToolCallChunk(payload)


def test_history_import_increments_analysis_version_only_once_per_dataset():
    assert bump_analysis_version(1, new_history_hash="abc", known_history_hashes=set()) == 2
    assert bump_analysis_version(2, new_history_hash="abc", known_history_hashes={"abc"}) == 2


def test_each_source_is_compiled_by_its_own_model_call():
    text_fragment = SourceFragment(
        source_id="text-1",
        source_type=RequirementSourceType.USER_TEXT,
        locator="user_text:project=p1:source=text-1:rev_1:span_0_20",
        text="通用摄像机采购数量100套",
    )
    text_compilation = RequirementCompilation(
        requirements=[
            Requirement(
                requirement_id="r-text",
                project_id="p1",
                product_name="通用摄像机",
                quantity="100",
                quantity_unit="套",
                source_refs=[text_fragment.locator],
            )
        ]
    )
    ppt_compilation = RequirementCompilation(
        requirements=[
            Requirement(
                requirement_id="r-ppt",
                project_id="p1",
                product_name="通用摄像机",
                quantity="200",
                quantity_unit="套",
                source_refs=["pptx:project=p1:source=ppt-1:file=r.pptx:slide=1:table=1:row=2"],
            )
        ],
        conflicts=[
            DataConflict(
                conflict_id="c-quantity",
                project_id="p1",
                field="quantity",
                values_with_source=[
                    ConflictValue(value="100", source_ref=text_fragment.locator, source_quote="100套"),
                    ConflictValue(value="200", source_ref="pptx:row", source_quote="200"),
                ],
            )
        ],
    )
    result = build_demand_intake(
        project_id="p1",
        fragments=[text_fragment, _pptx_fragment()],
        model=FakeModel([text_compilation, ppt_compilation]),
    )
    assert len(result.requirements) == 2
    assert {item.requirement_id for item in result.requirements} == {"text_1:r-text", "pptx_2:r-ppt"}
    quantity_conflict = next(item for item in result.conflicts if item.field == "quantity")
    assert {value.value for value in quantity_conflict.values_with_source} == {"100", "200"}
    assert result.history_availability.value == "NOT_PROVIDED"


def _pptx_fragment() -> SourceFragment:
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = slide.shapes.add_table(2, 2, Inches(1), Inches(1), Inches(4), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "采购数量（套）"
    table.cell(1, 0).text = "通用摄像机"
    table.cell(1, 1).text = "200"
    stream = BytesIO()
    presentation.save(stream)
    from procurement_agent.ingestion.pptx import extract_pptx_fragments

    fragments = extract_pptx_fragments(
        stream.getvalue(), project_id="p1", source_id="ppt-1", filename="requirement.pptx"
    )
    return fragments[-1]
