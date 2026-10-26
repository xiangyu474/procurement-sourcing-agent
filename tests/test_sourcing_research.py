import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from langchain_core.messages import ToolMessage

from procurement_agent.domain.requirements import (
    ConstraintOperator,
    ConstraintOrigin,
    Importance,
    PlannedAmount,
    Requirement,
    RequirementCompilation,
    RequirementConstraint,
    TaxBasis,
    ValueType,
)
from procurement_agent.domain.sourcing import (
    CandidateClaim,
    CandidateStage,
    ChannelHint,
    ClaimProposal,
    RequirementAssociationOrigin,
    ResearchBudget,
    ResearchFindings,
    ResearchQuestion,
    ResearchQuestionProposal,
    ReuseDecisionProposal,
    SourcingGoal,
    SourcingPlan,
    SourcingPlanProposal,
)
from procurement_agent.infra import load_settings
from procurement_agent.infra.search import (
    FakeContentProvider,
    FakeSearchProvider,
    FetchedPage,
    SearchResult,
)
from procurement_agent.services.sourcing_research import (
    ResearchBudgetExceeded,
    ResearchInputError,
    ResearchLedger,
    RunModelBudget,
    _date_hint_is_old,
    _extract_date_hints,
    _validated_sourcing_plan_proposal,
    build_research_tools,
    build_sourcing_plan,
    run_sourcing_research,
)


class _FixedStructuredModel:
    def __init__(self, payload):
        self.payload = payload

    def with_structured_output(self, _schema, **_kwargs):
        return self

    def invoke(self, _messages, config=None):
        return self.payload


def make_compilation() -> RequirementCompilation:
    return RequirementCompilation(
        project_id="p-1",
        requirements=[
            Requirement(
                requirement_id="req-1",
                project_id="p-1",
                product_name="工业摄像机",
                product_category="视觉设备",
                source_product_code="INTERNAL-SKU-9",
                quantity="100",
                quantity_unit="套",
                planned_unit_price=PlannedAmount(
                    value="125", currency="CNY", tax_basis=TaxBasis.UNKNOWN,
                    source_ref="pptx:slide=6:row=2", source_quote="预计采购单价125元",
                ),
                constraints=[
                    RequirementConstraint(
                        constraint_id="c-1",
                        requirement_id="req-1",
                        attribute_key="resolution",
                        attribute_definition="图像分辨率",
                        value_type=ValueType.NUMBER,
                        operator=ConstraintOperator.GTE,
                        value="5",
                        unit="MP",
                        importance=Importance.HARD,
                        origin=ConstraintOrigin.PPT_EXPLICIT,
                        source_ref="pptx:slide=6:row=2",
                        source_quote="分辨率不低于5MP",
                    )
                ],
                source_refs=["pptx:slide=6:row=2"],
            )
        ],
    )


def make_plan() -> SourcingPlan:
    question = ResearchQuestion(
        question_id="q-1",
        requirement_id="req-1",
        question="Find a real manufacturer and exact product model.",
        channel=ChannelHint.MANUFACTURER_DIRECT,
        expected_evidence=["official product page", "model identifier"],
        rationale="Official pages can establish a product line and exact model.",
    )
    return SourcingPlan(
        plan_id="plan-1",
        project_id="p-1",
        run_id="run-1",
        goal=SourcingGoal.UNKNOWN,
        goal_origin="INFERRED_FOR_REVIEW",
        prioritized_requirement_ids=["req-1"],
        proposed_channels=[ChannelHint.MANUFACTURER_DIRECT],
        research_questions=[question],
        rationale="Broad public discovery because no market was specified.",
        assumptions_for_review=["The user did not specify a target market."],
        stopping_criteria=["Shared search budget reached."],
        budget=ResearchBudget(max_search_calls=2, max_fetches=2, max_tasks=2, max_rounds=2),
        created_at=datetime(2026, 10, 25, tzinfo=UTC),
    )


