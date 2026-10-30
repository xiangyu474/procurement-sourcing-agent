-- M3-C: the sourcing decision and the result of the verification gate.

-- One row per decision. The decision itself is kept with the violations the
-- gate found, so a rejected decision stays visible instead of disappearing.

CREATE TABLE IF NOT EXISTS sourcing_decisions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    product_candidate_id TEXT NOT NULL,
    product_model_ref TEXT,
    recommendation TEXT NOT NULL CHECK (recommendation IN ('SHORTLIST', 'INVESTIGATE', 'EXCLUDE')),
    technical_verdict TEXT NOT NULL CHECK (technical_verdict IN ('VERIFIED_PASS', 'VERIFIED_FAIL', 'UNVERIFIED')),
    hard_spec_overall TEXT NOT NULL CHECK (hard_spec_overall IN ('PASS', 'FAIL', 'UNKNOWN')),
    accepted INTEGER NOT NULL,
    priority_rank INTEGER,
    rationale TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    gaps_json TEXT NOT NULL,
    next_actions_json TEXT NOT NULL,
    violations_json TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sourcing_decisions_identity
    ON sourcing_decisions(workspace_id, project_id, requirement_id, product_candidate_id);

CREATE INDEX IF NOT EXISTS idx_sourcing_decisions_project
    ON sourcing_decisions(workspace_id, project_id, accepted, recommendation, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sourcing_decisions_requirement
    ON sourcing_decisions(workspace_id, project_id, requirement_id, priority_rank);
