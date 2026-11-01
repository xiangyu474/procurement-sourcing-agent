CREATE TABLE IF NOT EXISTS project_reports (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT,
    decision_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
    r2_key TEXT,
    sha256 TEXT,
    byte_size INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_reports_project
    ON project_reports(workspace_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_reports_status
    ON project_reports(workspace_id, status, updated_at DESC);