def make_proposal(question_count: int = 1) -> SourcingPlanProposal:
    channels = [ChannelHint.MANUFACTURER_DIRECT, ChannelHint.PRODUCT_DATASHEET]
    return SourcingPlanProposal(
        goal=SourcingGoal.UNKNOWN,
        goal_origin="INFERRED_FOR_REVIEW",
        prioritized_requirement_ids=["req-1"],
        proposed_channels=channels[:question_count],
        research_questions=[
            ResearchQuestionProposal(
                question_id=f"q-{index}",
                requirement_id="req-1",
                question=(
                    "Find a real manufacturer and exact product model from an official product page."
                    if index == 1 else "Find an official datasheet for the exact product model and supporting parameters."
                ),
                channel=channels[index - 1],
                expected_evidence=["company identity", "exact model", "model-level product evidence"],
                rationale="A source with a concrete model and product data helps close the research gap.",
            )
            for index in range(1, question_count + 1)
        ],
        rationale="Start with manufacturer/product sources; no market was specified.",
        assumptions_for_review=["Broad public discovery is a default assumption, not a market restriction."],
        missing_material_inputs=["target market"],
        stopping_criteria=["Stop at the shared budget or when remaining facts require supplier confirmation."],
    )


class _ResearcherHarness:
    def __init__(self, researcher_tools, supervisor_tools, question_count: int, source_quote: str, follow_up: bool = False, model_quote: str = "AX-500"):
        self.researcher_tools = {item.name: item for item in researcher_tools}
        self.supervisor_tools = {item.name: item for item in supervisor_tools}
        self.question_count = question_count
        self.source_quote = source_quote
        self.follow_up = follow_up
        self.model_quote = model_quote

    async def ainvoke(self, _payload, config=None):
        plan = self.supervisor_tools["get_sourcing_plan"].invoke({})
        questions = plan["research_questions"][: self.question_count]
        search_tool = self.researcher_tools["search_public_web"]
        fetch_tool = self.researcher_tools["fetch_public_source"]

        async def run_one(question):
            task_id = question["question_id"]
            qtext = question["question"]
            channel = question["channel"]
            query = (
                "industrial camera manufacturer official product model"
                if channel == ChannelHint.MANUFACTURER_DIRECT.value
                else "industrial camera official datasheet exact model"
            )
            search = await asyncio.to_thread(
                search_tool.invoke,
                {
                    "task_id": task_id,
                    "query": query,
                    "purpose": "DISCOVER_SUPPLIER" if channel == ChannelHint.MANUFACTURER_DIRECT.value else "FIND_PRODUCT_DATASHEET",
                },
            )
            url = search["results"][0]["url"]
            page = await asyncio.to_thread(
                fetch_tool.invoke,
                {"task_id": task_id, "url": url},
            )
            evidence_id = page["evidence_id"]
            proposal = CandidateClaim(
                supplier_name="Acme Imaging",
                supplier_name_quote="Acme Imaging lists model AX-500.",
                supplier_website_domain="acme.example",
                supplier_evidence_id=evidence_id,
                product_name="Acme AX-500 Industrial Camera",
                product_name_quote="Acme Imaging lists model AX-500.",
                brand="Acme",
                brand_quote="Acme",
                model="AX-500",
                model_quote=self.model_quote,
                product_category="industrial camera",
                product_evidence_id=evidence_id,
                product_claims=[
                    ClaimProposal(
                        attribute="resolution",
                        value="5",
                        unit="MP",
                        evidence_id=evidence_id,
                        source_quote=self.source_quote,
                    )
                ],
                rationale="The fetched product page names an exact model and describes a specification.",
                unresolved_gaps=["manufacturer role needs independent confirmation"],
            )
            finding = ResearchFindings(
                task_id=task_id,
                research_question=qtext,
                candidate_claims=[proposal],
                evidence_ids=[evidence_id],
                product_model_refs=["AX-500"],
                unresolved_gaps=["current supply capacity is not publicly verified"],
                search_cost=1,
                fetch_cost=1,
                coverage_notes="One fetched source supports a product lead; it does not establish qualification.",
            )
            return ToolMessage(content=finding.model_dump_json(), tool_call_id=f"tool-{task_id}")

        messages = list(await asyncio.gather(*(run_one(question) for question in questions)))
        if self.follow_up and questions:
            revision = self.supervisor_tools["revise_sourcing_plan"].invoke({
                "requirement_id": questions[0]["requirement_id"],
                "question": "Find the manufacturer's current datasheet for the model identified in the first product page.",
                "channel": "PRODUCT_DATASHEET",
                "expected_evidence": ["official datasheet", "model-level parameter text"],
                "rationale": "The first source identified a model but left key model-level evidence gaps; a datasheet is a distinct next step.",
            })
            revised = self.supervisor_tools["get_sourcing_plan"].invoke({})
            followup_question = next(item for item in revised["research_questions"] if item["question_id"] == revision["question_id"])
            messages.append(await run_one(followup_question))
        return {"messages": messages}


