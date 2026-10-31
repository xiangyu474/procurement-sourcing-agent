-- M3: the versioned cache of the semantic judgements.
--
-- A cache entry is found by the digest of the content that produced it. The
-- first writer of a digest wins, so two runs that judge the same thing at the
-- same time cannot overwrite each other. A later run that reaches a different
-- answer for the same digest is kept as a conflict instead of being hidden.

CREATE TABLE IF NOT EXISTS judgment_cache (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    layer TEXT NOT NULL CHECK (layer IN ('TYPING', 'ALIGNMENT', 'ASSESSMENT')),
    input_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    versions_json TEXT NOT NULL,
    model_config_json TEXT NOT NULL,
    evidence_hashes_json TEXT NOT NULL,
    source_run_id TEXT,
    source_project_id TEXT,
    verdict TEXT,
    reason_codes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_judgment_cache_identity
    ON judgment_cache(workspace_id, layer, input_digest);

CREATE INDEX IF NOT EXISTS idx_judgment_cache_layer
    ON judgment_cache(workspace_id, layer, created_at DESC);

CREATE TABLE IF NOT EXISTS judgment_cache_conflicts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    layer TEXT NOT NULL CHECK (layer IN ('TYPING', 'ALIGNMENT', 'ASSESSMENT')),
    input_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    model_config_json TEXT NOT NULL,
    reason_codes_json TEXT NOT NULL,
    source_run_id TEXT,
    source_project_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_judgment_cache_conflicts_digest
    ON judgment_cache_conflicts(workspace_id, layer, input_digest, created_at DESC);

-- A judgement is versioned. A re-review creates a new version and keeps the
-- old one, with the reason for the review.
ALTER TABLE spec_assessments ADD COLUMN judgment_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE spec_assessments ADD COLUMN review_reason TEXT;
ALTER TABLE spec_assessments ADD COLUMN input_digest TEXT;
ALTER TABLE spec_assessments ADD COLUMN model_config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE spec_assessments ADD COLUMN prompt_versions_json TEXT NOT NULL DEFAULT '{}';

DROP INDEX IF EXISTS idx_spec_assessments_identity;
CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_assessments_identity
    ON spec_assessments(workspace_id, project_id, requirement_id, product_candidate_id, demand_revision, judgment_version);

CREATE INDEX IF NOT EXISTS idx_spec_assessments_digest
    ON spec_assessments(workspace_id, input_digest);
