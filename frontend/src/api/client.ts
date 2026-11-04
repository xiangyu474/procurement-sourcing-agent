import {
	ApiError,
	type CallOptions,
	type CompileQueued,
	type CreatedProject,
	type HistoryImport,
	type Project,
	type ProjectSource,
	type CompileJob,
	type ProjectRunSummary,
	type ProjectSummary,
	type Report,
	type RequirementText,
	type RequirementsDocument,
	type RequirementsResult,
	type Candidate,
	type CandidateEvidence,
	type EvidenceDetail,
	type JobStatus,
	type Run,
	type RunEvent,
	type SourcingDecision,
	type SpecAssessment,
	type SpecCheck,
	type Pipeline,
	type PipelineListItem,
	type PipelineStage,
	type StartedPipeline,
	type StartedRun,
	type TextRevision,
	type UploadedSource,
	type Analysis,
	type AnalysisAssessment,
	type AnalysisCandidate,
	type AnalysisCheck,
	type AnalysisConstraint,
	type AnalysisDecision,
	type AnalysisDecisionDisplay,
	type AnalysisDisplayAction,
	type AnalysisDisplayGap,
	type AnalysisEvidence,
	type AnalysisPriceContext,
	type AnalysisPriceFinding,
	type AnalysisReport,
	type AnalysisRequirement,
	type AnalysisSummary,
	type AnalysisSummaryModel,
} from "./types";

export type ApiClientOptions = {
	baseUrl?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

/** The research depth of one pipeline. The backend owns the limits. */
export type ResearchBudget = {
	max_search_calls?: number;
	max_fetches?: number;
	max_tasks?: number;
	max_rounds?: number;
	max_model_calls?: number;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function resolveBaseUrl(explicit: string | undefined): string {
	const configured = explicit ?? import.meta.env.VITE_API_BASE_URL ?? "";
	return configured.replace(/\/$/, "");
}

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { error: text.slice(0, 300) };
	}
}