def test_planner_accepts_the_persisted_m1_demand_result_envelope():
    envelope = make_compilation().model_dump(mode="json")
    envelope.update({
        "analysis_version": 1,
        "history_availability": "NOT_PROVIDED",
        "history_dataset_id": None,
        "issues": ["history remains optional"],
    })
    plan = build_sourcing_plan(
        model=_FixedStructuredModel(make_proposal(1)),
        compilation=envelope,
        project_id="p-1",
        run_id="persisted-m1-envelope",
        settings=load_settings(),
    )
    assert plan.prioritized_requirement_ids == ["req-1"]


def test_plan_guard_removes_unsupported_geo_and_goal_assumptions(monkeypatch):
    proposal = SourcingPlanProposal(
        goal=SourcingGoal.ALTERNATE_SOURCE,
        goal_origin="USER_EXPLICIT",
        target_markets=["United States"],
        target_markets_origin="INFERRED_FOR_REVIEW",
        prioritized_requirement_ids=["req-1", "unknown-req"],
        proposed_channels=[ChannelHint.MANUFACTURER_DIRECT, ChannelHint.PRODUCT_DATASHEET],
        research_questions=[
            ResearchQuestionProposal(
                question_id="model-question",
                requirement_id="req-1",
                question="Find the manufacturer and the exact model sold for the requested visual product.",
                channel=ChannelHint.MANUFACTURER_DIRECT,
                expected_evidence=["official company product page"],
                rationale="The product model is needed for subsequent evidence review.",
            )
        ],
        rationale="Discover broad sources; a target market was not explicit.",
        assumptions_for_review=[],
        missing_material_inputs=["target market"],
        reuse_decisions=[],
        stopping_criteria=["Stop when only RFQ can resolve the remaining supply promise."],
    )
    monkeypatch.setenv("SOURCING_MAX_SEARCH_CALLS", "5")
    monkeypatch.setenv("SOURCING_MAX_WEB_FETCHES", "6")
    settings = load_settings()
    plan = build_sourcing_plan(
        model=_FixedStructuredModel(proposal),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-1",
        settings=settings,
        now=datetime(2026, 10, 25, tzinfo=UTC),
    )

    assert plan.goal == SourcingGoal.UNKNOWN
    assert plan.target_markets == []
    assert plan.prioritized_requirement_ids == ["req-1"]
    assert plan.research_questions[0].question_id.startswith("q_")
    assert plan.budget.max_search_calls == 5
    assert any("no target market" in item.lower() for item in plan.assumptions_for_review)


def test_plan_parser_drops_provider_extras_and_associates_single_missing_requirement():
    raw = make_proposal(1).model_dump(mode="json")
    raw["proposed_channels_note"] = "unrecognized provider explanation"
    raw["research_questions"][0].pop("requirement_id")
    response = {
        "raw": SimpleNamespace(tool_calls=[{"args": raw}]),
        "parsed": None,
        "parsing_error": ValueError("extra field"),
    }
    proposal, issues = _validated_sourcing_plan_proposal(response)
    assert proposal.research_questions[0].requirement_id is None
    assert issues == []

    plan = build_sourcing_plan(
        model=_FixedStructuredModel(response),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="missing-requirement-id",
        settings=load_settings(),
    )
    assert plan.research_questions[0].requirement_id == "req-1"
    assert plan.research_questions[0].association_origin == RequirementAssociationOrigin.SINGLE_REQUIREMENT_FALLBACK
    assert "only structured requirement" in plan.rationale.lower()


