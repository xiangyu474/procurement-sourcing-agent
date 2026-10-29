-- M3-A: the technical check of a requirement against a product model.
--
-- One row per (project, requirement, candidate, demand revision). The
-- assessment JSON keeps the per-constraint verdicts, the reason codes, and
-- the evidence that was cited. A re-evaluation of the same demand revision
-- replaces the row; a new demand revision adds rows and leaves the old ones.

CREATE TABLE IF NOT EXISTS spec_assessments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    product_candidate_id TEXT NOT NULL,
    product_model_ref TEXT,
    demand_revision INTEGER NOT NULL DEFAULT 1,
    hard_spec_overall TEXT NOT NULL CHECK (hard_spec_overall IN ('PASS', 'FAIL', 'UNKNOWN')),
    overall_reason_codes_json TEXT NOT NULL,
    hard_constraint_count INTEGER NOT NULL DEFAULT 0,
    calculator_version TEXT NOT NULL,
    dsl_schema_version TEXT NOT NULL,
    assessment_json TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_assessments_identity
    ON spec_assessments(workspace_id, project_id, requirement_id, product_candidate_id, demand_revision);

CREATE INDEX IF NOT EXISTS idx_spec_assessments_project
    ON spec_assessments(workspace_id, project_id, hard_spec_overall, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_spec_assessments_requirement
    ON spec_assessments(workspace_id, project_id, requirement_id);
