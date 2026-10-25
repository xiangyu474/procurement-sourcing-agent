from procurement_agent.agents.sourcing import (
    RESEARCHER_SYSTEM_PROMPT,
    SOURCING_SYSTEM_PROMPT,
    SUPERVISOR_SYSTEM_PROMPT,
    create_sourcing_agent,
    create_sourcing_supervisor,
    hello_tool,
)


def test_hello_tool_returns_deterministic_smoke_result():
    assert hello_tool.invoke({"message": "run-123"}) == "hello: run-123"


def test_sourcing_agent_prompt_states_evidence_and_price_guardrails():
    assert "formal quotation" in SOURCING_SYSTEM_PROMPT
    assert "untrusted" in SOURCING_SYSTEM_PROMPT
    assert "simulated historical supplier" in SOURCING_SYSTEM_PROMPT
    assert "model_quote" in RESEARCHER_SYSTEM_PROMPT
    assert "exactly from your delegation" in RESEARCHER_SYSTEM_PROMPT
    assert "Never invent" in SUPERVISOR_SYSTEM_PROMPT
    assert "change a channel" in SUPERVISOR_SYSTEM_PROMPT


def test_sourcing_agent_builds_a_deep_agent_graph():
    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(model="placeholder-for-construction-only", api_key="unused")
    agent = create_sourcing_agent(model)
    assert agent is not None


def test_sourcing_supervisor_has_one_reusable_researcher_type():
    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(model="placeholder-for-construction-only", api_key="unused")
    supervisor = create_sourcing_supervisor(model, researcher_tools=[hello_tool])
    assert supervisor is not None
    assert "supplier_researcher" in SUPERVISOR_SYSTEM_PROMPT
    assert "up to three" in SUPERVISOR_SYSTEM_PROMPT
    from deepagents.profiles.harness.harness_profiles import _harness_profile_for_model

    profile = _harness_profile_for_model(model, None)
    assert profile.general_purpose_subagent is not None
    assert profile.general_purpose_subagent.enabled is False
    assert {"execute", "read_file", "write_file"} <= profile.excluded_tools
