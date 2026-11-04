import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { ApiError, type Pipeline, type Project, type ProjectRunSummary, type ProjectSummary, type Run, type StartedPipeline } from "../api/types";
import { readPipelineKey } from "./pipelineState";
import { useWorkspace } from "./useWorkspace";

const projectId = "11111111-1111-4111-8111-111111111111";

const started: StartedPipeline = {
	pipeline_id: "pipe-1",
	run_id: "run-9",
	demand_revision: 1,
	status: "QUEUED",
	reused: true,
};

const pipeline: Pipeline = {
	pipeline_id: "pipe-1",
	project_id: projectId,
	run_id: "run-9",
	demand_revision: 1,
	status: "COMPLETED",
	stage: "COMPLETED",
	error: null,
	decision_version: "version-1",
	report_id: "rep-1",
	report_status: "COMPLETED",
	report_error_code: null,
	download_path: `/api/projects/${projectId}/reports/rep-1/download`,
	candidates_found: 3,
	models_found: 1,
	evidence_found: 5,
	stages: [{ stage: "RESEARCH", status: "COMPLETED", started_at: "2026-11-02T15:06:58.664Z", finished_at: "2026-11-02T15:17:07.053Z", error_code: null }],
	created_at: "2026-11-02T15:06:58.664Z",
	updated_at: "2026-11-02T15:22:27.075Z",
};

const run: Run = {
	id: "run-9",
	project_id: projectId,
	status: "COMPLETED",
	current_stage: "COMPLETED",
	artifact_key: null,
	last_error: null,
	created_at: pipeline.created_at,
	updated_at: pipeline.updated_at,
};

const readyRequirements = async () =>
	({
		state: "ready",
		body: { analysis_version: 1, compilation: { requirements: [{ requirement_id: "r1" }], issues: [] } },
	}) as const;

const summary: ProjectSummary = {
	id: projectId,
	title: "闲聊",
	history_availability: "NOT_PROVIDED",
	demand_revision: 1,
	analysis_version: 1,
	created_at: "2026-11-02T01:00:00.000Z",
	latest_run: null,
};

const project: Project = {
	id: projectId,
	title: "闲聊",
	analysis_version: 1,
	demand_revision: 1,
	history_availability: "NOT_PROVIDED",
	created_at: "2026-11-02T01:00:00.000Z",
	sources: [
		{
			id: "text-1",
			purpose: "REQUIREMENT",
			source_type: "USER_TEXT",
			revision: 1,
			filename: null,
			media_type: "text/plain",
			sha256: "abc",
			created_at: "2026-11-02T01:01:00.000Z",
		},
	],
};

function client(methods: Partial<ApiClient>): ApiClient {
	return {
		listProjects: async () => [summary],
		listRuns: async () => [],
		getRequirementText: async () => ({ source_id: "text-1", revision: 1, text: "你好，今天天气不错。" }),
		getCompileJob: async () => ({
			compile_id: "compile-1",
			project_id: projectId,
			status: "COMPLETED",
			analysis_version: 1,
			demand_revision: 1,
			error: null,
		}),
		createProject: async () => ({ project_id: projectId, source_id: null, analysis_version: 1 }),
		getProject: async () => project,
		addRequirementText: async () => ({ project_id: projectId, source_id: "text-1", revision: 1 }),
		upload: async () => ({ source_id: "file-1", purpose: "REQUIREMENT", revision: 1, sha256: "abc" }),
		compile: async () => ({ project_id: projectId, status: "QUEUED", compile_id: "compile-1", analysis_version: 1 }),
		getRequirements: async () => ({
			state: "ready",
			body: { analysis_version: 1, compilation: { requirements: [], issues: [] } },
		}),
		importHistory: async () => ({
			dataset_id: "d",
			row_count: 0,
			column_count: 0,
			is_synthetic: false,
			duplicate_import: false,
			analysis_version: 1,
		}),
		startRun: async () => ({ run_id: "run-1", status: "QUEUED", reused: false }),
		listProjectPipelines: async () => [],
		getAnalysis: async () => ({
			project_id: projectId,
			pipeline_id: "pipe-1",
			run_id: "run-9",
			demand_revision: 1,
			research_status: "COMPLETED",
			decision_version: "version-1",
			requirements: [],
			candidates: [],
			assessments: [],
			decisions: [],
			price_contexts: [],
			evidence: [],
			summary: {
				requirements: 0,
				candidate_rows: 0,
				distinct_models: 0,
				distinct_suppliers: 0,
				models: [],
				assessments: 0,
				by_verdict: {},
				decisions: 0,
				by_recommendation: {},
				evidence: 0,
				coverage_warnings: [],
			},
			report: { report_id: "rep-1", status: "COMPLETED", error_code: null, decision_version: "version-1", download_path: null, warning_codes: [] },
		}),
		startPipeline: async () => {
			throw new Error("startPipeline was not expected");
		},
		getPipeline: async () => {
			throw new Error("getPipeline was not expected");
		},
		openSession: async () => undefined,
		readSession: async () => undefined,
		listReports: async () => [],
		createReport: async () => {
			throw new Error("createReport was not expected");
		},
		getReport: async () => {
			throw new Error("getReport was not expected");
		},
		downloadReport: async () => new Blob(),
		getRun: async () => {
			throw new Error("getRun was not expected");
		},
		getRunEvents: async () => [],
		getStopReason: async () => null,
		getResearchSummary: async () => ({ stopReason: null, candidateCount: null }),
		listCandidates: async () => [],
		listAssessments: async () => [],
		listDecisions: async () => [],
		getJobStatus: async () => ({ status: "IDLE", job_id: null, demand_revision: 1, error: null }),
		getEvidence: async () => ({ evidence_id: "e", title: null, source_url: null, retrieved_at: null, excerpt: null, snapshot_text: null }),
		...methods,
	} as ApiClient;
}

