import sqlite3
from pathlib import Path


def test_m1_migrations_add_revisioned_demand_and_separate_history_tables():
    repo = Path(__file__).resolve().parents[1]
    migration_dir = repo / "cloudflare" / "gateway" / "migrations"
    connection = sqlite3.connect(":memory:")
    for migration in sorted(migration_dir.glob("*.sql")):
        connection.executescript(migration.read_text(encoding="utf-8"))

    project_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(projects)").fetchall()
    }
    assert {"analysis_version", "demand_revision", "history_availability"} <= project_columns

    source_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(source_inputs)").fetchall()
    }
    assert {"purpose", "source_type", "revision", "sha256", "r2_key", "text_content"} <= source_columns

    history_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(history_datasets)").fetchall()
    }
    assert {"content_sha256", "row_count", "is_synthetic", "supplier_namespace", "analysis_version"} <= history_columns

    connection.execute(
        "INSERT INTO projects (id, title, created_at, analysis_version, demand_revision, history_availability) "
        "VALUES ('p1', 'text-only', 'now', 1, 1, 'NOT_PROVIDED')"
    )
    connection.execute(
        "INSERT INTO source_inputs (id, project_id, purpose, source_type, revision, media_type, sha256, text_content, created_at) "
        "VALUES ('s1', 'p1', 'REQUIREMENT', 'USER_TEXT', 1, 'text/plain', 'hash', 'requirement', 'now')"
    )
    connection.execute(
        "INSERT INTO demand_compilations (id, project_id, demand_revision, analysis_version, compiler_version, compilation_json, source_refs_json, created_at) "
        "VALUES ('c1', 'p1', 1, 1, 'm1', '{}', '[]', 'now')"
    )
    assert connection.execute("SELECT count(*) FROM source_inputs").fetchone()[0] == 1
    assert connection.execute("SELECT count(*) FROM demand_compilations").fetchone()[0] == 1

    # Duplicate file contents in the same project are prevented at the dataset layer.
    connection.execute(
        "INSERT INTO history_datasets (id, project_id, source_input_id, content_sha256, row_count, column_count, header_row, is_synthetic, supplier_namespace, schema_mapping_version, normalized_r2_key, analysis_version, imported_at) "
        "VALUES ('h1', 'p1', 's1', 'same-hash', 1000, 38, 8, 1, 'HISTORICAL_SUPPLIER_SIMULATED', 'v1', 'r2/key', 2, 'now')"
    )
    try:
        connection.execute(
            "INSERT INTO history_datasets (id, project_id, source_input_id, content_sha256, row_count, column_count, header_row, is_synthetic, supplier_namespace, schema_mapping_version, normalized_r2_key, analysis_version, imported_at) "
            "VALUES ('h2', 'p1', 's1', 'same-hash', 1000, 38, 8, 1, 'HISTORICAL_SUPPLIER_SIMULATED', 'v1', 'r2/key2', 3, 'later')"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("duplicate history dataset hash was not rejected")
