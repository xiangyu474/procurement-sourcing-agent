from io import BytesIO

from pptx import Presentation
from pptx.util import Inches

from procurement_agent.domain.requirements import (
    ConstraintOrigin,
    ConstraintOperator,
    Importance,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    RequirementSourceType,
    SourceFragment,
    ValueType,
)
from procurement_agent.services.demand_intake import (
    build_demand_intake,
    bump_analysis_version,
    detect_requirement_conflicts,
)
from procurement_agent.ingestion.pptx import extract_pptx_fragments



def make_requirement(source_ref, quote, quantity, threshold):
    return Requirement(
        requirement_id=source_ref,
        project_id="p1",
        match_key="industrial_camera",
        product_name="工业摄像机",
        quantity=quantity,
        quantity_unit="套",
        source_refs=[source_ref],
        constraints=[
            RequirementConstraint(
                constraint_id=f"c-{source_ref}",
                requirement_id=source_ref,
                attribute_key="output_resolution",
                attribute_definition="视频输出分辨率",
                value_type=ValueType.NUMBER,
                operator=ConstraintOperator.GTE,
                value=threshold,
                unit="MP",
                importance=Importance.HARD,
                origin=ConstraintOrigin.USER_EXPLICIT if source_ref.startswith("user") else ConstraintOrigin.PPT_EXPLICIT,
                source_ref=source_ref,
                source_quote=quote,
            )
        ],
    )


def test_text_and_ppt_conflicts_are_explicit_not_silently_overwritten():
    requirements = [
        make_requirement("user_text:p1:rev_1:span_0_5", "至少5MP", "100", "5"),
        make_requirement("pptx:f1:slide=6:table=1:row=2:cell=3", "至少4MP", "200", "4"),
    ]
    conflicts = detect_requirement_conflicts("p1", requirements)
    assert {item.field for item in conflicts} == {"quantity", "output_resolution"}
    assert all(len(item.values_with_source) == 2 for item in conflicts)


def test_history_import_increments_analysis_version_only_once_per_dataset():
    assert bump_analysis_version(1, new_history_hash="abc", known_history_hashes=set()) == 2
    assert bump_analysis_version(2, new_history_hash="abc", known_history_hashes={"abc"}) == 2


def test_text_and_pptx_sources_keep_conflicting_quantities_instead_of_overwriting():
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    table = slide.shapes.add_table(2, 2, Inches(1), Inches(1), Inches(4), Inches(2)).table
    table.cell(0, 0).text = "产品名称"
    table.cell(0, 1).text = "采购数量（套）"
    table.cell(1, 0).text = "通用摄像机"
    table.cell(1, 1).text = "200"
    stream = BytesIO()
    presentation.save(stream)
    ppt_fragments = extract_pptx_fragments(
        stream.getvalue(), project_id="p1", source_id="ppt-1", filename="requirement.pptx"
    )
    text_fragment = SourceFragment(
        source_id="text-1",
        source_type=RequirementSourceType.USER_TEXT,
        locator="user_text:project=p1:source=text-1:rev_1:span_0_20",
        text="通用摄像机采购数量100套",
    )
    compiled_text = RequirementCompilation(
        requirements=[
            Requirement(
                requirement_id="r-text",
                project_id="p1",
                match_key="通用摄像机",
                product_name="通用摄像机",
                quantity="100",
                quantity_unit="套",
                source_refs=[text_fragment.locator],
            )
        ]
    )

    class FakeRunnable:
        def invoke(self, _messages):
            return compiled_text

    class FakeModel:
        def with_structured_output(self, _schema, **_kwargs):
            return FakeRunnable()

    result = build_demand_intake(
        project_id="p1",
        fragments=[text_fragment, *ppt_fragments],
        model=FakeModel(),
    )
    assert len(result.requirements) == 2
    quantity_conflict = next(c for c in result.conflicts if c.field == "quantity")
    assert {v.value for v in quantity_conflict.values_with_source} == {"100", "200"}
    assert all(v.source_ref for v in quantity_conflict.values_with_source)
    assert result.history_availability.value == "NOT_PROVIDED"
