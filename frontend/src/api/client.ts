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
	type RequirementText,
	type RequirementsDocument,
	type RequirementsResult,
	type Run,
	type RunEvent,
	type StartedRun,
	type TextRevision,
	type UploadedSource,
} from "./types";

export type ApiClientOptions = {
	baseUrl?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
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

	private async request(
		path: string,
		init: { method?: string; json?: unknown; body?: BodyInit; call?: CallOptions } = {},
	): Promise<unknown> {
		const timeoutMs = init.call?.timeoutMs ?? this.timeoutMs;
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), timeoutMs);
		const callerSignal = init.call?.signal;
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
		const headers = init.json !== undefined ? JSON_HEADERS : undefined;
		try {
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: init.method ?? "GET",
				body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
				headers,
				credentials: "same-origin",
				signal,
			});
			const text = await response.text();
			const body = text ? parseBody(text) : null;
			if (!response.ok) throw new ApiError(response.status, errorCode(body, response.status), body);
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

export function createApiClient(options?: ApiClientOptions): ApiClient {
	return new ApiClient(options);
}