function errorCode(body: unknown, status: number): string {
	if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
		return (body as { error: string }).error;
	}
	return `http_${status}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ApiError(0, "invalid_response", { label });
	}
	return value as Record<string, unknown>;
}

/** A nested object that may be missing. A missing part is not a broken answer. */
function asOptionalRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function asString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new ApiError(0, "invalid_response", { key });
	return value;
}

function asNumber(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError(0, "invalid_response", { key });
	return value;
}

function asOptionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asCountMap(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
		if (typeof count === "number" && Number.isFinite(count)) out[key] = count;
	}
	return out;
}

function asListedRun(value: unknown): ProjectSummary["latest_run"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.id !== "string") return null;
	return {
		id: row.id,
		status: typeof row.status === "string" ? row.status : "",
		current_stage: typeof row.current_stage === "string" ? row.current_stage : "",
		updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
	};
}

function asProjectSummary(value: unknown): ProjectSummary {
	const row = asRecord(value, "project_summary");
	return {
		id: asString(row, "id"),
		title: asString(row, "title"),
		history_availability: asString(row, "history_availability"),
		demand_revision: asNumber(row, "demand_revision"),
		analysis_version: asNumber(row, "analysis_version"),
		created_at: asString(row, "created_at"),
		latest_run: asListedRun(row.latest_run),
	};
}

function asProjectRun(value: unknown): ProjectRunSummary {
	const row = asRecord(value, "project_run");
	return {
		id: asString(row, "id"),
		status: asString(row, "status"),
		current_stage: asString(row, "current_stage"),
		last_error: asOptionalString(row.last_error),
		stop_reason_code: asOptionalString(row.stop_reason_code),
		artifact_key_present: Boolean(row.artifact_key_present),
		created_at: asString(row, "created_at"),
		updated_at: asString(row, "updated_at"),
	};
}

function asSource(value: unknown): ProjectSource {
	const row = asRecord(value, "source");
	return {
		id: asString(row, "id"),
		purpose: asString(row, "purpose"),
		source_type: asString(row, "source_type"),
		revision: asNumber(row, "revision"),
		filename: asOptionalString(row.filename),
		media_type: asString(row, "media_type"),
		sha256: asString(row, "sha256"),
		created_at: asString(row, "created_at"),
	};
}

function asProject(value: unknown): Project {
	const row = asRecord(value, "project");
	if (!Array.isArray(row.sources)) throw new ApiError(0, "invalid_response", { key: "sources" });
	return {
		id: asString(row, "id"),
		title: asString(row, "title"),
		analysis_version: asNumber(row, "analysis_version"),
		demand_revision: asNumber(row, "demand_revision"),
		history_availability: asString(row, "history_availability"),
		created_at: asString(row, "created_at"),
		sources: row.sources.map(asSource),
	};
}

export type ResearchSummary = {
	stopReason: string | null;
	candidateCount: number | null;
};

export function readResearchSummary(body: unknown): ResearchSummary {
	const row = asRecord(body, "research");
	const metrics = row.metrics;
	if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
		return { stopReason: null, candidateCount: null };
	}
	const record = metrics as { stop_reason_code?: unknown; candidate_count?: unknown };
	const code = record.stop_reason_code;
	const count = record.candidate_count;
	return {
		stopReason: typeof code === "string" && code.length > 0 ? code : null,
		candidateCount: typeof count === "number" && Number.isFinite(count) ? count : null,
	};
}

export function readStopReason(body: unknown): string | null {
	return readResearchSummary(body).stopReason;
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asCandidateEvidence(value: unknown): CandidateEvidence | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.evidence_id !== "string" || !row.evidence_id) return null;
	return {
		evidence_id: row.evidence_id,
		source_url: asOptionalString(row.source_url),
		title: asOptionalString(row.title),
		retrieved_at: asOptionalString(row.retrieved_at),
		excerpt: asOptionalString(row.excerpt),
	};
}

function asCandidate(value: unknown): Candidate {
	const row = asRecord(value, "candidate");
	const supplier = row.supplier && typeof row.supplier === "object" ? (row.supplier as Record<string, unknown>) : {};
	const product = row.product && typeof row.product === "object" ? (row.product as Record<string, unknown>) : null;
	const name = asOptionalString(supplier.display_name) ?? "未注明供应商";
	const model = product ? asOptionalString(product.model) ?? asOptionalString(product.product_name) : null;
	const evidence = Array.isArray(row.evidence) ? row.evidence.map(asCandidateEvidence).filter((item): item is CandidateEvidence => item !== null) : [];
	return {
		candidate_id: asString(row, "candidate_id"),
		requirement_id: asOptionalString(row.requirement_id),
		stage: asString(row, "stage"),
		last_seen_run_id: asOptionalString(row.last_seen_run_id),
		updated_at: asOptionalString(row.updated_at),
		supplier_name: name,
		model,
		evidence,
	};
}

function asCheck(value: unknown): SpecCheck | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	return {
		constraint_id: asOptionalString(row.constraint_id),
		requirement_id: asOptionalString(row.requirement_id),
		status: asOptionalString(row.status),
		reason_code: asOptionalString(row.reason_code),
		operation: asOptionalString(row.operation),
		normalized_actual: asOptionalString(row.normalized_actual),
		normalized_required: asOptionalString(row.normalized_required),
		unit: asOptionalString(row.unit),
		evidence_ids: asStringList(row.evidence_ids),
		explanation: asOptionalString(row.explanation),
		importance: asOptionalString(row.importance),
	};
}

function asAssessment(value: unknown): SpecAssessment {
	const row = asRecord(value, "assessment");
	const body = row.assessment && typeof row.assessment === "object" ? (row.assessment as Record<string, unknown>) : {};
	const checks = Array.isArray(body.checks) ? body.checks.map(asCheck).filter((item): item is SpecCheck => item !== null) : [];
	return {
		assessment_id: asString(row, "assessment_id"),
		requirement_id: asOptionalString(row.requirement_id),
		product_candidate_id: asOptionalString(row.product_candidate_id),
		demand_revision: asOptionalNumber(row.demand_revision),
		hard_spec_overall: asOptionalString(row.hard_spec_overall),
		evidence_ids: asStringList(row.evidence_ids),
		evaluated_at: asOptionalString(row.evaluated_at),
		created_at: asOptionalString(row.created_at),
		checks,
	};
}

function asReport(value: unknown): Report {
	const row = asRecord(value, "report");
	return {
		report_id: asString(row, "report_id"),
		run_id: asOptionalString(row.run_id),
		status: asString(row, "status"),
		decision_version: asOptionalString(row.decision_version),
		error: asOptionalString(row.error),
		download_path: asOptionalString(row.download_path),
		created_at: asOptionalString(row.created_at),
		updated_at: asOptionalString(row.updated_at),
	};
}

function asDecision(value: unknown): SourcingDecision {
	const row = asRecord(value, "decision");
	return {
		decision_id: asString(row, "decision_id"),
		requirement_id: asOptionalString(row.requirement_id),
		product_candidate_id: asOptionalString(row.product_candidate_id),
		recommendation: asOptionalString(row.recommendation),
		technical_verdict: asOptionalString(row.technical_verdict),
		hard_spec_overall: asOptionalString(row.hard_spec_overall),
		accepted: row.accepted === true,
		rationale: asOptionalString(row.rationale),
		evidence_ids: asStringList(row.evidence_ids),
		decided_at: asOptionalString(row.decided_at),
		created_at: asOptionalString(row.created_at),
	};
}

export class ApiClient {
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: ApiClientOptions = {}) {
		this.baseUrl = resolveBaseUrl(options.baseUrl);
		// Native fetch throws if it is called as a method of this client.
		const impl = options.fetch ?? fetch;
		this.fetchImpl = (input, init) => impl(input, init);
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	listProjects(call?: CallOptions): Promise<ProjectSummary[]> {
		return this.request("/api/projects?limit=50", { call }).then((payload) => {
			const row = asRecord(payload, "projects");
			if (!Array.isArray(row.projects)) throw new ApiError(0, "invalid_response", { key: "projects" });
			return row.projects.map(asProjectSummary);
		});
	}

	listRuns(projectId: string, call?: CallOptions): Promise<ProjectRunSummary[]> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/runs`, { call }).then((payload) => {
			const row = asRecord(payload, "runs");
			if (!Array.isArray(row.runs)) throw new ApiError(0, "invalid_response", { key: "runs" });
			return row.runs.map(asProjectRun);
		});
	}

	getRequirementText(projectId: string, call?: CallOptions): Promise<RequirementText | null> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/requirement-text`, { call })
			.then((payload) => {
				const row = asRecord(payload, "requirement_text");
				return {
					source_id: asString(row, "source_id"),
					revision: asNumber(row, "revision"),
					text: asString(row, "text"),
				};
			})
			.catch((error: unknown) => {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			});
	}

	getCompileJob(projectId: string, compileId: string, call?: CallOptions): Promise<CompileJob> {
		return this.request(
			`/api/projects/${encodeURIComponent(projectId)}/requirement-compile/${encodeURIComponent(compileId)}`,
			{ call },
		).then((payload) => {
			const row = asRecord(payload, "compile_job");
			return {
				compile_id: asString(row, "compile_id"),
				project_id: asString(row, "project_id"),
				status: asString(row, "status"),
				analysis_version: asOptionalNumber(row.analysis_version),
				demand_revision: asOptionalNumber(row.demand_revision),
				error: asOptionalString(row.error),
			};
		});
	}

	createProject(title: string | undefined, call?: CallOptions): Promise<CreatedProject> {
		const body: { title?: string } = {};
		const trimmed = title?.trim();
		if (trimmed) body.title = trimmed;
		return this.request("/api/projects", { method: "POST", json: body, call }).then((payload) => {
			const row = asRecord(payload, "created_project");
			return {
				project_id: asString(row, "project_id"),
				source_id: asOptionalString(row.source_id),
				analysis_version: asNumber(row, "analysis_version"),
			};
		});
	}

	getProject(projectId: string, call?: CallOptions): Promise<Project> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}`, { call }).then(asProject);
	}

	addRequirementText(projectId: string, text: string, call?: CallOptions): Promise<TextRevision> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/requirement-text`, {
			method: "POST",
			json: { text },
			call,
		}).then((payload) => {
			const row = asRecord(payload, "text_revision");
			return {
				project_id: asString(row, "project_id"),
				source_id: asString(row, "source_id"),
				revision: asNumber(row, "revision"),
			};
		});
	}

	upload(projectId: string, purpose: "REQUIREMENT" | "HISTORY", file: File, call?: CallOptions): Promise<UploadedSource> {
		const form = new FormData();
		form.set("purpose", purpose);
		form.set("file", file, file.name);
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/upload-sessions`, {
			method: "POST",
			body: form,
			call: { ...call, timeoutMs: call?.timeoutMs ?? 60_000 },
		}).then((payload) => {
			const row = asRecord(payload, "upload");
			return {
				source_id: asString(row, "source_id"),
				purpose: asString(row, "purpose"),
				revision: asNumber(row, "revision"),
				sha256: asString(row, "sha256"),
			};
		});
	}

	compile(projectId: string, call?: CallOptions): Promise<CompileQueued> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/requirement-compile`, {
			method: "POST",
			call,
		}).then((payload) => {
			const row = asRecord(payload, "compile");
			return {
				project_id: asString(row, "project_id"),
				status: asString(row, "status"),
				compile_id: asString(row, "compile_id"),
				analysis_version: asNumber(row, "analysis_version"),
			};
		});
	}

	getRequirements(projectId: string, call?: CallOptions): Promise<RequirementsResult> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/requirements`, { call })
			.then((payload) => {
				const row = asRecord(payload, "requirements");
				const compilation = row.compilation;
				if (!compilation || typeof compilation !== "object" || Array.isArray(compilation)) {
					throw new ApiError(0, "invalid_response", { key: "compilation" });
				}
				const body: RequirementsDocument = {
					analysis_version: asNumber(row, "analysis_version"),
					compilation: compilation as Record<string, unknown>,
				};
				return { state: "ready", body } as const;
			})
			.catch((error: unknown) => {
				if (error instanceof ApiError && error.status === 404 && error.code === "not_compiled") {
					return { state: "missing" } as const;
				}
				throw error;
			});
	}

	importHistory(projectId: string, sourceId: string, call?: CallOptions): Promise<HistoryImport> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/history-imports`, {
			method: "POST",
			json: { source_id: sourceId },
			call: { ...call, timeoutMs: call?.timeoutMs ?? 180_000 },
		}).then((payload) => {
			const row = asRecord(payload, "history_import");
			const analysis = row.analysis_version;
			return {
				dataset_id: asString(row, "dataset_id"),
				row_count: asNumber(row, "row_count"),
				column_count: asNumber(row, "column_count"),
				is_synthetic: Boolean(row.is_synthetic),
				duplicate_import: Boolean(row.duplicate_import),
				analysis_version: typeof analysis === "number" ? analysis : null,
			};
		});
	}

	startPipeline(
		projectId: string,
		idempotencyKey: string,
		demandRevision: number,
		call?: CallOptions,
		researchBudget?: ResearchBudget,
	): Promise<StartedPipeline> {
		const body: { demand_revision: number; research_budget?: ResearchBudget } = { demand_revision: demandRevision };
		if (researchBudget) body.research_budget = researchBudget;
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/pipeline`, {
			method: "POST",
			json: body,
			headers: { "Idempotency-Key": idempotencyKey },
			call,
		}).then((payload) => {
			const row = asRecord(payload, "pipeline");
			return {
				pipeline_id: asString(row, "pipeline_id"),
				run_id: asString(row, "run_id"),
				demand_revision: asNumber(row, "demand_revision"),
				status: asString(row, "status"),
				reused: Boolean(row.reused),
			};
		});
	}

	getPipeline(projectId: string, pipelineId: string, call?: CallOptions): Promise<Pipeline> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/pipeline/${encodeURIComponent(pipelineId)}`, { call }).then(asPipeline);
	}

	/**
	 * The tasks of a project. `active=true` returns the tasks that are still running
	 * or whose report is still generating. It replaces the session storage memory
	 * of the last pipeline id: a refresh must find the task again.
	 */
	listProjectPipelines(projectId: string, options: { active?: boolean; limit?: number } = {}, call?: CallOptions): Promise<PipelineListItem[]> {
		const query = new URLSearchParams();
		if (options.active !== undefined) query.set("active", options.active ? "true" : "false");
		query.set("limit", String(options.limit ?? 20));
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/pipelines?${query}`, { call }).then((payload) => {
			const row = asRecord(payload, "pipelines");
			if (!Array.isArray(row.pipelines)) throw new ApiError(0, "invalid_response", { key: "pipelines" });
			return row.pipelines.map(asPipelineListItem);
		});
	}

	/**
	 * The frozen analysis of one run. Exactly one of `pipelineId` and `runId`
	 * may be given; the backend refuses a request that carries both or neither.
	 * The result never mixes two runs.
	 */
	getAnalysis(projectId: string, selector: { pipelineId?: string; runId?: string }, call?: CallOptions): Promise<Analysis> {
		const query = new URLSearchParams();
		if (selector.pipelineId) query.set("pipeline_id", selector.pipelineId);
		if (selector.runId) query.set("run_id", selector.runId);
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/analysis?${query}`, { call }).then(asAnalysis);
	}

	startRun(projectId: string, idempotencyKey: string, call?: CallOptions): Promise<StartedRun> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/runs`, {
			method: "POST",
			json: { mode: "SOURCING", idempotency_key: idempotencyKey },
			call,
		}).then((payload) => {
			const row = asRecord(payload, "run");
			return {
				run_id: asString(row, "run_id"),
				status: asString(row, "status"),
				reused: Boolean(row.reused),
			};
		});
	}

	getRun(runId: string, call?: CallOptions): Promise<Run> {
		return this.request(`/api/runs/${encodeURIComponent(runId)}`, { call }).then((payload) => {
			const row = asRecord(payload, "run");
			return {
				id: asString(row, "id"),
				project_id: asString(row, "project_id"),
				status: asString(row, "status"),
				current_stage: asString(row, "current_stage"),
				artifact_key: asOptionalString(row.artifact_key),
				last_error: asOptionalString(row.last_error),
				created_at: asString(row, "created_at"),
				updated_at: asString(row, "updated_at"),
			};
		});
	}

	getRunEvents(runId: string, call?: CallOptions): Promise<RunEvent[]> {
		return this.request(`/api/runs/${encodeURIComponent(runId)}/events`, { call }).then((payload) => {
			const row = asRecord(payload, "events");
			if (!Array.isArray(row.events)) throw new ApiError(0, "invalid_response", { key: "events" });
			return row.events.map((item) => {
				const event = asRecord(item, "event");
				return { stage: asString(event, "stage"), created_at: asString(event, "created_at") };
			});
		});
	}

	getStopReason(runId: string, call?: CallOptions): Promise<string | null> {
		return this.getResearchSummary(runId, call).then((summary) => summary.stopReason);
	}

	getResearchSummary(runId: string, call?: CallOptions): Promise<ResearchSummary> {
		return this.request(`/api/runs/${encodeURIComponent(runId)}/research`, { call }).then(readResearchSummary);
	}

	listCandidates(projectId: string, runId: string, call?: CallOptions): Promise<Candidate[]> {
		const query = new URLSearchParams({ run_id: runId });
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/candidates?${query}`, { call }).then((payload) => {
			const row = asRecord(payload, "candidates");
			if (!Array.isArray(row.candidates)) throw new ApiError(0, "invalid_response", { key: "candidates" });
			return row.candidates.map(asCandidate);
		});
	}

	listAssessments(projectId: string, call?: CallOptions): Promise<SpecAssessment[]> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/spec-assessments`, { call }).then((payload) => {
			const row = asRecord(payload, "assessments");
			if (!Array.isArray(row.assessments)) throw new ApiError(0, "invalid_response", { key: "assessments" });
			return row.assessments.map(asAssessment);
		});
	}

	listDecisions(projectId: string, call?: CallOptions): Promise<SourcingDecision[]> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/decisions`, { call }).then((payload) => {
			const row = asRecord(payload, "decisions");
			if (!Array.isArray(row.decisions)) throw new ApiError(0, "invalid_response", { key: "decisions" });
			return row.decisions.map(asDecision);
		});
	}

	getJobStatus(projectId: string, kind: "spec" | "decision", call?: CallOptions): Promise<JobStatus> {
		const path = kind === "spec" ? "spec-assessments/status" : "decisions/status";
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/${path}`, { call }).then((payload) => {
			const row = asRecord(payload, "job_status");
			return {
				status: asString(row, "status"),
				job_id: asOptionalString(row.job_id),
				demand_revision: asOptionalNumber(row.demand_revision),
				error: asOptionalString(row.error),
				updated_at: asOptionalString(row.updated_at),
			};
		});
	}

	/** 201 creates a session; 200 repeats the same expiry. Both bodies are `{ expires_at }`. Nothing is stored. */
	openSession(call?: CallOptions): Promise<void> {
		return this.request("/api/session", { method: "POST", json: {}, call, skipSessionRetry: true }).then((payload) => {
			assertExpiresAt(payload);
		});
	}

	readSession(call?: CallOptions): Promise<void> {
		return this.request("/api/session", { call, skipSessionRetry: true }).then((payload) => {
			assertExpiresAt(payload);
		});
	}

	listReports(projectId: string, call?: CallOptions): Promise<Report[]> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/reports`, { call }).then((payload) => {
			const row = asRecord(payload, "reports");
			if (!Array.isArray(row.reports)) throw new ApiError(0, "invalid_response", { key: "reports" });
			return row.reports.map(asReport);
		});
	}

	createReport(projectId: string, runId: string, call?: CallOptions): Promise<Report> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/reports`, {
			method: "POST",
			json: { run_id: runId },
			call,
		}).then((payload) => asReport(payload));
	}

	getReport(projectId: string, reportId: string, call?: CallOptions): Promise<Report> {
		return this.request(`/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}`, { call }).then(asReport);
	}

	downloadReport(downloadPath: string, call?: CallOptions): Promise<Blob> {
		if (!downloadPath.startsWith("/api/projects/") || !downloadPath.endsWith("/download")) {
			return Promise.reject(new ApiError(0, "invalid_response", { key: "download_path" }));
		}
		return this.fetchBlob(downloadPath, call);
	}

	getEvidence(evidenceId: string, call?: CallOptions): Promise<EvidenceDetail> {
		return this.request(`/api/evidence/${encodeURIComponent(evidenceId)}`, { call }).then((payload) => {
			const row = asRecord(payload, "evidence");
			const evidence = asRecord(row.evidence, "evidence");
			return {
				evidence_id: asString(evidence, "evidence_id"),
				title: asOptionalString(evidence.title),
				source_url: asOptionalString(evidence.source_url),
				retrieved_at: asOptionalString(evidence.retrieved_at),
				excerpt: asOptionalString(evidence.excerpt),
				snapshot_text: asOptionalString(evidence.snapshot_text),
			};
		});
	}

	private async fetchBlob(path: string, call?: CallOptions): Promise<Blob> {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), call?.timeoutMs ?? this.timeoutMs);
		const signal = call?.signal ? AbortSignal.any([call.signal, timeout.signal]) : timeout.signal;
		try {
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, { credentials: "same-origin", signal });
			if (!response.ok) {
				const text = await response.text();
				const body = text ? parseBody(text) : null;
				throw new ApiError(response.status, errorCode(body, response.status), body);
			}
			return await response.blob();
		} catch (error) {
			if (error instanceof ApiError) throw error;
			if (call?.signal?.aborted) throw new ApiError(0, "aborted", null);
			if (timeout.signal.aborted) throw new ApiError(0, "timeout", null);
			throw new ApiError(0, "network", null);
		} finally {
			clearTimeout(timer);
		}
	}

	private async request(
		path: string,
		init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; call?: CallOptions; skipSessionRetry?: boolean } = {},
	): Promise<unknown> {
		const timeoutMs = init.call?.timeoutMs ?? this.timeoutMs;
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), timeoutMs);
		const callerSignal = init.call?.signal;
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
		const headers: Record<string, string> = { ...(init.headers ?? {}) };
		if (init.json !== undefined) headers["content-type"] = headers["content-type"] ?? JSON_HEADERS["content-type"];
		try {
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: init.method ?? "GET",
				body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
				headers: Object.keys(headers).length > 0 ? headers : undefined,
				credentials: "same-origin",
				signal,
			});
			const text = await response.text();
			const body = text ? parseBody(text) : null;
			if (!response.ok) {
				const error = new ApiError(response.status, errorCode(body, response.status), body);
				if (canRenewSession(error, init.skipSessionRetry)) {
					try {
						await this.openSession(init.call);
					} catch {
						throw new ApiError(401, "session_expired", null);
					}
					return await this.request(path, { ...init, skipSessionRetry: true });
				}
				throw error;
			}
			return body;
		} catch (error) {
			if (error instanceof ApiError) throw error;
			if (callerSignal?.aborted) throw new ApiError(0, "aborted", null);
			if (timeout.signal.aborted) throw new ApiError(0, "timeout", null);
			throw new ApiError(0, "network", null);
		} finally {
			clearTimeout(timer);
		}
	}
}

