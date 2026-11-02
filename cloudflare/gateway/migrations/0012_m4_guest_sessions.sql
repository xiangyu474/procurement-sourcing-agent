-- The guest session of a visitor, the projects it owns, and the pipeline that
-- chains the stages of one procurement task.
CREATE TABLE IF NOT EXISTS guest_sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    pipeline_count INTEGER NOT NULL DEFAULT 0,
    user_agent_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_expiry
    ON guest_sessions(expires_at);

ALTER TABLE projects ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_session
    ON projects(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_pipelines (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT,
    run_id TEXT,
    demand_revision INTEGER,
    status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
    stage TEXT,
    stages_json TEXT NOT NULL DEFAULT '{}',
    decision_version TEXT,
    report_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_pipelines_identity
    ON project_pipelines(workspace_id, project_id, id);

CREATE INDEX IF NOT EXISTS idx_project_pipelines_project
    ON project_pipelines(workspace_id, project_id, created_at DESC);
