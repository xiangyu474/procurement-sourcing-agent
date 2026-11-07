import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { ApiError } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch): ApiClient {
	return new ApiClient({ baseUrl: "http://gateway.test", fetch: fetchImpl });
}

describe("ApiClient", () => {
	it("calls fetch as a function so the browser does not reject it", async () => {
		const fetchImpl = vi.fn(async function (this: unknown) {
			if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
			return jsonResponse({ project_id: "p1", source_id: null, analysis_version: 0 }, 201);
		});
		await expect(client(fetchImpl).createProject("相机")).resolves.toMatchObject({ project_id: "p1" });
	});

	it("asks for the sample with the session cookie and no body", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ project_id: "p-sample", pipeline_id: "pipe-sample", report_id: null }, 201),
		);
		await expect(client(fetchImpl).copySample()).resolves.toEqual({
			project_id: "p-sample",
			pipeline_id: "pipe-sample",
			report_id: null,
		});
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://gateway.test/api/demo/sample");
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("same-origin");
		expect(init.body).toBeUndefined();
		expect(JSON.stringify(init.headers ?? {}).toLowerCase()).not.toContain("authorization");
	});

	it("creates a project without sending an authorization header", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ project_id: "p1", source_id: null, analysis_version: 0 }, 201));
		await client(fetchImpl).createProject("  工业相机  ");
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://gateway.test/api/projects");
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("same-origin");
		expect(init.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
		expect(JSON.parse(String(init.body))).toEqual({ title: "工业相机" });
		expect(JSON.stringify(init.headers).toLowerCase()).not.toContain("authorization");
	});

	it("uploads PPTX as multipart and keeps the browser-generated content type", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ source_id: "s1", purpose: "REQUIREMENT", revision: 1, sha256: "abc", r2_key: "private/key" }, 201),
		);
		const file = new File(["pptx"], "需求.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
		const uploaded = await client(fetchImpl).upload("p1", "REQUIREMENT", file);
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toBeUndefined();
		expect(init.body).toBeInstanceOf(FormData);
		const form = init.body as FormData;
		expect(form.get("purpose")).toBe("REQUIREMENT");
		expect(form.get("file")).toBeInstanceOf(File);
		expect(uploaded).toEqual({ source_id: "s1", purpose: "REQUIREMENT", revision: 1, sha256: "abc" });
		expect(uploaded).not.toHaveProperty("r2_key");
	});

	it("treats an uncompiled demand as missing rather than success", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "not_compiled" }, 404));
		await expect(client(fetchImpl).getRequirements("p1")).resolves.toEqual({ state: "missing" });
	});

	it("rejects an unauthorized call", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
		const error = await client(fetchImpl).getProject("p1").then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 401, code: "unauthorized" });
	});

	it("reports a timed-out request", async () => {
		const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				});
			});
		});
		const error = await client(fetchImpl as typeof fetch).getProject("p1", { timeoutMs: 15 }).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toMatchObject({ code: "timeout" });
	});

	it("reads only the stop reason from a research payload", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				metrics: { stop_reason_code: "BUDGET_EXHAUSTED", prompt_tokens: 999, completion_tokens: 20 },
			}),
		);
		await expect(client(fetchImpl).getStopReason("run-1")).resolves.toBe("BUDGET_EXHAUSTED");
	});

	it("loads candidates for one run and drops internal evidence fields", async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/candidates")) {
				return jsonResponse({
					candidates: [{
						candidate_id: "c1",
						requirement_id: "r1",
						stage: "DISCOVERED_LONG_LIST",
						last_seen_run_id: "run-1",
						updated_at: "2026-11-01T00:00:00.000Z",
						supplier: { display_name: "海康威视" },
						product: { model: "DS-1" },
						evidence: [{ evidence_id: "ev_1", source_url: "https://example.com/a", title: "页", retrieved_at: null, excerpt: "摘录" }],
					}],
				});
			}
			return jsonResponse({
				evidence: {
					evidence_id: "ev_1",
					title: "页",
					source_url: "https://example.com/a",
					retrieved_at: null,
					excerpt: "摘录",
					snapshot_text: "正文",
					snapshot_r2_key: "workspaces/default/secret",
					content_sha256: "abc",
				},
			});
		});
		const api = client(fetchImpl);
		const listed = await api.listCandidates("p1", "run 1");
		expect(String(fetchImpl.mock.calls[0][0])).toBe("http://gateway.test/api/projects/p1/candidates?run_id=run+1");
		expect(listed[0].supplier_name).toBe("海康威视");
		const evidence = await api.getEvidence("ev_1");
		expect(evidence.snapshot_text).toBe("正文");
		expect(JSON.stringify(evidence)).not.toContain("secret");
		expect(JSON.stringify(evidence)).not.toContain("content_sha256");
	});

	it("uses the formal report routes and refuses the spike download", async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(init?.credentials).toBe("same-origin");
			expect(JSON.stringify(init?.headers ?? {}).toLowerCase()).not.toContain("authorization");
			if (url.endsWith("/reports") && init?.method === "POST") {
				expect(JSON.parse(String(init.body))).toEqual({ run_id: "run-1" });
				return jsonResponse({ report_id: "rep-1", run_id: "run-1", status: "QUEUED", workflow_id: "cf-secret" });
			}
			if (url.endsWith("/download")) return new Response("PK", { status: 200 });
			return jsonResponse({
				reports: [{
					report_id: "rep-1",
					run_id: "run-1",
					status: "COMPLETED",
					decision_version: "abc",
					sha256: "secret-hash",
					error: null,
					download_path: "/api/projects/p1/reports/rep-1/download",
					created_at: "2026-11-02T00:00:00.000Z",
					updated_at: "2026-11-02T00:01:00.000Z",
				}],
			});
		});
		const api = client(fetchImpl);
		const listed = await api.listReports("p1");
		expect(listed[0].download_path).toBe("/api/projects/p1/reports/rep-1/download");
		expect(JSON.stringify(listed[0])).not.toContain("secret-hash");
		const created = await api.createReport("p1", "run-1");
		expect(created.status).toBe("QUEUED");
		expect(JSON.stringify(created)).not.toContain("cf-secret");
		const blob = await api.downloadReport("/api/projects/p1/reports/rep-1/download");
		expect(blob.size).toBeGreaterThan(0);
		await expect(api.downloadReport("/api/runs/run-1/report/download")).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("starts a pipeline with the idempotency header and the current revision", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ pipeline_id: "pipe-1", run_id: "run-1", demand_revision: 3, status: "QUEUED", reused: false }, 202),
		);
		const started = await client(fetchImpl).startPipeline("p1", "key-1", 3);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://gateway.test/api/projects/p1/pipeline");
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("same-origin");
		expect(init.headers).toMatchObject({ "Idempotency-Key": "key-1", "content-type": "application/json; charset=utf-8" });
		expect(JSON.parse(String(init.body))).toEqual({ demand_revision: 3 });
		expect(JSON.stringify(init.headers).toLowerCase()).not.toContain("authorization");
		expect(started).toEqual({ pipeline_id: "pipe-1", run_id: "run-1", demand_revision: 3, status: "QUEUED", reused: false });
	});

	it("reads the pipeline status field and keeps a null stage error", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				pipeline_id: "pipe-1",
				project_id: "p1",
				run_id: "run-1",
				demand_revision: 1,
				status: "RUNNING",
				stage: "RESEARCH",
				error: null,
				stages: [{ stage: "RESEARCH", status: "RUNNING", started_at: "2026-11-02T15:06:58.664Z", finished_at: null, error_code: null }],
				created_at: "2026-11-02T15:06:58.664Z",
				updated_at: "2026-11-02T15:06:58.664Z",
			}),
		);
		const pipeline = await client(fetchImpl).getPipeline("p1", "pipe-1");
		expect(pipeline.status).toBe("RUNNING");
		expect(pipeline.stage).toBe("RESEARCH");
		expect(pipeline.stages[0].error_code).toBeNull();
		expect(pipeline).not.toHaveProperty("pipeline_status");
	});

	it("accepts a session expiry on 201 and 200 and rejects a body without one", async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ expires_at: "2026-11-03T00:00:00.000Z" }, 201))
			.mockResolvedValueOnce(jsonResponse({ expires_at: "2026-11-03T00:00:00.000Z" }, 200))
			.mockResolvedValueOnce(jsonResponse({}, 200));
		const api = client(fetchImpl);
		await expect(api.openSession()).resolves.toEqual({ mode: "guest", expiresAt: "2026-11-03T00:00:00.000Z" });
		await expect(api.readSession()).resolves.toEqual({ mode: "guest", expiresAt: "2026-11-03T00:00:00.000Z" });
		await expect(api.openSession()).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("reads the identity the gateway publishes", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ mode: "operator", expires_at: null }));
		await expect(client(fetchImpl).readSession()).resolves.toEqual({ mode: "operator", expiresAt: null });
	});

	it("renews a session once after session_expired and then surfaces the failure", async () => {
		let sessionPosts = 0;
		let projectReads = 0;
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/session")) {
				sessionPosts += 1;
				expect(init?.method).toBe("POST");
				return jsonResponse({ expires_at: "2026-11-03T00:00:00.000Z" }, 201);
			}
			projectReads += 1;
			return jsonResponse({ error: "session_expired" }, 401);
		});
		const error = await client(fetchImpl).getProject("p1").then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(sessionPosts).toBe(1);
		expect(projectReads).toBe(2);
		expect(error).toMatchObject({ status: 401, code: "session_expired" });
	});

	it("does not open a session for an ordinary unauthorized response", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
		await expect(client(fetchImpl).getProject("p1")).rejects.toMatchObject({ code: "unauthorized" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("reads the frozen analysis of one run and keeps only displayable fields", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				project_id: "p1",
				pipeline_id: "pipe-1",
				run_id: "run-1",
				demand_revision: 1,
				research_status: "COMPLETED",
				is_sample: true,
				decision_version: "6f4a20a4c0ffee",
				requirements: [{ requirement_id: "r1", product_name: "摄像机", constraints: [] }],
				candidates: [{ candidate_id: "c1", requirement_id: "r1", supplier_name: "海康威视", product_model: "DS-1", stage: "DISCOVERED_LONG_LIST", evidence_ids: ["ev_1"] }],
				assessments: [{ assessment_id: "a1", requirement_id: "r1", product_candidate_id: "c1", product_model_ref: "DS-1", hard_spec_overall: "PASS", checks: [] }],
				decisions: [{
					decision_id: "d1",
					requirement_id: "r1",
					product_candidate_id: "c1",
					product_model_ref: "DS-1",
					recommendation: "SHORTLIST",
					technical_verdict: "VERIFIED_PASS",
					hard_spec_overall: "PASS",
					accepted: true,
					rationale: "the model did not confirm the pixel count",
					display: { summary_code: "RECOMMENDED_INQUIRY_VERIFIED", summary_zh: "核验通过。", gaps: [], next_actions: [], untranslated_originals: { rationale: true, gap_count: 0, next_action_count: 0 } },
				}],
				price_contexts: [{ requirement_id: "r1", product_name: "摄像机", budget: "500", budget_currency: "CNY", history_scope: "NONE", history_available: false, findings: [], notes: [] }],
				evidence: [{ evidence_id: "ev_1", title: "页", url: "https://example.com/a", content_sha256: "abc", quote: "摘录", quote_status: "ORIGINAL" }],
				summary: {
					requirements: 1,
					candidate_rows: 1,
					distinct_models: 1,
					distinct_suppliers: 3,
					supplier_discoveries: 23,
					models: [{ product_model: "DS-1", product_id: "p1", candidate_rows: 1, supplier_count: 1 }],
					assessments: 1,
					by_verdict: { PASS: 1 },
					decisions: 1,
					by_recommendation: { SHORTLIST: 1 },
					evidence: 1,
					coverage_warnings: [],
				},
				report: { report_id: "rep-1", status: "COMPLETED", error_code: null, decision_version: "abc123", download_path: "/api/projects/p1/reports/rep-1/download", warning_codes: [] },
			}),
		);
		const analysis = await client(fetchImpl).getAnalysis("p1", { runId: "run-1" });
		const [analysisUrl] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(analysisUrl).toBe("http://gateway.test/api/projects/p1/analysis?run_id=run-1");
		expect(analysis.is_sample).toBe(true);
		expect(analysis.decision_version).toBe("6f4a20a4c0ffee");
		expect(analysis.summary.distinct_suppliers).toBe(3);
		expect(analysis.summary.supplier_discoveries).toBe(23);
		expect(analysis.summary.distinct_models).toBe(1);
		expect(analysis.summary.by_verdict.PASS).toBe(1);
		expect(analysis.decisions[0].display?.summary_zh).toBe("核验通过。");
		expect(analysis.report.download_path).toBe("/api/projects/p1/reports/rep-1/download");
		expect(analysis.price_contexts[0].history_scope).toBe("NONE");
	});

	it("asks for the analysis by pipeline or by run, never both", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ project_id: "p1", pipeline_id: "pipe-1", run_id: "run-1", demand_revision: 1, research_status: "COMPLETED" }));
		const api = client(fetchImpl);
		await api.getAnalysis("p1", { pipelineId: "pipe-1" });
		const [pipelineUrl] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(pipelineUrl).toContain("pipeline_id=pipe-1");
		expect(pipelineUrl).not.toContain("run_id");
	});

	it("lists the tasks of a project so a refresh can find the running one", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				project_id: "p1",
				pipelines: [{ pipeline_id: "pipe-1", run_id: "run-1", demand_revision: 1, status: "RUNNING", stage: "RESEARCH", decision_version: null, report_id: null, report_status: "NOT_STARTED", created_at: "2026-11-04T00:00:00.000Z", updated_at: "2026-11-04T00:00:00.000Z" }],
				has_more: false,
			}),
		);
		const items = await client(fetchImpl).listProjectPipelines("p1", { active: true, limit: 20 });
		const [listUrl] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(listUrl).toBe("http://gateway.test/api/projects/p1/pipelines?active=true&limit=20");
		expect(items[0].pipeline_id).toBe("pipe-1");
		expect(items[0].report_status).toBe("NOT_STARTED");
	});
});