def test_missing_requirement_association_is_not_guessed_for_multiple_requirements():
    from procurement_agent.services.sourcing_research import ResearchInputError

    raw = make_proposal(1).model_dump(mode="json")
    raw["research_questions"][0].pop("requirement_id")
    response = {"raw": SimpleNamespace(tool_calls=[{"args": raw}]), "parsed": None}
    compilation = make_compilation()
    second_requirement = compilation.requirements[0].model_copy(
        update={"requirement_id": "req-2", "product_name": "network access point"}
    )
    multi = compilation.model_copy(update={"requirements": [compilation.requirements[0], second_requirement]})

    with pytest.raises(ResearchInputError, match="no valid research question"):
        build_sourcing_plan(
            model=_FixedStructuredModel(response),
            compilation=multi,
            project_id="p-1",
            run_id="ambiguous-association",
            settings=load_settings(),
        )


def test_reuse_decision_without_requirement_id_is_ignored_for_multisku_project():
    compilation = make_compilation()
    second_requirement = compilation.requirements[0].model_copy(
        update={"requirement_id": "req-2", "product_name": "network access point"}
    )
    multi = compilation.model_copy(update={"requirements": [compilation.requirements[0], second_requirement]})
    proposal = make_proposal(1).model_copy(update={
        "reuse_decisions": [ReuseDecisionProposal(
            intelligence_id="prod-1",
            decision="REUSE",
            rationale="The cached product could be a useful lead for the project.",
        )]
    })
    plan = build_sourcing_plan(
        model=_FixedStructuredModel(proposal),
        compilation=multi,
        project_id="p-1",
        run_id="multisku-reuse",
        settings=load_settings(),
        existing_intelligence=[{"product_id": "prod-1", "last_observed_at": "2026-10-01T00:00:00+00:00"}],
        now=datetime(2026, 10, 25, tzinfo=UTC),
    )
    assert plan.reuse_intelligence_ids == []
    assert plan.ignored_intelligence_ids == ["prod-1"]
    assert plan.reuse_decisions[0].association_origin == RequirementAssociationOrigin.UNASSOCIATED_IGNORED


def test_plan_explains_recent_reuse_but_forces_stale_intelligence_refresh():
    proposal = SourcingPlanProposal(
        goal=SourcingGoal.UNKNOWN,
        goal_origin="INFERRED_FOR_REVIEW",
        prioritized_requirement_ids=["req-1"],
        proposed_channels=[ChannelHint.PRODUCT_DATASHEET],
        research_questions=[
            ResearchQuestionProposal(
                question_id="q-1",
                requirement_id="req-1",
                question="Find a current product datasheet for an exact device model.",
                channel=ChannelHint.PRODUCT_DATASHEET,
                expected_evidence=["manufacturer datasheet"],
                rationale="Model-level evidence can be refreshed from a primary source.",
            )
        ],
        rationale="Reuse recent intelligence as a lead and refresh old sources.",
        reuse_decisions=[
            {"intelligence_id": "prod-fresh", "decision": "REUSE", "rationale": "The source is recent and can be reused as a lead."},
            {"intelligence_id": "prod-stale", "decision": "REUSE", "rationale": "Model suggested reuse, but code must enforce freshness."},
            {"intelligence_id": "prod-old-doc", "decision": "REUSE", "rationale": "Model suggested reuse despite an old date mention."},
        ],
        stopping_criteria=["Stop at the shared budget or when only supplier confirmation remains."],
    )
    plan = build_sourcing_plan(
        model=_FixedStructuredModel(proposal),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-2",
        settings=load_settings(),
        existing_intelligence=[
            {"product_id": "prod-fresh", "last_observed_at": "2026-10-01T00:00:00+00:00"},
            {"product_id": "prod-stale", "last_observed_at": "2025-01-01T00:00:00+00:00"},
            {"product_id": "prod-old-doc", "last_observed_at": "2026-10-24T00:00:00+00:00", "freshness": "OLD_DATE_MENTION"},
        ],
        now=datetime(2026, 10, 25, tzinfo=UTC),
    )
    assert plan.reuse_intelligence_ids == ["prod-fresh"]
    assert plan.refresh_intelligence_ids == ["prod-old-doc", "prod-stale"]