function canRenewSession(error: ApiError, skip: boolean | undefined): boolean {
	if (skip) return false;
	return error.status === 401 && (error.code === "session_required" || error.code === "session_expired");
}

function assertExpiresAt(value: unknown): void {
	const row = asRecord(value, "session");
	if (typeof row.expires_at !== "string" || row.expires_at.length === 0) {
		throw new ApiError(0, "invalid_response", { key: "expires_at" });
	}
}

function asPipelineStage(value: unknown): PipelineStage | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.stage !== "string" || row.stage.length === 0) return null;
	return {
		stage: row.stage,
		status: typeof row.status === "string" ? row.status : "",
		started_at: asOptionalString(row.started_at),
		finished_at: asOptionalString(row.finished_at),
		error_code: asOptionalString(row.error_code),
	};
}

function asPipeline(value: unknown): Pipeline {
	const row = asRecord(value, "pipeline");
	const stages = Array.isArray(row.stages) ? row.stages.flatMap((item) => {
		const stage = asPipelineStage(item);
		return stage ? [stage] : [];
	}) : [];
	return {
		pipeline_id: asString(row, "pipeline_id"),
		project_id: asString(row, "project_id"),
		run_id: asString(row, "run_id"),
		demand_revision: asNumber(row, "demand_revision"),
		status: asString(row, "status"),
		stage: asOptionalString(row.stage),
		error: asOptionalString(row.error),
		decision_version: asOptionalString(row.decision_version),
		report_id: asOptionalString(row.report_id),
		report_status: asOptionalString(row.report_status),
		report_error_code: asOptionalString(row.report_error_code),
		download_path: asOptionalString(row.download_path),
		candidates_found: asOptionalNumber(row.candidates_found) ?? 0,
		models_found: asOptionalNumber(row.models_found) ?? 0,
		evidence_found: asOptionalNumber(row.evidence_found) ?? 0,
		stages,
		created_at: asString(row, "created_at"),
		updated_at: asString(row, "updated_at"),
	};
}

