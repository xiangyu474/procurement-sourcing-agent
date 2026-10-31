/**
 * FIXTURE — browser-test double for the gateway.
 * Imported only by Playwright. The Vite build does not include this module,
 * and the running app never substitutes these responses for a real API call.
 */
import type { Page, Route } from "@playwright/test";

type Mode = "partial" | "compile-failed";

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
		runId: "22222222-2222-4222-8222-222222222222",
	};

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

		if (request.method() === "POST" && path === "/api/projects") {
			const body = await json();
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
					unstructured_requirements: [],
					issues: [],
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
			const status = state.runReads >= 2 ? "PARTIAL" : "RUNNING";
			await fulfill(200, {
				id: state.runId,
				project_id: state.id,
				status,
				current_stage: status === "PARTIAL" ? "PARTIAL" : "WEB_RESEARCH",
				artifact_key: null,
				last_error: null,
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
					stop_reason_code: "BUDGET_EXHAUSTED",
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

export { LONG_PPTX, LONG_TITLE };
