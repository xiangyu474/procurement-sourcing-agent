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

	it("aborts a pipeline read that sits longer than 15 seconds", async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					});
				});
			});
			const pending = client(fetchImpl as typeof fetch).getPipeline("p1", "pipe-1");
			const rejected = pending.then(
				() => null,
				(caught: unknown) => caught,
			);
			await vi.advanceTimersByTimeAsync(15_000);
			await expect(rejected).resolves.toMatchObject({ code: "timeout" });
		} finally {
			vi.useRealTimers();
		}
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
		await expect(api.openSession()).resolves.toBeUndefined();
		await expect(api.readSession()).resolves.toBeUndefined();
		await expect(api.openSession()).rejects.toMatchObject({ code: "invalid_response" });
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
});