function asPipelineListItem(value: unknown): PipelineListItem {
	const row = asRecord(value, "pipeline_item");
	return {
		pipeline_id: asString(row, "pipeline_id"),
		run_id: asOptionalString(row.run_id),
		demand_revision: asOptionalNumber(row.demand_revision),
		status: asOptionalString(row.status) ?? "",
		stage: asOptionalString(row.stage),
		decision_version: asOptionalString(row.decision_version),
		report_id: asOptionalString(row.report_id),
		report_status: asOptionalString(row.report_status),
		created_at: asOptionalString(row.created_at) ?? "",
		updated_at: asOptionalString(row.updated_at) ?? "",
	};
}

function asAnalysisConstraint(value: unknown): AnalysisConstraint {
	const row = asRecord(value, "constraint");
	return {
		constraint_id: asOptionalString(row.constraint_id),
		attribute_key: asOptionalString(row.attribute_key),
		attribute_definition: asOptionalString(row.attribute_definition),
		operator: asOptionalString(row.operator),
		value: asOptionalString(row.value),
		unit: asOptionalString(row.unit),
		importance: asOptionalString(row.importance),
		source_quote: asOptionalString(row.source_quote),
	};
}

function asAnalysisRequirement(value: unknown): AnalysisRequirement {
	const row = asRecord(value, "analysis_requirement");
	return {
		requirement_id: asString(row, "requirement_id"),
		product_name: asOptionalString(row.product_name),
		product_category: asOptionalString(row.product_category),
		quantity: asOptionalNumber(row.quantity),
		quantity_unit: asOptionalString(row.quantity_unit),
		constraints: Array.isArray(row.constraints) ? row.constraints.map(asAnalysisConstraint) : [],
	};
}

