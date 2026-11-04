export type CallOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

export * from "./analysisTypes";

export type ProjectSource = {
	id: string;
	purpose: string;
	source_type: string;
	revision: number;
	filename: string | null;
	media_type: string;
	sha256: string;
	created_at: string;
};

export type Project = {
	id: string;
	title: string;
	analysis_version: number;
	demand_revision: number;
	history_availability: string;
	created_at: string;
	sources: ProjectSource[];
};

export type CreatedProject = {
	project_id: string;
	source_id: string | null;
	analysis_version: number;
};

export type TextRevision = {
	project_id: string;
	source_id: string;
	revision: number;
};

export type UploadedSource = {
	source_id: string;
	purpose: string;
	revision: number;
	sha256: string;
};

export type CompileQueued = {
	project_id: string;
	status: string;
	compile_id: string;
	analysis_version: number;
};

export type CompileJob = {
	compile_id: string;
	project_id: string;
	status: string;
	analysis_version: number | null;
	demand_revision: number | null;
	error: string | null;
};

export type ListedRun = {
	id: string;
	status: string;
	current_stage: string;
	updated_at: string;
};

export type ProjectSummary = {
	id: string;
	title: string;
	history_availability: string;
	demand_revision: number;
	analysis_version: number;
	created_at: string;
	latest_run: ListedRun | null;
};

export type ProjectRunSummary = {
	id: string;
	status: string;
	current_stage: string;
	last_error: string | null;
	stop_reason_code: string | null;
	artifact_key_present: boolean;
	created_at: string;
	updated_at: string;
};

export type RequirementText = {
	source_id: string;
	revision: number;
	text: string;
};

export type RequirementsDocument = {
	analysis_version: number;
	compilation: Record<string, unknown>;
};

export type RequirementsResult =
	| { state: "missing" }
	| { state: "ready"; body: RequirementsDocument };

export type HistoryImport = {
	dataset_id: string;
	row_count: number;
	column_count: number;
	is_synthetic: boolean;
	duplicate_import: boolean;
	analysis_version: number | null;
};

export type StartedRun = {
	run_id: string;
	status: string;
	reused: boolean;
};

/** POST /api/projects/{id}/pipeline 202 body. Field names match the published status API. */
export type StartedPipeline = {
	pipeline_id: string;
	run_id: string;
	demand_revision: number;
	status: string;
	reused: boolean;
};

export type PipelineStage = {
	stage: string;
	status: string;
	started_at: string | null;
	finished_at: string | null;
	error_code: string | null;
};

/** GET /api/projects/{id}/pipeline/{pipeline_id}. `status` is the analysis task; `report_status` is the report. */
export type Pipeline = {
	pipeline_id: string;
	project_id: string;
	run_id: string;
	demand_revision: number;
	status: string;
	stage: string | null;
	error: string | null;
	decision_version: string | null;
	report_id: string | null;
	report_status: string | null;
	report_error_code: string | null;
	download_path: string | null;
	candidates_found: number;
	models_found: number;
	evidence_found: number;
	stages: PipelineStage[];
	created_at: string;
	updated_at: string;
};

/** One entry of GET /api/projects/{id}/pipelines. */
export type PipelineListItem = {
	pipeline_id: string;
	run_id: string | null;
	demand_revision: number | null;
	status: string;
	stage: string | null;
	decision_version: string | null;
	report_id: string | null;
	report_status: string | null;
	created_at: string;
	updated_at: string;
};

export type Run = {
	id: string;
	project_id: string;
	status: string;
	current_stage: string;
	artifact_key: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
};

export type RunEvent = {
	stage: string;
	created_at: string;
};

export type CandidateEvidence = {
	evidence_id: string;
	source_url: string | null;
	title: string | null;
	retrieved_at: string | null;
	excerpt: string | null;
};

export type Candidate = {
	candidate_id: string;
	requirement_id: string | null;
	stage: string;
	last_seen_run_id: string | null;
	updated_at: string | null;
	supplier_name: string;
	model: string | null;
	evidence: CandidateEvidence[];
};

export type SpecCheck = {
	constraint_id: string | null;
	requirement_id: string | null;
	status: string | null;
	reason_code: string | null;
	operation: string | null;
	normalized_actual: string | null;
	normalized_required: string | null;
	unit: string | null;
	evidence_ids: string[];
	explanation: string | null;
	importance: string | null;
};

export type SpecAssessment = {
	assessment_id: string;
	requirement_id: string | null;
	product_candidate_id: string | null;
	demand_revision: number | null;
	hard_spec_overall: string | null;
	evidence_ids: string[];
	evaluated_at: string | null;
	created_at: string | null;
	checks: SpecCheck[];
};

export type SourcingDecision = {
	decision_id: string;
	requirement_id: string | null;
	product_candidate_id: string | null;
	recommendation: string | null;
	technical_verdict: string | null;
	hard_spec_overall: string | null;
	accepted: boolean;
	rationale: string | null;
	evidence_ids: string[];
	decided_at: string | null;
	created_at: string | null;
};

export type JobStatus = {
	status: string;
	job_id: string | null;
	demand_revision: number | null;
	error: string | null;
	updated_at: string | null;
};

export type Report = {
	report_id: string;
	run_id: string | null;
	status: string;
	decision_version: string | null;
	error: string | null;
	download_path: string | null;
	created_at: string | null;
	updated_at: string | null;
};

export type EvidenceDetail = {
	evidence_id: string;
	title: string | null;
	source_url: string | null;
	retrieved_at: string | null;
	excerpt: string | null;
	snapshot_text: string | null;
};

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly body: unknown;

	constructor(status: number, code: string, body: unknown) {
		super(code);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.body = body;
	}
}
