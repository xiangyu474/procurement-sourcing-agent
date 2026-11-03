"""The sourcing plan is asked again when it carries no usable question."""

from __future__ import annotations

from typing import Any

import pytest

from procurement_agent.domain.requirements import (
    ConstraintOperator,
    Importance,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    ValueType,
)
from procurement_agent.services.sourcing_research import ResearchInputError, build_sourcing_plan


class _Plan:
    def __init__(self, payload: dict[str, Any]):
        self.payload = payload
        self.calls = 0
        self.messages: list[Any] = []

    def with_structured_output(self, *_args: Any, **_kwargs: Any) -> _Plan:
        return self

    def invoke(self, messages: list[Any], config: Any = None) -> Any:
        self.calls += 1
        self.messages = messages
        from procurement_agent.domain.sourcing import SourcingPlanProposal

        return {"raw": None, "parsed": SourcingPlanProposal.model_validate(self.payload)}


def _requirement() -> Requirement:
    return Requirement(
        requirement_id="text_1:r1",
        project_id="p1",
        product_name="5MP工业网络摄像机",
        quantity="10",
        quantity_unit="套",
        constraints=[
            RequirementConstraint(
                constraint_id="text_1:c1",
                requirement_id="text_1:r1",
                attribute_key="output_resolution",
                attribute_definition="视频输出分辨率",
                value_type=ValueType.NUMBER,
                operator=ConstraintOperator.GTE,
                value="5",
                unit="MP",
                importance=Importance.HARD,
                origin="USER_EXPLICIT",
                source_ref="user_text:p1:line_1",
                source_quote="输出分辨率不低于5MP",
            )
        ],
    )


def _plan_payload(requirement_id: str | None) -> dict[str, Any]:
    return {
        "goal": "NEW_SUPPLIER",
        "goal_origin": "INFERRED_FOR_REVIEW",
        "prioritized_requirement_ids": [requirement_id or "text_1:r1"],
        "proposed_channels": ["GENERAL_WEB"],
        "research_questions": [{
            "question_id": "q1",
            "requirement_id": requirement_id,
            "channel": "GENERAL_WEB",
            "question": "5MP 工业网络摄像机 输出分辨率 规格",
            "expected_evidence": ["规格页"],
            "rationale": "需要公开规格来源",
        }],
        "rationale": "需要公开规格来源来核对输出分辨率。",
        "stopping_criteria": ["找到一份可核对的公开规格页"],
    }


def _settings():
    from procurement_agent.infra import load_settings

    return load_settings()


def test_a_plan_without_a_known_requirement_is_asked_again() -> None:
    class _Model(_Plan):
        def __init__(self):
            super().__init__(_plan_payload("unknown-id"))
            self.payloads = [_plan_payload("unknown-id"), _plan_payload("text_1:r1")]

        def invoke(self, messages: list[Any], config: Any = None) -> Any:
            self.calls += 1
            self.messages = messages
            from procurement_agent.domain.sourcing import SourcingPlanProposal

            return {"raw": None, "parsed": SourcingPlanProposal.model_validate(self.payloads[self.calls - 1])}

    model = _Model()
    compilation = RequirementCompilation(project_id="p1", requirements=[_requirement()])
    plan = build_sourcing_plan(
        model=model, compilation=compilation, project_id="p1", run_id="run-1", settings=_settings(),
    )
    assert model.calls == 2
    assert plan.research_questions
    assert plan.research_questions[0].requirement_id == "text_1:r1"
    assert any("requirement_id" in str(message.content) for message in model.messages)


def test_a_plan_that_never_becomes_usable_is_refused() -> None:
    model = _Plan(_plan_payload("unknown-id"))
    compilation = RequirementCompilation(project_id="p1", requirements=[_requirement()])
    with pytest.raises(ResearchInputError):
        build_sourcing_plan(
            model=model, compilation=compilation, project_id="p1", run_id="run-1", settings=_settings(),
        )
    assert model.calls == 2
