from procurement_agent.agents.sourcing import (
    SOURCING_SYSTEM_PROMPT,
    create_sourcing_agent,
    hello_tool,
)


def test_hello_tool_returns_deterministic_smoke_result():
    assert hello_tool.invoke({"message": "run-123"}) == "hello: run-123"


def test_sourcing_agent_prompt_states_evidence_and_price_guardrails():
    assert "formal quotation" in SOURCING_SYSTEM_PROMPT
    assert "untrusted" in SOURCING_SYSTEM_PROMPT
    assert "simulated historical supplier" in SOURCING_SYSTEM_PROMPT


def test_sourcing_agent_builds_a_deep_agent_graph():
    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(model="placeholder-for-construction-only", api_key="unused")
    agent = create_sourcing_agent(model)
    assert agent is not None
