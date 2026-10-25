-- M2: workspace-scoped public intelligence and per-run provenance.
-- Public intelligence is separate from simulated historical suppliers/transactions.

CREATE TABLE IF NOT EXISTS sourcing_plans (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, run_id, plan_revision)
);

CREATE TABLE IF NOT EXISTS research_tasks (
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    id TEXT NOT NULL,
    research_question TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    findings_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, run_id, id)
);

CREATE TABLE IF NOT EXISTS intelligence_suppliers (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    website_domain TEXT,
    identity_status TEXT NOT NULL,
    role TEXT,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intelligence_suppliers_workspace_domain
    ON intelligence_suppliers(workspace_id, website_domain);

CREATE TABLE IF NOT EXISTS intelligence_products (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    product_category TEXT,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intelligence_products_workspace_model
    ON intelligence_products(workspace_id, model);

CREATE TABLE IF NOT EXISTS supplier_product_offerings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    relationship_status TEXT NOT NULL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE(workspace_id, supplier_id, product_id)
);

CREATE TABLE IF NOT EXISTS research_evidence (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    title TEXT NOT NULL,
    publisher TEXT,
    retrieved_at TEXT NOT NULL,
    locator TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    content_date_hints_json TEXT NOT NULL DEFAULT '[]',
    snapshot_r2_key TEXT NOT NULL,
    trust_notes TEXT NOT NULL,
    first_run_id TEXT NOT NULL,
    last_run_id TEXT NOT NULL,
    UNIQUE(workspace_id, normalized_url, content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_research_evidence_workspace_observed
    ON research_evidence(workspace_id, retrieved_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_entity_evidence (
    workspace_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('SUPPLIER', 'PRODUCT', 'OFFERING')),
    entity_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, entity_type, entity_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS research_evidence_tasks (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id, run_id, task_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS research_claims (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('SUPPLIER', 'PRODUCT_MODEL')),
    subject_id TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value TEXT NOT NULL,
    unit TEXT,
    status TEXT NOT NULL,
    evaluation_method TEXT NOT NULL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_claims_subject
    ON research_claims(workspace_id, subject_type, subject_id, attribute);

CREATE TABLE IF NOT EXISTS claim_evidence_links (
    workspace_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    source_quote TEXT NOT NULL,
    PRIMARY KEY(workspace_id, claim_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS project_candidates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    product_id TEXT,
    stage TEXT NOT NULL CHECK (stage IN ('DISCOVERED_LONG_LIST', 'SCREENED', 'NEEDS_VERIFICATION', 'RFQ_SHORTLIST', 'EXCLUDED')),
    rationale TEXT NOT NULL,
    open_questions_json TEXT NOT NULL,
    first_seen_run_id TEXT NOT NULL,
    last_seen_run_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_candidates_identity
    ON project_candidates(workspace_id, project_id, requirement_id, supplier_id, COALESCE(product_id, ''));

CREATE INDEX IF NOT EXISTS idx_project_candidates_project_stage
    ON project_candidates(workspace_id, project_id, stage, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_candidate_evidence (
    workspace_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id, candidate_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS research_actions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    research_question TEXT NOT NULL,
    channel TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    query TEXT,
    result_refs_json TEXT NOT NULL,
    remaining_gaps_json TEXT NOT NULL,
    decision TEXT NOT NULL,
    cost_search_calls INTEGER NOT NULL DEFAULT 0,
    cost_fetch_calls INTEGER NOT NULL DEFAULT 0,
    occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_actions_run
    ON research_actions(workspace_id, run_id, occurred_at);

CREATE TABLE IF NOT EXISTS research_run_costs (
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stop_reason_code TEXT,
    search_calls INTEGER NOT NULL,
    fetch_calls INTEGER NOT NULL,
    model_calls INTEGER NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    token_usage_observed INTEGER NOT NULL DEFAULT 0,
    model_call_details_json TEXT NOT NULL DEFAULT '[]',
    trace_run_ids_json TEXT NOT NULL DEFAULT '{}',
    candidate_count INTEGER NOT NULL,
    evidence_count INTEGER NOT NULL,
    reused_intelligence_count INTEGER NOT NULL,
    refreshed_intelligence_count INTEGER NOT NULL,
    ignored_intelligence_count INTEGER NOT NULL,
    warnings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, run_id)
);
