CREATE TABLE IF NOT EXISTS project_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    job_type TEXT NOT NULL CHECK (job_type IN ('COMPILE', 'SPEC_ASSESSMENT', 'DECISION', 'REPORT')),
    status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
    error TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_jobs_project
    ON project_jobs(workspace_id, project_id, job_type, created_at DESC);