def test_model_calls_share_a_hard_run_budget():
    from uuid import uuid4

    budget = RunModelBudget(max_model_calls=1)
    trace_id = uuid4()
    budget.on_chain_start({}, {}, run_id=trace_id, parent_run_id=None, metadata={"sourcing_run_id": "run-1", "research_phase": "SUPERVISOR"})
    call_id = uuid4()
    budget.on_chat_model_start({}, [], run_id=call_id, metadata={"research_phase": "PLAN"})
    from langchain_core.outputs import LLMResult

    budget.on_llm_end(
        LLMResult(generations=[], llm_output={"token_usage": {"prompt_tokens": 123, "completion_tokens": 45}}),
        run_id=call_id,
    )
    with pytest.raises(ResearchBudgetExceeded, match="model-call budget"):
        budget.on_chat_model_start({}, [], run_id=uuid4())
    assert budget.snapshot() == {
        "model_calls": 1,
        "prompt_tokens": 123,
        "completion_tokens": 45,
        "token_usage_observed": True,
        "trace_run_ids": {"SUPERVISOR": str(trace_id)},
        "model_call_details": [{
            "call_id": str(call_id),
            "stage": "PLAN",
            "duration_ms": budget.snapshot()["model_call_details"][0]["duration_ms"],
            "prompt_tokens": 123,
            "completion_tokens": 45,
            "token_usage_observed": True,
            "error_type": None,
        }],
    }


def test_source_date_hints_are_review_flags_not_verified_publication_dates():
    hints = _extract_date_hints("Technical data 09/2016; copyright 2018; another section 2023-04-12.")
    assert "09/2016" in hints
    assert "copyright 2018" in hints
    assert "2023-04-12" in hints
    assert _date_hint_is_old("09/2016") is True
    assert _date_hint_is_old("2023-04-12") is False


def test_research_tools_cannot_override_plan_question_or_channel():
    search = FakeSearchProvider()
    content = FakeContentProvider()
    ledger = ResearchLedger(
        project_id="p-1", run_id="run-1", plan=make_plan(),
        search_provider=search, content_provider=content, private_terms=[],
    )
    researcher_tools, _supervisor_tools = build_research_tools(ledger)
    search_tool = next(item for item in researcher_tools if item.name == "search_public_web")
    fetch_tool = next(item for item in researcher_tools if item.name == "fetch_public_source")
    assert set(search_tool.args) == {"task_id", "query", "purpose"}
    assert set(fetch_tool.args) == {"task_id", "url"}
    assert "exactly" in search_tool.args["task_id"]["description"].lower()


def test_fetch_tool_returns_recoverable_rejection_for_guessed_url_without_fetching_it():
    content = FakeContentProvider()
    ledger = ResearchLedger(
        project_id="p-1", run_id="run-1", plan=make_plan(),
        search_provider=FakeSearchProvider(), content_provider=content, private_terms=[],
    )
    researcher_tools, _ = build_research_tools(ledger)
    fetch_tool = next(item for item in researcher_tools if item.name == "fetch_public_source")
    response = fetch_tool.invoke({"task_id": "q-1", "url": "https://manufacturer.example/product"})
    assert response["error_code"] == "RESEARCH_INPUT_REJECTED"
    assert "call search_public_web first" in response["message"]
    assert ledger.fetch_calls == 0
    assert content.calls == []
    assert ledger.actions[-1].decision == "RESEARCH_INPUT_REJECTED"
    assert ledger.actions[-1].query is None


