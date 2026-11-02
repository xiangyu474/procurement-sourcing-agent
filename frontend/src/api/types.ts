export type CallOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

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
