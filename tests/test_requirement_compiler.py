from procurement_agent.domain.requirements import (
    ConflictValue,
    ConstraintOrigin,
    ConstraintOperator,
    DataConflict,
    Importance,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    RequirementSourceType,
    SourceFragment,
    ValueType,
)
from procurement_agent.ingestion.compiler import (
    _validated_compilation_payload,
    compile_requirement_fragments,
)


class FakeStructuredRunnable:
    def __init__(self, result):
        self.result = result

    def invoke(self, _messages):
        return self.result


class FakeChatModel:
    def __init__(self, result):
        self.result = result

    def with_structured_output(self, _schema, method=None, include_raw=False):
        assert method == "function_calling"
        assert include_raw is True
        return FakeStructuredRunnable(self.result)


def test_compiler_preserves_grounded_quote_and_source_origin():
    fragment = SourceFragment(
        source_id="user_text:p1:rev_1",
        source_type=RequirementSourceType.USER_TEXT,
        locator="user_text:p1:rev_1:line_1:span_0_20",
        text="电源模块额定功率至少7.5kW",
    )
    requirement = Requirement(
        requirement_id="req1",
        project_id="placeholder",
        product_name="电源模块",
        source_refs=[fragment.locator],
        constraints=[
            RequirementConstraint(
                constraint_id="c1",
                requirement_id="req1",
                attribute_key="rated_output_power",
                attribute_definition="额定输出功率",
                value_type=ValueType.NUMBER,
                operator=ConstraintOperator.GTE,
                value="7.5",
                unit="kW",
                importance=Importance.HARD,
                origin=ConstraintOrigin.PPT_EXPLICIT,
                source_ref=fragment.locator,
                source_quote="额定功率至少7.5kW",
            )
        ],
    )
    result = compile_requirement_fragments(
        project_id="p1",
        fragments=[fragment],
        model=FakeChatModel(RequirementCompilation(requirements=[requirement])),
        revision=1,
    )

    compiled = result.compilation.requirements[0]
    assert compiled.project_id == "p1"
    assert compiled.constraints[0].origin == ConstraintOrigin.USER_EXPLICIT
    assert compiled.constraints[0].parse_status.value == "RESOLVED"
    assert not result.grounding_issues


def test_compiler_downgrades_hallucinated_source_quote_to_ambiguous():
    fragment = SourceFragment(
        source_id="ppt-source",
        source_type=RequirementSourceType.INTERNAL_PPTX,
        locator="pptx:f1:slide=6:table=1:row=2:cell=2",
        text="电源模块",
    )
    requirement = Requirement(
        requirement_id="req1",
        project_id="p1",
        product_name="电源模块",
        source_refs=[fragment.locator],
        constraints=[
            RequirementConstraint(
                constraint_id="c1",
                requirement_id="req1",
                attribute_key="rated_output_power",
                attribute_definition="额定输出功率",
                value_type=ValueType.NUMBER,
                operator=ConstraintOperator.GTE,
                value="7.5",
                unit="kW",
                importance=Importance.HARD,
                origin=ConstraintOrigin.PPT_EXPLICIT,
                source_ref=fragment.locator,
                source_quote="额定功率至少7.5kW",
                parse_status="AMBIGUOUS",
            )
        ],
    )
    result = compile_requirement_fragments(
        project_id="p1",
        fragments=[fragment],
        model=FakeChatModel(RequirementCompilation(requirements=[requirement])),
    )
    constraint = result.compilation.requirements[0].constraints[0]
    assert constraint.parse_status.value == "AMBIGUOUS"
    assert constraint.source_ref is None
    assert any("citation failed" in issue for issue in result.grounding_issues)


def test_grounded_conflict_is_preserved_and_ungrounded_conflict_is_discarded():
    first = SourceFragment(
        source_id="ppt-source",
        source_type=RequirementSourceType.INTERNAL_PPTX,
        locator="pptx:file=brief:slide=2:shape=1",
        text="年度预计采购58万台",
    )
    second = SourceFragment(
        source_id="ppt-source",
        source_type=RequirementSourceType.INTERNAL_PPTX,
        locator="pptx:file=brief:slide=3:shape=1",
        text="年度预计采购63万台",
    )
    conflict = DataConflict(
        conflict_id="c-summary-quantity",
        project_id="p1",
        field="annual_procurement_quantity",
        values_with_source=[
            ConflictValue(value="58万台", source_ref=first.locator, source_quote="58万台"),
            ConflictValue(value="63万台", source_ref=second.locator, source_quote="63万台"),
        ],
    )
    result = compile_requirement_fragments(
        project_id="p1",
        fragments=[first, second],
        model=FakeChatModel(RequirementCompilation(conflicts=[conflict])),
    )
    assert len(result.compilation.conflicts) == 1
    assert [v.value for v in result.compilation.conflicts[0].values_with_source] == ["58万台", "63万台"]


def test_megapixel_basis_remains_ambiguous_without_sensor_or_output_qualifier():
    fragment = SourceFragment(
        source_id="text-1",
        source_type=RequirementSourceType.USER_TEXT,
        locator="user_text:p1:rev_1:span_0_15",
        text="摄像头分辨率至少500万像素",
    )
    requirement = Requirement(
        requirement_id="r1",
        project_id="p1",
        product_name="摄像头",
        source_refs=[fragment.locator],
        constraints=[
            RequirementConstraint(
                constraint_id="c-resolution",
                requirement_id="r1",
                attribute_key="image_resolution",
                attribute_definition="摄像头分辨率",
                value_type=ValueType.NUMBER,
                operator=ConstraintOperator.GTE,
                value="5",
                unit="MP",
                importance=Importance.HARD,
                origin=ConstraintOrigin.USER_EXPLICIT,
                source_ref=fragment.locator,
                source_quote="分辨率至少500万像素",
            )
        ],
    )
    result = compile_requirement_fragments(
        project_id="p1",
        fragments=[fragment],
        model=FakeChatModel(RequirementCompilation(requirements=[requirement])),
    )
    constraint = result.compilation.requirements[0].constraints[0]
    assert constraint.attribute_key == "resolution_unspecified"
    assert constraint.parse_status.value == "AMBIGUOUS"
    assert result.compilation.requirements[0].parse_status.value == "AMBIGUOUS"


def test_incomplete_model_requirement_is_demoted_to_unstructured():
    payload = {
        "project_id": "p1",
        "requirements": [
            {
                "requirement_id": "r1",
                "project_id": "p1",
                "source_refs": ["user_text:p1:rev_1:line_1:span_0_20"],
                "constraints": [
                    {
                        "attribute_key": "rated_output_power",
                        "attribute_definition": "额定输出功率",
                        "value_type": "NUMBER",
                        "operator": "GTE",
                        "value": 7.5,
                        "unit": "kW",
                        "source_ref": "user_text:p1:rev_1:line_1:span_0_20",
                        "source_quote": "至少7.5kW",
                        "importance": "HARD",
                        "origin": "USER_EXPLICIT",
                    }
                ],
            }
        ],
    }
    result = _validated_compilation_payload(payload)
    assert result.requirements == []
    assert result.unstructured_requirements
    assert result.unstructured_requirements[0].source_quote == "至少7.5kW"