describe("useProjectSession", () => {
	it("does not start a pipeline when a completed compile has no requirements", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		const startRun = vi.fn(async () => ({ run_id: "run-1", status: "QUEUED", reused: false }));
		const startPipeline = vi.fn(async () => started);
		const { result } = renderHook(() => useWorkspace(client({ startRun, startPipeline })));
		await waitFor(() => expect(result.current.project?.id).toBe(projectId));
		await act(async () => {
			await result.current.onStart();
		});
		expect(startRun).not.toHaveBeenCalled();
		expect(startPipeline).not.toHaveBeenCalled();
		expect(result.current.error?.summary).toBe("没有识别出采购需求。");
		expect(sessionStorage.getItem(`psi.compileDemand.${projectId}`)).toBeNull();
	});

	it("uses the runs already loaded when a project opens", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		const runId = "22222222-2222-4222-8222-222222222222";
		const listed: ProjectRunSummary = {
			id: runId,
			status: "PARTIAL",
			current_stage: "PARTIAL",
			last_error: null,
			stop_reason_code: "NO_SOURCE_BACKED_CANDIDATES",
			artifact_key_present: false,
			created_at: "2026-11-02T02:00:00.000Z",
			updated_at: "2026-11-02T02:04:00.000Z",
		};
		const listRuns = vi.fn(async () => [listed]);
		const { result } = renderHook(() =>
			useWorkspace(
				client({
					listProjects: async () => [{ ...summary, latest_run: { id: runId, status: "PARTIAL", current_stage: "PARTIAL", updated_at: listed.updated_at } }],
					listRuns,
					getRequirements: async () => ({ state: "missing" }),
					getRun: async () => ({
						id: runId,
						project_id: projectId,
						status: "PARTIAL",
						current_stage: "PARTIAL",
						artifact_key: null,
						last_error: null,
						created_at: listed.created_at,
						updated_at: listed.updated_at,
					}),
					getRunEvents: async () => [{ stage: "WEB_RESEARCH", created_at: listed.updated_at }],
				}),
			),
		);
		await waitFor(() => expect(result.current.stopReason).toBe("NO_SOURCE_BACKED_CANDIDATES"));
		expect(listRuns).toHaveBeenCalledTimes(1);
		expect(result.current.candidateCount).toBe(0);
	});

	it("starts a pipeline with the saved key and selects its run", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		sessionStorage.setItem("psi.pipelineKey.v1", JSON.stringify({ [`${projectId}:1`]: "same-key" }));
		const startRun = vi.fn();
		const startPipeline = vi.fn(async () => started);
		const getPipeline = vi.fn(async () => pipeline);
		const { result } = renderHook(() =>
			useWorkspace(client({ startRun, startPipeline, getPipeline, getRequirements: readyRequirements, getRun: async () => run })),
		);
		await waitFor(() => expect(result.current.compileView).toMatchObject({ phase: "ready", requirementCount: 1 }));
		await act(async () => {
			await result.current.onStart();
		});
		expect(startRun).not.toHaveBeenCalled();
		expect(startPipeline).toHaveBeenCalledWith(projectId, "same-key", 1, expect.anything());
		expect(readPipelineKey(projectId, 1)).toBeNull();
		expect(JSON.parse(sessionStorage.getItem("psi.pipelineId.v1") ?? "{}")).toMatchObject({ [projectId]: "pipe-1" });
		await waitFor(() => expect(result.current.pipelineLine).toBe("已完成"));
		await waitFor(() => expect(result.current.run?.id).toBe("run-9"));
		expect(result.current.pipelineNote).toBeNull();
	});

	it("replaces the key after an idempotency conflict and adds no message", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		const keys: string[] = [];
		const startPipeline = vi.fn(async (_project: string, key: string) => {
			keys.push(key);
			if (keys.length === 1) throw new ApiError(409, "idempotency_conflict", { error: "idempotency_conflict" });
			return { ...started, reused: false };
		});
		const { result } = renderHook(() =>
			useWorkspace(client({ startPipeline, getPipeline: async () => pipeline, getRequirements: readyRequirements, getRun: async () => run })),
		);
		await waitFor(() => expect(result.current.compileView).toMatchObject({ requirementCount: 1 }));
		await act(async () => {
			await result.current.onStart();
		});
		expect(keys).toHaveLength(2);
		expect(keys[0]).not.toBe(keys[1]);
		expect(result.current.error).toBeNull();
	});

	it("reloads the project when the demand revision changed", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		const getProject = vi.fn(async () => project);
		const startPipeline = vi.fn(async () => {
			throw new ApiError(409, "demand_revision_changed", { error: "demand_revision_changed" });
		});
		const { result } = renderHook(() =>
			useWorkspace(client({ getProject, startPipeline, getRequirements: readyRequirements })),
		);
		await waitFor(() => expect(result.current.compileView).toMatchObject({ requirementCount: 1 }));
		const readsBefore = getProject.mock.calls.length;
		await act(async () => {
			await result.current.onStart();
		});
		expect(result.current.error?.summary).toBe("需求刚更新过，请确认后再开始。");
		expect(getProject.mock.calls.length).toBeGreaterThan(readsBefore);
		expect(result.current.pipelineLine).toBeNull();
	});

	it("keeps the same key and offers a retry when the workflow did not start", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		const keys: string[] = [];
		const startPipeline = vi.fn(async (_project: string, key: string) => {
			keys.push(key);
			if (keys.length === 1) throw new ApiError(503, "workflow_start_failed", { error: "workflow_start_failed" });
			return { ...started, reused: true };
		});
		const { result } = renderHook(() =>
			useWorkspace(client({ startPipeline, getPipeline: async () => pipeline, getRequirements: readyRequirements, getRun: async () => run })),
		);
		await waitFor(() => expect(result.current.compileView).toMatchObject({ requirementCount: 1 }));
		await act(async () => {
			await result.current.onStart();
		});
		expect(result.current.error?.summary).toBe("分析没能启动。");
		expect(result.current.startOffer).toBe("retry");
		expect(readPipelineKey(projectId, 1)).toBe(keys[0]);
		await act(async () => {
			await result.current.onStart();
		});
		expect(keys[1]).toBe(keys[0]);
		await waitFor(() => expect(result.current.pipelineLine).toBe("已完成"));
	});

	it("follows a pipeline id saved in the tab after reload", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		sessionStorage.setItem("psi.pipelineId.v1", JSON.stringify({ [projectId]: "pipe-1" }));
		const getPipeline = vi.fn(async () => ({ ...pipeline, status: "RUNNING", stage: "EVALUATING" }));
		const { result } = renderHook(() => useWorkspace(client({ getPipeline, getRun: async () => ({ ...run, status: "RUNNING" }) })));
		await waitFor(() => expect(result.current.pipelineLine).toBe("正在核对技术与价格"));
		expect(getPipeline).toHaveBeenCalledWith(projectId, "pipe-1", expect.anything());
	});
});