function asAnalysisCandidate(value: unknown): AnalysisCandidate {
	const row = asRecord(value, "analysis_candidate");
	return {
		candidate_id: asString(row, "candidate_id"),
		requirement_id: asOptionalString(row.requirement_id),
		supplier_id: asOptionalString(row.supplier_id),
		product_id: asOptionalString(row.product_id),
		supplier_name: asOptionalString(row.supplier_name),
		product_model: asOptionalString(row.product_model),
		product_name: asOptionalString(row.product_name),
		stage: asOptionalString(row.stage),
		evidence_ids: asStringList(row.evidence_ids),
	};
}

function asAnalysisCheck(value: unknown): AnalysisCheck {
	const row = asRecord(value, "analysis_check");
	return {
		constraint_id: asOptionalString(row.constraint_id),
		requirement_id: asOptionalString(row.requirement_id),
		claim_ids: asStringList(row.claim_ids),
		status: asOptionalString(row.status),
		reason_code: asOptionalString(row.reason_code),
		operation: asOptionalString(row.operation),
		normalized_actual: asOptionalString(row.normalized_actual),
		normalized_required: asOptionalString(row.normalized_required),
		unit: asOptionalString(row.unit),
		evidence_ids: asStringList(row.evidence_ids),
		importance: asOptionalString(row.importance),
	};
}

