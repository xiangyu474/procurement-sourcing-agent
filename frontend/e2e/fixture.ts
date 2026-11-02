/**
 * FIXTURE — browser-test double for the gateway.
 * Imported only by Playwright. The Vite build does not include this module,
 * and the running app never substitutes these responses for a real API call.
 */
import type { Page, Route } from "@playwright/test";

type Mode = "partial" | "completed" | "failed" | "compile-failed";

const LONG_TITLE = "集团总部2026年度工业视觉与网络摄像机框架寻源（含多园区、多品牌、超长名称不应撑破项目栏）";
const LONG_PPTX = "华北区域工业相机及配套镜头年度框架采购技术规格书终版修订-供应商名称也很长.pptx";

export function installFixture(page: Page, mode: Mode): Promise<unknown> {
	const state = {
		id: "11111111-1111-4111-8111-111111111111",
		title: "未命名寻源项目",
		analysisVersion: 0,
		demandRevision: 0,
		history: "NOT_PROVIDED",
		sources: [] as Array<Record<string, unknown>>,
		requirementReads: 0,
		textRevision: 0,
		runReads: 0,
		compileReads: 0,
		text: "",
		created: false,
		runId: "22222222-2222-4222-8222-222222222222",
	};

	const projectSummary = () => ({
		id: state.id,
		title: state.title,
		history_availability: state.history,
		demand_revision: state.demandRevision,
		analysis_version: state.analysisVersion,
		created_at: "2026-10-31T00:00:00.000Z",
		latest_run: state.runReads > 0
			? {
					id: state.runId,
					status: state.runReads >= 2 ? (mode === "completed" ? "COMPLETED" : mode === "failed" ? "FAILED" : "PARTIAL") : "RUNNING",
					current_stage: state.runReads >= 2 ? (mode === "completed" ? "WEB_RESEARCH" : mode === "failed" ? "FAILED" : "PARTIAL") : "WEB_RESEARCH",
					updated_at: "2026-10-31T00:04:00.000Z",
				}
			: null,
	});

	return page.route("**/api/**", async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const json = async () => {
			const raw = request.postData();
			return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		};
		const fulfill = (status: number, body: unknown) =>
			route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });

		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: state.created ? [projectSummary()] : [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/runs`) {
			const terminal = mode === "completed" ? "COMPLETED" : mode === "failed" ? "FAILED" : "PARTIAL";
			const status = state.runReads >= 2 ? terminal : state.runReads > 0 ? "RUNNING" : null;
			await fulfill(200, {
				runs: status
					? [{
							id: state.runId,
							status,
							current_stage: status === "RUNNING" ? "WEB_RESEARCH" : status,
							last_error: status === "FAILED" ? "MODEL_TIMEOUT" : null,
							stop_reason_code: status === "PARTIAL" ? "NO_SOURCE_BACKED_CANDIDATES" : status === "FAILED" ? "MODEL_TIMEOUT" : null,
							artifact_key_present: false,
							created_at: "2026-10-31T00:03:00.000Z",
							updated_at: "2026-10-31T00:04:00.000Z",
						}]
					: [],
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/requirement-text`) {
			if (!state.text) {
				await fulfill(404, { error: "not_found" });
				return;
			}
			await fulfill(200, { source_id: "text-1", revision: state.textRevision, text: state.text });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/requirement-compile/compile-1`) {
			state.compileReads += 1;
			if (mode === "compile-failed" && state.compileReads >= 2) {
				await fulfill(200, {
					compile_id: "compile-1",
					project_id: state.id,
					status: "FAILED",
					analysis_version: state.analysisVersion,
					demand_revision: state.demandRevision,
					error: "需求整理失败。",
				});
				return;
			}
			await fulfill(200, {
				compile_id: "compile-1",
				project_id: state.id,
				status: state.compileReads < 2 ? "RUNNING" : "COMPLETED",
				analysis_version: state.analysisVersion,
				demand_revision: state.demandRevision,
				error: null,
			});
			return;
		}
		if (request.method() === "POST" && path === "/api/projects") {
			const body = await json();
			state.created = true;
			state.title = typeof body.title === "string" && body.title.trim() ? body.title : "未命名寻源项目";
			await fulfill(201, { project_id: state.id, source_id: null, analysis_version: 0 });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}`) {
			await fulfill(200, {
				id: state.id,
				title: state.title,
				analysis_version: state.analysisVersion,
				demand_revision: state.demandRevision,
				history_availability: state.history,
				created_at: "2026-10-31T00:00:00.000Z",
				sources: state.sources,
			});
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${state.id}/requirement-text`) {
			state.analysisVersion += 1;
			state.demandRevision += 1;
			state.textRevision += 1;
			const posted = await json();
			state.text = typeof posted.text === "string" ? posted.text : state.text;
			state.sources.push({
				id: "text-1",
				purpose: "REQUIREMENT",
				source_type: "USER_TEXT",
				revision: state.textRevision,
				filename: null,
				media_type: "text/plain; charset=utf-8",
				sha256: "abc",
				created_at: "2026-10-31T00:01:00.000Z",
			});
			await fulfill(201, { project_id: state.id, source_id: "text-1", revision: state.textRevision });
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${state.id}/upload-sessions`) {
			const raw = request.postData() ?? "";
			const purpose = raw.includes("name=\"purpose\"") && /\bHISTORY\b/.test(raw) ? "HISTORY" : "REQUIREMENT";
			const filename = purpose === "HISTORY" ? "历史采购.xlsx" : LONG_PPTX;
			if (purpose === "REQUIREMENT") {
				state.analysisVersion += 1;
				state.demandRevision += 1;
			}
			state.sources.push({
				id: purpose === "HISTORY" ? "xlsx-1" : "pptx-1",
				purpose,
				source_type: purpose === "HISTORY" ? "INTERNAL_XLSX" : "INTERNAL_PPTX",
				revision: purpose === "HISTORY" ? 1 : state.demandRevision,
				filename,
				media_type: "application/octet-stream",
				sha256: "def",
				created_at: "2026-10-31T00:02:00.000Z",
			});
			await fulfill(201, {
				source_id: purpose === "HISTORY" ? "xlsx-1" : "pptx-1",
				purpose,
				revision: 1,
				sha256: "def",
				r2_key: "workspaces/default/projects/secret-object-key",
			});
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${state.id}/requirement-compile`) {
			await fulfill(202, {
				project_id: state.id,
				status: "QUEUED",
				compile_id: "compile-1",
				analysis_version: state.analysisVersion,
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/requirements`) {
			state.requirementReads += 1;
			if (mode === "compile-failed") {
				await fulfill(200, {
					analysis_version: state.analysisVersion,
					compilation: { project_id: state.id, analysis_version: state.analysisVersion, issues: ["compile failed with status 500: model down"] },
				});
				return;
			}
			if (state.requirementReads < 2) {
				await fulfill(404, { error: "not_compiled" });
				return;
			}
			await fulfill(200, {
				analysis_version: state.analysisVersion,
				compilation: {
					requirements: [{ requirement_id: "r1", product_name: "工业摄像机" }],
					unstructured_requirements: [{ text: "付款方式待定" }, { text: "交货地点待定" }, { text: "样品说明" }],
					issues: [
						"The planned_total_budget of r1 could not be confirmed: the cited fragments do not state 200000.",
						"delivery window unclear",
					],
				},
			});
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${state.id}/runs`) {
			await fulfill(202, { run_id: state.runId, status: "QUEUED", mode: "SOURCING" });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${state.runId}`) {
			state.runReads += 1;
			const terminal = mode === "completed" ? "COMPLETED" : mode === "failed" ? "FAILED" : "PARTIAL";
			const status = state.runReads >= 2 ? terminal : "RUNNING";
			await fulfill(200, {
				id: state.runId,
				project_id: state.id,
				status,
				current_stage: status === "RUNNING" ? "WEB_RESEARCH" : status,
				artifact_key: null,
				last_error: status === "FAILED" ? "MODEL_TIMEOUT" : null,
				created_at: "2026-10-31T00:03:00.000Z",
				updated_at: "2026-10-31T00:04:00.000Z",
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${state.runId}/events`) {
			await fulfill(200, {
				events: [
					{
						stage: "WEB_RESEARCH",
						detail: "SourcingPlan 已生成；Supervisor 正在按预算委派公开研究任务",
						created_at: "2026-10-31T00:03:30.000Z",
					},
				],
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${state.runId}/research`) {
			await fulfill(200, {
				metrics: {
					stop_reason_code: mode === "failed" ? "MODEL_TIMEOUT" : mode === "completed" ? null : "NO_SOURCE_BACKED_CANDIDATES",
					candidate_count: mode === "partial" ? 0 : 1,
					prompt_tokens: 12345,
					completion_tokens: 67,
					warnings: ["Supervisor token note"],
				},
			});
			return;
		}
		await fulfill(404, { error: "not_found" });
	});
}

