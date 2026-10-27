import json

from procurement_agent.domain.requirements import (
    ConflictValue,
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


class _FakeToolCallChunk:
    def __init__(self, arguments):
        self.tool_calls = [{"name": "RequirementCompilation", "args": arguments}]

    def __add__(self, _other):
        return self


class FakeChatModel:
    """Streams one tool call, the way the real compiler consumes the endpoint."""

    def __init__(self, result):
        self.result = result
        self.captured = []

    def bind_tools(self, tools, tool_choice=None):
        assert tools and tool_choice == tools[0]["name"]
        return self

    def stream(self, messages, config=None):
        self.captured.extend(messages)
        arguments = (
            self.result.model_dump(mode="json", exclude_none=True)
            if isinstance(self.result, RequirementCompilation)
            else self.result
        )
        yield _FakeToolCallChunk(arguments)


def _fragment(locator: str, text: str, source_type=RequirementSourceType.USER_TEXT) -> SourceFragment:
    return SourceFragment(
        source_id="source-1",
        source_type=source_type,
        locator=locator,
        text=text,
    )


def test_compiler_keeps_the_model_reading_and_assigns_project_scope():
    fragment = _fragment("user_text:p1:rev_1:line_1:span_0_20", "电源模块额定功率至少7.5kW")
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
                origin="PPT_EXPLICIT",
                source_ref=fragment.locator,
                source_quote="额定功率至少7.5kW",
            )
        ],
    )
    result = compile_requirement_fragments(
        project_id="p1",
        fragments=[fragment],
        model=FakeChatModel(RequirementCompilation(requirements=[requirement])),
        revision=2,
    )

    compiled = result.compilation.requirements[0]
    assert compiled.project_id == "p1"
    assert compiled.revision == 2
    assert compiled.constraints[0].source_quote == "额定功率至少7.5kW"
    assert compiled.constraints[0].parse_status.value == "RESOLVED"


def test_compiler_does_not_rewrite_the_model_citation():
    fragment = _fragment("pptx:f1:slide=6:table=1:row=2", "电源模块")
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
                origin="PPT_EXPLICIT",
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
    assert constraint.source_ref == fragment.locator
    assert constraint.source_quote == "额定功率至少7.5kW"
    assert constraint.parse_status.value == "AMBIGUOUS"


def test_compiler_keeps_every_conflict_the_model_reports():
    first = _fragment("pptx:file=brief:slide=2:shape=1", "年度预计采购58万台", RequirementSourceType.INTERNAL_PPTX)
    second = _fragment("pptx:file=brief:slide=3:shape=1", "年度预计采购63万台", RequirementSourceType.INTERNAL_PPTX)
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


def test_compiler_sends_every_fragment_to_the_model():
    fragments = [
        _fragment("doc:slide=1:table=1:row=1", "产品名称 | 数量"),
        _fragment("doc:slide=1:table=1:row=2", "工业摄像机 | 10"),
        _fragment("doc:slide=2:shape=1:paragraph=1", "至少支持CAN协议"),
    ]
    model = FakeChatModel(RequirementCompilation(requirements=[]))
    compile_requirement_fragments(project_id="p1", fragments=fragments, model=model)

    payload = json.loads(model.captured[-1].content)
    assert [item["locator"] for item in payload["fragments"]] == [f.locator for f in fragments]
    assert [item["text"] for item in payload["fragments"]] == [f.text for f in fragments]


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


def test_several_tool_calls_are_merged_into_one_compilation():
    from procurement_agent.ingestion.compiler import merge_compilation_payloads

    merged = merge_compilation_payloads([
        {
            "requirements": [{"requirement_id": "r1", "product_name": "产品一"}],
            "conflicts": [{"conflict_id": "c1", "values_with_source": []}],
        },
        {
            "requirements": [{"requirement_id": "r2", "product_name": "产品二"}],
            "unstructured_requirements": [{"text": "口径说明"}],
        },
    ])
    assert [item["requirement_id"] for item in merged["requirements"]] == ["r1", "r2"]
    assert len(merged["conflicts"]) == 1
    assert len(merged["unstructured_requirements"]) == 1


def test_a_call_that_carries_the_line_item_at_its_root_becomes_a_requirement():
    from procurement_agent.ingestion.compiler import merge_compilation_payloads

    merged = merge_compilation_payloads([
        {"requirement_id": "r1", "product_name": "产品一", "quantity": "10"},
    ])
    assert merged["requirements"] == [{"requirement_id": "r1", "product_name": "产品一", "quantity": "10"}]


def test_an_amount_written_as_a_json_string_is_read_as_an_object():
    payload = {
        "requirements": [
            {
                "requirement_id": "r1",
                "project_id": "p1",
                "product_name": "产品一",
                "planned_unit_price": json.dumps(
                    {
                        "kind": "PLANNED_PRICE",
                        "value": "125.00",
                        "source_ref": "doc:row=2",
                        "source_quote": "125.00",
                    },
                    ensure_ascii=False,
                ),
            }
        ]
    }
    result = _validated_compilation_payload(payload)
    assert len(result.requirements) == 1
    assert result.requirements[0].planned_unit_price.value == "125.00"


def test_a_compilation_wrapped_in_a_json_string_is_unwrapped():
    from procurement_agent.ingestion.compiler import merge_compilation_payloads

    inner = json.dumps(
        {
            "requirements": [{"requirement_id": "r1", "product_name": "产品一"}],
            "conflicts": [],
        },
        ensure_ascii=False,
    )
    merged = merge_compilation_payloads([{"result": inner}])
    assert [item["requirement_id"] for item in merged["requirements"]] == ["r1"]


def test_a_requirements_list_written_as_a_json_string_is_read():
    from procurement_agent.ingestion.compiler import merge_compilation_payloads

    merged = merge_compilation_payloads([
        {
            "requirements": json.dumps(
                [{"requirement_id": "r1", "product_name": "产品一"}], ensure_ascii=False
            )
        }
    ])
    assert [item["requirement_id"] for item in merged["requirements"]] == ["r1"]