def test_ledger_blocks_internal_values_and_private_or_unlisted_urls():
    search = FakeSearchProvider(
        [SearchResult(url="https://manufacturer.example/product", title="camera", snippet="lead", rank=1, provider="fake")]
    )
    content = FakeContentProvider()
    ledger = ResearchLedger(
        project_id="p-1", run_id="run-1", plan=make_plan(),
        search_provider=search, content_provider=content,
        private_terms=["100", "125", "INTERNAL-SKU-9"],
    )
    with pytest.raises(ResearchInputError, match="exactly match"):
        ledger.search(task_id="invented-task", query="industrial camera manufacturer", purpose="DISCOVER_SUPPLIER")
    with pytest.raises(ResearchInputError, match="private requirement"):
        ledger.search(
            task_id="q-1", query="工业摄像机 100 套 125 元", purpose="DISCOVER_SUPPLIER",
        )
    with pytest.raises(ResearchInputError, match="public http"):
        ledger.fetch(task_id="q-1", url="http://127.0.0.1/admin")
    with pytest.raises(ResearchInputError, match="only URLs returned"):
        ledger.fetch(task_id="q-1", url="https://unlisted.example/page")


def test_ledger_fetches_only_search_hits_and_deduplicates_same_source():
    url = "https://manufacturer.example/product"
    search = FakeSearchProvider(
        [SearchResult(url=url, title="Model page", snippet="discoverable result", rank=1, provider="fake")]
    )
    page = FetchedPage(
        url=url,
        title="Model page",
        content="The supplier lists model IPC-500. Resolution: 5 MP. This is source content.",
    )
    content = FakeContentProvider({url: page})
    ledger = ResearchLedger(
        project_id="p-1", run_id="run-1", plan=make_plan(),
        search_provider=search, content_provider=content, private_terms=["100", "125"],
    )
    results = ledger.search(
        task_id="q-1", query="工业摄像机 manufacturer official product model", purpose="DISCOVER_SUPPLIER",
    )
    assert len(results) == 1
    first, text = ledger.fetch(task_id="q-1", url=url)
    second, _ = ledger.fetch(task_id="q-1", url=url)
    assert first.evidence_id == second.evidence_id
    assert "IPC-500" in text
    assert ledger.search_calls == 1
    assert ledger.fetch_calls == 1
    assert len(content.calls) == 1


def test_completed_researcher_findings_survive_a_later_supervisor_failure():
    from uuid import uuid4

    from procurement_agent.services.sourcing_research import ResearchFindingsCapture

    search = FakeSearchProvider()
    content = FakeContentProvider()
    ledger = ResearchLedger(
        project_id="p-1", run_id="run-1", plan=make_plan(),
        search_provider=search, content_provider=content, private_terms=[],
    )
    ledger.register_task("q-1")
    finding = ResearchFindings(
        task_id="q-1",
        research_question=make_plan().research_questions[0].question,
        candidate_claims=[],
        coverage_notes="Task completed before the Supervisor timed out.",
    )
    output = SimpleNamespace(update={"messages": [ToolMessage(content=finding.model_dump_json(), tool_call_id="task-1")]})
    ResearchFindingsCapture(ledger).on_tool_end(output, run_id=uuid4(), name="task")
    assert ledger.completed_findings["q-1"].coverage_notes == finding.coverage_notes