export function installCatalogue(page: Page, count = 50): Promise<unknown> {
	const projects = Array.from({ length: count }, (_, index) => ({
		id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
		title: "M3 cloud acceptance",
		history_availability: "NOT_PROVIDED",
		demand_revision: 0,
		analysis_version: 0,
		created_at: new Date(Date.UTC(2026, 9, 1, 1, index)).toISOString(),
		latest_run: null,
	}));
	return page.route("**/api/**", async (route: Route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const fulfill = (status: number, body: unknown) =>
			route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects });
			return;
		}
		const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
		if (request.method() === "GET" && projectMatch) {
			const found = projects.find((item) => item.id === decodeURIComponent(projectMatch[1]));
			if (!found) {
				await fulfill(404, { error: "not_found" });
				return;
			}
			await fulfill(200, { ...found, sources: [] });
			return;
		}
		if (request.method() === "GET" && /\/runs$/.test(path)) {
			await fulfill(200, { runs: [] });
			return;
		}
		if (request.method() === "GET" && path.endsWith("/requirement-text")) {
			await fulfill(404, { error: "not_found" });
			return;
		}
		if (request.method() === "GET" && path.endsWith("/requirements")) {
			await fulfill(404, { error: "not_compiled" });
			return;
		}
		await fulfill(404, { error: "not_found" });
	});
}

export { LONG_PPTX, LONG_TITLE };
