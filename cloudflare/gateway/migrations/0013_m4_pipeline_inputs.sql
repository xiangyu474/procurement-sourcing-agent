-- Pipeline reservation and demand snapshot. Nothing in this migration starts
-- a workflow or makes an existing mutable decision into a frozen snapshot.
ALTER TABLE project_pipelines ADD COLUMN idempotency_key TEXT;
ALTER TABLE project_pipelines ADD COLUMN request_hash TEXT;
ALTER TABLE project_pipelines ADD COLUMN demand_snapshot_json TEXT;
ALTER TABLE project_pipelines ADD COLUMN demand_snapshot_sha256 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_project_idempotency
    ON project_pipelines(workspace_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_stages (
    pipeline_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    PRIMARY KEY (pipeline_id, stage),
    FOREIGN KEY (pipeline_id) REFERENCES project_pipelines(id)
);

-- A stage consumes a named immutable input/output, never a project-wide latest
-- query. Identical retries reuse the first value; conflicting writes are errors.
CREATE TABLE IF NOT EXISTS pipeline_snapshots (
    pipeline_id TEXT NOT NULL,
    snapshot_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (pipeline_id, snapshot_type),
    FOREIGN KEY (pipeline_id) REFERENCES project_pipelines(id)
);