def test_supervisor_run_builds_source_grounded_longlist_and_deduplicates_parallel_findings(monkeypatch):
    import procurement_agent.services.sourcing_research as service

    page_url = "https://acme.example/products/ax-500"
    source_text = "Acme Imaging lists model AX-500. The AX-500 sensor has 5 MP resolution."
    search_provider = FakeSearchProvider([
        SearchResult(url=page_url, title="AX-500 product", snippet="search hint", rank=1, provider="fake")
    ])
    content_provider = FakeContentProvider({
        page_url: FetchedPage(url=page_url, title="AX-500 product", content=source_text)
    })
    question_count = 2

    def make_supervisor(model, researcher_tools, supervisor_tools):
        return _ResearcherHarness(researcher_tools, supervisor_tools, question_count, "The AX-500 sensor has 5 MP resolution.")

    monkeypatch.setattr(service, "create_sourcing_supervisor", make_supervisor)
    monkeypatch.setenv("SOURCING_MAX_SEARCH_CALLS", "4")
    monkeypatch.setenv("SOURCING_MAX_WEB_FETCHES", "4")
    monkeypatch.setenv("SOURCING_MAX_CONCURRENT_RESEARCHERS", "2")

    bundle = asyncio.run(run_sourcing_research(
        model=_FixedStructuredModel(make_proposal(question_count)),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-live-shape",
        settings=load_settings(),
        search_provider=search_provider,
        content_provider=content_provider,
    ))

    assert len(bundle.tasks) == 2
    assert len(bundle.candidates) == 1
    assert bundle.candidates[0].stage == CandidateStage.DISCOVERED_LONG_LIST
    assert len(bundle.suppliers) == 1
    assert len(bundle.products) == 1
    assert bundle.products[0].model == "AX-500"
    assert len(bundle.evidence) == 1
    assert len(bundle.claims) == 1
    from procurement_agent.services.sourcing_research import serialize_bundle_for_gateway
    persisted = serialize_bundle_for_gateway(bundle)
    assert persisted["evidence"][0]["snapshot_text"] == source_text
    assert bundle.search_calls == 2
    assert bundle.fetch_calls == 1
    assert len(content_provider.calls) == 1
    assert "not been assessed" in " ".join(bundle.candidates[0].open_questions).lower()


def test_supervisor_run_discards_claim_quote_not_present_in_snapshot(monkeypatch):
    import procurement_agent.services.sourcing_research as service

    page_url = "https://acme.example/products/ax-500"
    search_provider = FakeSearchProvider([
        SearchResult(url=page_url, title="AX-500 product", snippet="search hint", rank=1, provider="fake")
    ])
    content_provider = FakeContentProvider({
        page_url: FetchedPage(url=page_url, title="AX-500 product", content="Acme Imaging lists model AX-500.")
    })
    monkeypatch.setattr(
        service,
        "create_sourcing_supervisor",
        lambda _model, researcher_tools, supervisor_tools: _ResearcherHarness(
            researcher_tools, supervisor_tools, 1, "The AX-500 sensor has 5 MP resolution."
        ),
    )
    bundle = asyncio.run(run_sourcing_research(
        model=_FixedStructuredModel(make_proposal(1)),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-ungrounded-quote",
        settings=load_settings(),
        search_provider=search_provider,
        content_provider=content_provider,
    ))

    assert len(bundle.candidates) == 1
    assert bundle.claims == []
    assert any("quote" in warning.lower() or "unsupported claim" in warning.lower() for warning in bundle.warnings)
    assert bundle.tasks[0].findings is not None
    assert bundle.tasks[0].findings.candidate_claims[0].product_claims == []


def test_researcher_failure_returns_partial_bundle_with_captured_evidence(monkeypatch):
    import procurement_agent.services.sourcing_research as service

    page_url = "https://acme.example/products/ax-500"
    search_provider = FakeSearchProvider([
        SearchResult(url=page_url, title="AX-500 product", snippet="search hint", rank=1, provider="fake")
    ])
    content_provider = FakeContentProvider({
        page_url: FetchedPage(
            url=page_url,
            title="AX-500 product",
            content="Acme Imaging lists model AX-500. The AX-500 sensor has 5 MP resolution.",
        )
    })

    class _FailingSupervisor:
        async def ainvoke(self, *args, **kwargs):
            runner = _ResearcherHarness(
                self.researcher_tools, self.supervisor_tools, 1, "The AX-500 sensor has 5 MP resolution."
            )
            await runner.ainvoke(*args, **kwargs)
            raise TimeoutError("model timeout")

    def make_supervisor(_model, researcher_tools, supervisor_tools):
        _FailingSupervisor.researcher_tools = researcher_tools
        _FailingSupervisor.supervisor_tools = supervisor_tools
        return _FailingSupervisor()

    monkeypatch.setattr(service, "create_sourcing_supervisor", make_supervisor)
    bundle = asyncio.run(run_sourcing_research(
        model=_FixedStructuredModel(make_proposal(1)),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-partial",
        settings=load_settings(),
        search_provider=search_provider,
        content_provider=content_provider,
    ))

    assert bundle.evidence
    assert bundle.candidates == []
    assert bundle.status.value == "PARTIAL"
    assert bundle.stop_reason_code == "MODEL_TIMEOUT"
    assert any("TimeoutError" in warning for warning in bundle.warnings)


