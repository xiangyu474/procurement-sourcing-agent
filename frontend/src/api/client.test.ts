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
});