function asAnalysisAssessment(value: unknown): AnalysisAssessment {
	const row = asRecord(value, "analysis_assessment");
	return {
		assessment_id: asString(row, "assessment_id"),
		requirement_id: asOptionalString(row.requirement_id),
		product_candidate_id: asOptionalString(row.product_candidate_id),
		product_model_ref: asOptionalString(row.product_model_ref),
		hard_spec_overall: asOptionalString(row.hard_spec_overall),
		overall_reason_codes: asStringList(row.overall_reason_codes),
		hard_constraint_count: asOptionalNumber(row.hard_constraint_count),
		unresolved_question_ids: asStringList(row.unresolved_question_ids),
		evaluated_at: asOptionalString(row.evaluated_at),
		checks: Array.isArray(row.checks) ? row.checks.map(asAnalysisCheck) : [],
	};
}

function asDisplayGap(value: unknown): AnalysisDisplayGap {
	const row = asRecord(value, "display_gap");
	return {
		code: asOptionalString(row.code),
		constraint_id: asOptionalString(row.constraint_id),
		importance: asOptionalString(row.importance),
		evidence_ids: asStringList(row.evidence_ids),
		text_zh: asOptionalString(row.text_zh),
	};
}

function asDisplayAction(value: unknown): AnalysisDisplayAction {
	const row = asRecord(value, "display_action");
	return {
		code: asOptionalString(row.code),
		constraint_id: asOptionalString(row.constraint_id),
		text_zh: asOptionalString(row.text_zh),
	};
}