def test_model_timeout_before_any_research_is_failed_not_partial(monkeypatch):
    import procurement_agent.services.sourcing_research as service

    class _ImmediateTimeout:
        async def ainvoke(self, *_args, **_kwargs):
            raise TimeoutError("model endpoint timed out")

    monkeypatch.setattr(service, "create_sourcing_supervisor", lambda *_args, **_kwargs: _ImmediateTimeout())
    bundle = asyncio.run(run_sourcing_research(
        model=_FixedStructuredModel(make_proposal(1)),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-no-work-timeout",
        settings=load_settings(),
        search_provider=FakeSearchProvider(),
        content_provider=FakeContentProvider(),
    ))

    assert bundle.status.value == "FAILED"
    assert bundle.stop_reason_code == "MODEL_TIMEOUT"
    assert bundle.evidence == []


def test_supervisor_records_reasoned_plan_revision_for_a_followup_question(monkeypatch):
    import procurement_agent.services.sourcing_research as service

    page_url = "https://acme.example/products/ax-500"
    source_text = "Acme Imaging lists model AX-500. The AX-500 sensor has 5 MP resolution."
    search_provider = FakeSearchProvider([
        SearchResult(url=page_url, title="AX-500 product", snippet="search hint", rank=1, provider="fake")
    ])
    content_provider = FakeContentProvider({
        page_url: FetchedPage(url=page_url, title="AX-500 product", content=source_text)
    })
    monkeypatch.setattr(
        service,
        "create_sourcing_supervisor",
        lambda _model, researcher_tools, supervisor_tools: _ResearcherHarness(
            researcher_tools, supervisor_tools, 1, "The AX-500 sensor has 5 MP resolution.", follow_up=True
        ),
    )
    monkeypatch.setenv("SOURCING_MAX_CONCURRENT_RESEARCHERS", "2")
    bundle = asyncio.run(run_sourcing_research(
        model=_FixedStructuredModel(make_proposal(1)),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-follow-up",
        settings=load_settings(),
        search_provider=search_provider,
        content_provider=content_provider,
    ))

    assert bundle.plan.plan_revision == 2
    assert len(bundle.plan_history) == 1
    assert "first source identified a model" in (bundle.plan.revision_reason or "").lower()
    assert len(bundle.tasks) == 2
    assert len(bundle.candidates) == 1


def test_model_label_without_verbatim_source_quote_is_removed(monkeypatch):
    import procurement_agent.services.sourcing_research as service

    page_url = "https://acme.example/products/ax-500"
    search_provider = FakeSearchProvider([
        SearchResult(url=page_url, title="AX-500 product", snippet="search hint", rank=1, provider="fake")
    ])
    content_provider = FakeContentProvider({
        page_url: FetchedPage(
            url=page_url,
            title="AX-500 product",
            content="Acme Imaging lists model AX-500. The AX-500 sensor has 5 MP resolution.",
        )
    })
    monkeypatch.setattr(
        service,
        "create_sourcing_supervisor",
        lambda _model, researcher_tools, supervisor_tools: _ResearcherHarness(
            researcher_tools, supervisor_tools, 1, "The AX-500 sensor has 5 MP resolution.", model_quote="AX-999"
        ),
    )
    bundle = asyncio.run(run_sourcing_research(
        model=_FixedStructuredModel(make_proposal(1)),
        compilation=make_compilation(),
        project_id="p-1",
        run_id="run-bad-model-quote",
        settings=load_settings(),
        search_provider=search_provider,
        content_provider=content_provider,
    ))

    assert len(bundle.candidates) == 1
    assert bundle.products[0].model is None
    assert bundle.claims == []
    assert any("model label" in warning.lower() for warning in bundle.warnings)
