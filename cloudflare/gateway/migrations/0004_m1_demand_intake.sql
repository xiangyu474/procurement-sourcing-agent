-- M1: demand intake is primary; historical procurement remains optional and separate.
ALTER TABLE projects ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN demand_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN history_availability TEXT NOT NULL DEFAULT 'NOT_PROVIDED';

CREATE TABLE IF NOT EXISTS source_inputs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('REQUIREMENT', 'HISTORY', 'SUPPORTING_EVIDENCE')),
    source_type TEXT NOT NULL CHECK (source_type IN ('USER_TEXT', 'INTERNAL_PPTX', 'INTERNAL_XLSX', 'SUPPORTING_FILE')),
    revision INTEGER NOT NULL DEFAULT 1,
    filename TEXT,
    media_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    r2_key TEXT,
    text_content TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, id),
    UNIQUE(project_id, source_type, revision)
);

CREATE INDEX IF NOT EXISTS idx_source_inputs_project_purpose
    ON source_inputs(project_id, purpose, revision);

CREATE TABLE IF NOT EXISTS demand_compilations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    demand_revision INTEGER NOT NULL,
    analysis_version INTEGER NOT NULL,
    compiler_version TEXT NOT NULL,
    compilation_json TEXT NOT NULL,
    source_refs_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, demand_revision)
);

CREATE TABLE IF NOT EXISTS history_datasets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_input_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    column_count INTEGER NOT NULL,
    header_row INTEGER NOT NULL,
    is_synthetic INTEGER NOT NULL,
    supplier_namespace TEXT NOT NULL,
    schema_mapping_version TEXT NOT NULL,
    normalized_r2_key TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    UNIQUE(project_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_history_datasets_project
    ON history_datasets(project_id, imported_at);