function asDecisionDisplay(value: unknown): AnalysisDecisionDisplay | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const originals = asOptionalRecord(row.untranslated_originals);
	return {
		version: asOptionalString(row.version),
		basis: asOptionalString(row.basis),
		summary_code: asOptionalString(row.summary_code),
		summary_zh: asOptionalString(row.summary_zh),
		gaps: Array.isArray(row.gaps) ? row.gaps.map(asDisplayGap) : [],
		next_actions: Array.isArray(row.next_actions) ? row.next_actions.map(asDisplayAction) : [],
		unresolved_question_ids: asStringList(row.unresolved_question_ids),
		untranslated_originals: {
			rationale: originals.rationale === true,
			gap_count: asOptionalNumber(originals.gap_count) ?? 0,
			next_action_count: asOptionalNumber(originals.next_action_count) ?? 0,
		},
	};
}

function asAnalysisDecision(value: unknown): AnalysisDecision {
	const row = asRecord(value, "analysis_decision");
	return {
		decision_id: asString(row, "decision_id"),
		requirement_id: asOptionalString(row.requirement_id),
		product_candidate_id: asOptionalString(row.product_candidate_id),
		product_model_ref: asOptionalString(row.product_model_ref),
		recommendation: asOptionalString(row.recommendation),
		technical_verdict: asOptionalString(row.technical_verdict),
		hard_spec_overall: asOptionalString(row.hard_spec_overall),
		accepted: row.accepted === true,
		rationale: asOptionalString(row.rationale),
		evidence_ids: asStringList(row.evidence_ids),
		decided_at: asOptionalString(row.decided_at),
		display: asDecisionDisplay(row.display),
	};
}

function asPriceFinding(value: unknown): AnalysisPriceFinding {
	const row = asRecord(value, "price_finding");
	return {
		lowest_basis: asOptionalString(row.lowest_basis),
		lowest_value: asOptionalString(row.lowest_value),
		saving: asOptionalString(row.saving),
		saving_percent: asOptionalString(row.saving_percent),
		comparability: asOptionalString(row.comparability),
		explanation: asOptionalString(row.explanation),
		lowest_observation_id: asOptionalString(row.lowest_observation_id),
	};
}

