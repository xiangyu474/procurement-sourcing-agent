-- Each pipeline decision snapshot has one reusable report record. Report
-- lifecycle is independent from the terminal analysis outcome.
ALTER TABLE project_pipelines ADD COLUMN report_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (report_status IN ('NOT_STARTED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'));
ALTER TABLE project_pipelines ADD COLUMN report_error_code TEXT;
ALTER TABLE project_reports ADD COLUMN pipeline_id TEXT;
ALTER TABLE project_reports ADD COLUMN workflow_id TEXT;
ALTER TABLE project_reports ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_report_pipeline_decision
    ON project_reports(pipeline_id, decision_version) WHERE pipeline_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_project_run
    ON project_pipelines(project_id, run_id) WHERE run_id IS NOT NULL;
