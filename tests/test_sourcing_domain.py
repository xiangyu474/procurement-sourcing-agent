from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from procurement_agent.domain.sourcing import (
    CandidateStage,
    ChannelHint,
    ClaimDraft,
    ResearchBudget,
    ResearchFindings,
    SourcingGoal,
    SourcingPlan,
    canonical_domain,
    stable_id,
)


def test_sourcing_plan_is_explicit_and_budget_is_bounded():
    plan = SourcingPlan(
        plan_id="plan-1",
        project_id="project-1",
        run_id="run-1",
        plan_revision=1,
        goal=SourcingGoal.NEW_SUPPLIER,
        goal_origin="INFERRED_FOR_REVIEW",
        prioritized_requirement_ids=["req-1"],
        target_markets=[],
        proposed_channels=[ChannelHint.MANUFACTURER_DIRECT, ChannelHint.PRODUCT_DATASHEET],
        research_questions=[
            {
                "question_id": "q-1",
                "requirement_id": "req-1",
                "question": "Find a real manufacturer and an exact product model for the requested item.",
                "channel": ChannelHint.MANUFACTURER_DIRECT,
                "expected_evidence": ["official product page", "model identifier"],
                "rationale": "Exact product identity is needed before M3 specification checks.",
            }
        ],
        rationale="Start with the named procurement category; market was not specified.",
        assumptions_for_review=["Use broad public discovery because no target market was supplied."],
        missing_material_inputs=["target market"],
        stopping_criteria=["Search budget reached", "only RFQ can resolve remaining supply claims"],
        budget=ResearchBudget(max_search_calls=4, max_fetches=3, max_tasks=2, max_rounds=2),
        created_at=datetime(2026, 10, 25, tzinfo=UTC),
    )
    assert plan.goal == SourcingGoal.NEW_SUPPLIER
    assert plan.target_markets == []
    assert plan.budget.max_tasks == 2


def test_sourcing_budget_rejects_parallelism_above_three():
    with pytest.raises(ValidationError):
        ResearchBudget(max_search_calls=12, max_fetches=24, max_tasks=4, max_rounds=3)


def test_claim_draft_requires_locatable_source_quote():
    with pytest.raises(ValidationError):
        ClaimDraft(
            claim_id="claim-1",
            subject_type="PRODUCT_MODEL",
            subject_ref="product-1",
            attribute="resolution",
            value="5",
            unit="MP",
            evidence_id="evidence-1",
            source_quote="",
        )


def test_research_findings_do_not_promote_supplier_to_qualified_status():
    finding = ResearchFindings(
        task_id="task-1",
        research_question="Find a supplier and exact model.",
        candidate_claims=[],
        evidence_ids=["evidence-1"],
        product_model_refs=[],
        unresolved_gaps=["manufacturer role needs confirmation"],
        coverage_notes="A source was captured; qualification was not assessed.",
    )
    assert finding.stage == CandidateStage.DISCOVERED_LONG_LIST


def test_domain_normalization_is_not_name_based_entity_merging():
    assert canonical_domain("https://www.Example.com:443/path?q=x") == "example.com"
    assert canonical_domain("not-a-url") is None
    assert stable_id("sup", "workspace", "acme.example") != stable_id("sup", "workspace", "other-acme.example")


def test_research_action_time_is_timezone_aware():
    from procurement_agent.domain.sourcing import ResearchAction

    with pytest.raises(ValidationError):
        ResearchAction(
            action_id="action-1",
            run_id="run-1",
            task_id="task-1",
            research_question="Find a product page.",
            channel=ChannelHint.PRODUCT_DATASHEET,
            tool_name="tavily.search",
            occurred_at=datetime(2026, 1, 1),
            decision="CONTINUE",
        )
    aware = ResearchAction(
        action_id="action-2",
        run_id="run-1",
        task_id="task-1",
        research_question="Find a product page.",
        channel=ChannelHint.PRODUCT_DATASHEET,
        tool_name="tavily.search",
        occurred_at=datetime(2026, 1, 1, tzinfo=UTC),
        decision="CONTINUE",
    )
    assert aware.occurred_at.tzinfo is not None
