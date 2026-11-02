import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { Project, ProjectRunSummary, ProjectSummary } from "../api/types";
import { useWorkspace } from "./useWorkspace";

const projectId = "11111111-1111-4111-8111-111111111111";

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
		getRun: async () => {
			throw new Error("getRun was not expected");
		},
		getRunEvents: async () => [],
		getStopReason: async () => null,
		getResearchSummary: async () => ({ stopReason: null, candidateCount: null }),
		...methods,
	} as ApiClient;
}

describe("useProjectSession", () => {
	it("does not start a run when a completed compile has no requirements", async () => {
		sessionStorage.setItem("psi.activeProjectId", projectId);
		const startRun = vi.fn(async () => ({ run_id: "run-1", status: "QUEUED", reused: false }));
		const { result } = renderHook(() => useWorkspace(client({ startRun })));
		await waitFor(() => expect(result.current.project?.id).toBe(projectId));
		await act(async () => {
			await result.current.onStart();
		});
		expect(startRun).not.toHaveBeenCalled();
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
});
