import importlib

from fastapi.testclient import TestClient


def test_health_endpoint_reports_configuration_state(monkeypatch):
    for name in ("GENESIS_BASE_URL", "GENESIS_ACCESS_TOKEN", "GENESIS_MODEL_ID", "TAVILY_API_KEY"):
        monkeypatch.delenv(name, raising=False)

    api_module = importlib.import_module("procurement_agent.api.app")
    api_module.settings = api_module.load_settings()

    client = TestClient(api_module.app)
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["llm_configured"] is False
    assert body["search_configured"] is False


def test_execute_endpoint_rejects_requests_without_a_token(monkeypatch):
    """The container must not accept a task that carries no internal token.

    The container is only reachable through the Durable Object binding, and
    the gateway validates the token on every callback it receives.
    """
    api_module = importlib.import_module("procurement_agent.api.app")
    api_module.settings = api_module.load_settings()

    client = TestClient(api_module.app)
    response = client.post(
        "/internal/execute",
        json={
            "run_id": "run-1",
            "gateway_url": "https://gateway.invalid",
            "token": "",
            "duration_seconds": 1,
        },
    )

    assert response.status_code == 401
