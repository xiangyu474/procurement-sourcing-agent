import sqlite3
from pathlib import Path


def test_m2_migration_keeps_evidence_ledger_and_project_candidates_separate():
    repo = Path(__file__).resolve().parents[1]
    migration_dir = repo / "cloudflare" / "gateway" / "migrations"
    connection = sqlite3.connect(":memory:")
    for migration in sorted(migration_dir.glob("*.sql")):
        connection.executescript(migration.read_text(encoding="utf-8"))

    tables = {
        row[0]
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    assert {
        "sourcing_plans",
        "research_tasks",
        "intelligence_suppliers",
        "intelligence_products",
        "supplier_product_offerings",
        "research_evidence",
        "research_claims",
        "claim_evidence_links",
        "project_candidates",
        "research_actions",
        "research_run_costs",
    } <= tables
    cost_columns = {row[1] for row in connection.execute("PRAGMA table_info(research_run_costs)").fetchall()}
    assert {"status", "stop_reason_code", "model_call_details_json", "trace_run_ids_json", "langsmith_tracing_enabled"} <= cost_columns
    connection.execute(
        "INSERT INTO research_run_costs "
        "(workspace_id, project_id, run_id, status, stop_reason_code, search_calls, fetch_calls, model_calls, "
        "prompt_tokens, completion_tokens, token_usage_observed, model_call_details_json, trace_run_ids_json, "
        "candidate_count, evidence_count, reused_intelligence_count, refreshed_intelligence_count, "
        "ignored_intelligence_count, warnings_json, updated_at, langsmith_tracing_enabled) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("default", "project-a", "run-timeout", "PARTIAL", "MODEL_TIMEOUT", 1, 1, 2, 900, 120, 1, "[]", "{}", 0, 1, 0, 1, 0, "[]", "now", 0),
    )
    assert connection.execute(
        "SELECT status, stop_reason_code, model_calls FROM research_run_costs WHERE run_id='run-timeout'"
    ).fetchone() == ("PARTIAL", "MODEL_TIMEOUT", 2)

    # Same display name at distinct websites is not silently merged.
    connection.execute(
        "INSERT INTO intelligence_suppliers VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("s-a", "default", "Acme", "acme-one.example", "DISCOVERED_UNVERIFIED", None, "now", "now"),
    )
    connection.execute(
        "INSERT INTO intelligence_suppliers VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("s-b", "default", "Acme", "acme-two.example", "DISCOVERED_UNVERIFIED", None, "now", "now"),
    )
    assert connection.execute("SELECT count(*) FROM intelligence_suppliers WHERE display_name='Acme'").fetchone()[0] == 2

    # One shared global product may support distinct project-level candidates,
    # but candidate IDs are separately scoped to each project's requirements.
    connection.execute(
        "INSERT INTO intelligence_products VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("p-model", "default", "Vision camera", "Brand", "VC-1", "camera", "now", "now"),
    )
    for candidate_id, project_id in (("cand-a", "project-a"), ("cand-b", "project-b")):
        connection.execute(
            "INSERT INTO project_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (candidate_id, "default", project_id, "req-1", "s-a", "p-model", "DISCOVERED_LONG_LIST", "lead only", "[]", "run-1", "run-1", "now"),
        )
    assert connection.execute("SELECT count(*) FROM project_candidates WHERE product_id='p-model'").fetchone()[0] == 2

    # Replayed source+hash is idempotent; revised content becomes a new evidence version.
    evidence = (
        "e-v1", "default", "PUBLIC_WEB", "https://acme.example/p", "https://acme.example/p",
        "product", None, "now", "text:1-20", "Model VC-1", "a" * 64, "[]",
        "r2/e-v1", "attributed source", "run-1", "run-1",
    )
    evidence_sql = "INSERT INTO research_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"
    connection.execute(evidence_sql, evidence)
    connection.execute(evidence_sql, evidence)
    evidence_v2 = ("e-v2", *evidence[1:10], "b" * 64, evidence[11], "r2/e-v2", *evidence[13:])
    connection.execute(evidence_sql, evidence_v2)
    assert connection.execute("SELECT count(*) FROM research_evidence").fetchone()[0] == 2