function asPriceContext(value: unknown): AnalysisPriceContext {
	const row = asRecord(value, "price_context");
	const statistics = row.statistics;
	const overview = row.overview_statistics;
	return {
		requirement_id: asOptionalString(row.requirement_id),
		product_name: asOptionalString(row.product_name),
		budget: asOptionalString(row.budget),
		budget_currency: asOptionalString(row.budget_currency),
		budget_unit: asOptionalString(row.budget_unit),
		history_scope: asOptionalString(row.history_scope),
		history_scope_note: asOptionalString(row.history_scope_note),
		history_available: row.history_available === true,
		history_rows: asOptionalNumber(row.history_rows),
		statistics: statistics && typeof statistics === "object" && !Array.isArray(statistics) ? (statistics as Record<string, unknown>) : null,
		overview_statistics: overview && typeof overview === "object" && !Array.isArray(overview) ? (overview as Record<string, unknown>) : null,
		overview_is_not_a_baseline: row.overview_is_not_a_baseline === true,
		findings: Array.isArray(row.findings) ? row.findings.map(asPriceFinding) : [],
		notes: asStringList(row.notes),
	};
}

function asAnalysisEvidence(value: unknown): AnalysisEvidence {
	const row = asRecord(value, "analysis_evidence");
	return {
		evidence_id: asString(row, "evidence_id"),
		title: asOptionalString(row.title),
		url: asOptionalString(row.url),
		content_sha256: asOptionalString(row.content_sha256),
		quote: asOptionalString(row.quote),
		quote_status: asOptionalString(row.quote_status),
	};
}

function asSummaryModel(value: unknown): AnalysisSummaryModel {
	const row = asRecord(value, "summary_model");
	return {
		product_model: asOptionalString(row.product_model) ?? "",
		product_id: asOptionalString(row.product_id) ?? "",
		candidate_rows: asOptionalNumber(row.candidate_rows) ?? 0,
		supplier_count: asOptionalNumber(row.supplier_count) ?? 0,
	};
}

function asAnalysisSummary(value: unknown): AnalysisSummary {
	const row = asOptionalRecord(value);
	return {
		requirements: asOptionalNumber(row.requirements) ?? 0,
		candidate_rows: asOptionalNumber(row.candidate_rows) ?? 0,
		distinct_models: asOptionalNumber(row.distinct_models) ?? 0,
		distinct_suppliers: asOptionalNumber(row.distinct_suppliers) ?? 0,
		models: Array.isArray(row.models) ? row.models.map(asSummaryModel) : [],
		assessments: asOptionalNumber(row.assessments) ?? 0,
		by_verdict: asCountMap(row.by_verdict),
		decisions: asOptionalNumber(row.decisions) ?? 0,
		by_recommendation: asCountMap(row.by_recommendation),
		evidence: asOptionalNumber(row.evidence) ?? 0,
		coverage_warnings: asStringList(row.coverage_warnings),
	};
}

function asAnalysisReport(value: unknown): AnalysisReport {
	const row = asOptionalRecord(value);
	return {
		report_id: asOptionalString(row.report_id),
		status: asOptionalString(row.status),
		error_code: asOptionalString(row.error_code),
		decision_version: asOptionalString(row.decision_version),
		download_path: asOptionalString(row.download_path),
		warning_codes: asStringList(row.warning_codes),
	};
}

function asAnalysis(value: unknown): Analysis {
	const row = asRecord(value, "analysis");
	return {
		project_id: asString(row, "project_id"),
		pipeline_id: asOptionalString(row.pipeline_id) ?? "",
		run_id: asOptionalString(row.run_id) ?? "",
		demand_revision: asOptionalNumber(row.demand_revision) ?? 0,
		research_status: asOptionalString(row.research_status) ?? "",
		decision_version: asOptionalString(row.decision_version),
		requirements: Array.isArray(row.requirements) ? row.requirements.map(asAnalysisRequirement) : [],
		candidates: Array.isArray(row.candidates) ? row.candidates.map(asAnalysisCandidate) : [],
		assessments: Array.isArray(row.assessments) ? row.assessments.map(asAnalysisAssessment) : [],
		decisions: Array.isArray(row.decisions) ? row.decisions.map(asAnalysisDecision) : [],
		price_contexts: Array.isArray(row.price_contexts) ? row.price_contexts.map(asPriceContext) : [],
		evidence: Array.isArray(row.evidence) ? row.evidence.map(asAnalysisEvidence) : [],
		summary: asAnalysisSummary(row.summary),
		report: asAnalysisReport(row.report),
	};
}

export function createApiClient(options?: ApiClientOptions): ApiClient {
	return new ApiClient(options);
}
