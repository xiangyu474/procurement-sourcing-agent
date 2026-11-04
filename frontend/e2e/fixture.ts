/**
 * FIXTURE — browser-test double for the gateway.
 *
 * It answers with the published shapes of the frozen analysis API
 * (`GET /api/projects/{id}/analysis`), the pipeline status API and the guest
 * session API. The Vite build does not include this module and the running
 * app never substitutes these responses for a real API call. A fixture run is
 * not an acceptance of the public demo.
 */
import type { Page, Route } from "@playwright/test";

type Mode = "partial" | "completed" | "failed" | "compile-failed";

const LONG_TITLE = "集团总部2026年度工业视觉与网络摄像机框架寻源（含多园区、多品牌、超长名称不应撑破项目栏）";
const LONG_PPTX = "华北区域工业相机及配套镜头年度框架采购技术规格书终版修订-供应商名称也很长.pptx";

type FixtureCandidate = {
	candidate_id: string;
	requirement_id: string;
	supplier_name: string;
	product_model: string;
	evidence_ids?: string[];
};
type FixtureAssessment = {
	assessment_id: string;
	requirement_id: string;
	product_candidate_id: string;
	product_model_ref?: string;
	hard_spec_overall: string;
	overall_reason_codes?: string[];
	checks?: unknown[];
	evidence_ids?: string[];
};

type FixtureDecision = {
	decision_id: string;
	requirement_id: string;
	product_candidate_id: string;
	product_model_ref?: string;
	recommendation: string;
	technical_verdict: string;
	hard_spec_overall: string;
	accepted: boolean;
	rationale?: string;
	display?: Record<string, unknown>;
};

type FixtureReport = {
	report_id?: string | null;
	status: string;
	error_code?: string | null;
	decision_version?: string | null;
	download_path?: string | null;
};

export function analysisPayload(input: {
	projectId: string;
	pipelineId: string;
	runId: string;
	requirements?: unknown[];
	candidates: FixtureCandidate[];
	assessments: FixtureAssessment[];
	decisions: FixtureDecision[];
	priceContexts?: unknown[];
	evidence?: unknown[];
	report?: FixtureReport;
}): Record<string, unknown> {
	const candidates = input.candidates.map((item) => ({
		candidate_id: item.candidate_id,
		requirement_id: item.requirement_id,
		supplier_id: `s-${item.candidate_id}`,
		product_id: `p-${item.requirement_id}`,
		supplier_name: item.supplier_name,
		product_model: item.product_model,
		product_name: item.product_model,
		stage: "DISCOVERED_LONG_LIST",
		rationale: null,
		evidence_ids: item.evidence_ids ?? [],
		open_questions: [],
	}));
	const assessments = input.assessments.map((item) => ({
		assessment_id: item.assessment_id,
		requirement_id: item.requirement_id,
		product_candidate_id: item.product_candidate_id,
		product_model_ref: item.product_model_ref ?? null,
		hard_spec_overall: item.hard_spec_overall,
		overall_reason_codes: item.overall_reason_codes ?? [],
		hard_constraint_count: null,
		unresolved_question_ids: [],
		evaluated_at: "2026-11-01T13:00:00.000Z",
		checks: item.checks ?? [],
	}));
	const decisions = input.decisions.map((item) => ({
		decision_id: item.decision_id,
		requirement_id: item.requirement_id,
		product_candidate_id: item.product_candidate_id,
		product_model_ref: item.product_model_ref ?? null,
		recommendation: item.recommendation,
		technical_verdict: item.technical_verdict,
		hard_spec_overall: item.hard_spec_overall,
		accepted: item.accepted,
		rationale: item.rationale ?? "internal rationale stays hidden",
		evidence_ids: [],
		gaps: [],
		next_actions: [],
		priority_rank: null,
		violations: [],
		decided_at: "2026-11-01T14:00:00.000Z",
		display:
			item.display ??
			{
				version: "decision-display-v1",
				basis: "STRUCTURED_ASSESSMENT_NOT_TRANSLATION",
				summary_code: "RECOMMENDED_INQUIRY_VERIFIED",
				summary_zh: "硬性条件的程序核验通过；可作为询价建议，仍需供应商确认。",
				gaps: [],
				next_actions: [],
				unresolved_question_ids: [],
				untranslated_originals: { rationale: true, gap_count: 0, next_action_count: 0 },
			},
	}));
	const models = new Map<string, { rows: number; suppliers: Set<string> }>();
	for (const item of candidates) {
		const key = `${item.requirement_id}::${item.product_model}`;
		const entry = models.get(key) ?? { rows: 0, suppliers: new Set<string>() };
		entry.rows += 1;
		entry.suppliers.add(item.supplier_id);
		models.set(key, entry);
	}
	const byVerdict: Record<string, number> = {};
	for (const item of assessments) byVerdict[item.hard_spec_overall] = (byVerdict[item.hard_spec_overall] ?? 0) + 1;
	const byRecommendation: Record<string, number> = {};
	for (const item of decisions) byRecommendation[item.recommendation] = (byRecommendation[item.recommendation] ?? 0) + 1;
	const warnings: string[] = [];
	if (!candidates.length) warnings.push("这次寻源没有找到可核对的候选。");
	if (models.size === 1 && candidates.length > 0) warnings.push("这次只找到一个型号，候选行来自不同供应商，而不是不同型号。");
	if (byVerdict.PASS === undefined && assessments.length > 0) warnings.push("没有任何候选通过硬性核验，结论多为证据不足。");
	const evidence = input.evidence ?? [];
	const report = input.report ?? { status: "NOT_STARTED", report_id: null, error_code: null, decision_version: null, download_path: null };
	return {
		project_id: input.projectId,
		pipeline_id: input.pipelineId,
		run_id: input.runId,
		demand_revision: 1,
		research_status: "COMPLETED",
		decision_version: report.decision_version ?? null,
		requirements: input.requirements ?? [],
		candidates,
		assessments,
		decisions,
		price_contexts: input.priceContexts ?? [],
		evidence,
		summary: {
			requirements: (input.requirements ?? []).length,
			candidate_rows: candidates.length,
			distinct_models: models.size,
			distinct_suppliers: new Set(candidates.map((item) => item.supplier_id)).size,
			models: [...models.entries()].map(([key, entry]) => ({
				product_model: key.split("::")[1] ?? "",
				product_id: key.split("::")[0] ?? "",
				candidate_rows: entry.rows,
				supplier_count: entry.suppliers.size,
			})),
			assessments: assessments.length,
			by_verdict: byVerdict,
			decisions: decisions.length,
			by_recommendation: byRecommendation,
			evidence: evidence.length,
			coverage_warnings: warnings,
		},
		report: { ...report, warning_codes: [] },
	};
}

/** The guest session and the pipeline list every fixture needs. */
async function serveSessionAndPipelines(
	route: Route,
	projectId: string,
	pipelines: unknown[],
	session: "guest" | "none" = "guest",
): Promise<boolean> {
	const request = route.request();
	const path = new URL(request.url()).pathname;
	const fulfill = (status: number, body: unknown) =>
		route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
	if (session === "guest" && request.method() === "POST" && path === "/api/session") {
		await fulfill(201, { expires_at: "2026-11-05T00:00:00.000Z" });
		return true;
	}
	if (session === "guest" && request.method() === "GET" && path === "/api/session") {
		await fulfill(200, { expires_at: "2026-11-05T00:00:00.000Z" });
		return true;
	}
	if (request.method() === "GET" && path === `/api/projects/${projectId}/pipelines`) {
		await fulfill(200, { project_id: projectId, pipelines, has_more: false });
		return true;
	}
	const detail = path.match(/^\/api\/projects\/([^/]+)\/pipeline\/([^/]+)$/);
	if (request.method() === "GET" && detail) {
		const found = (pipelines as Array<Record<string, unknown>>).find((item) => item.pipeline_id === decodeURIComponent(detail[2]));
		// An unknown task belongs to the fixture that knows it.
		if (!found) return false;
		await fulfill(200, {
			...found,
			project_id: projectId,
			error: null,
			report_error_code: null,
			download_path: found.report_status === "COMPLETED" ? `/api/projects/${projectId}/reports/report-1/download` : null,
			candidates_found: 0,
			models_found: 0,
			evidence_found: 0,
			stages: [{ stage: "RESEARCH", status: "COMPLETED", started_at: "2026-10-31T00:03:00.000Z", finished_at: "2026-10-31T00:04:00.000Z", error_code: null }],
		});
		return true;
	}
	return false;
}

/** A finished pipeline of a project, so the page can find the task again. */
function finishedPipeline(pipelineId: string, runId: string): Record<string, unknown> {
	return {
		pipeline_id: pipelineId,
		run_id: runId,
		demand_revision: 1,
		status: "COMPLETED",
		stage: "COMPLETED",
		decision_version: "version-1",
		report_id: "report-1",
		report_status: "COMPLETED",
		created_at: "2026-10-31T00:03:00.000Z",
		updated_at: "2026-10-31T00:04:00.000Z",
	};
}

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
		pipelineId: "33333333-3333-4333-8333-333333333333",
		pipelineKey: "" as string,
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
					status: state.runReads >= 3 ? (mode === "completed" ? "COMPLETED" : mode === "failed" ? "FAILED" : "PARTIAL") : "RUNNING",
					current_stage: state.runReads >= 3 ? (mode === "completed" ? "WEB_RESEARCH" : mode === "failed" ? "FAILED" : "PARTIAL") : "WEB_RESEARCH",
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

		if (await serveSessionAndPipelines(route, state.id, [])) return;

		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: state.created ? [projectSummary()] : [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/runs`) {
			const terminal = mode === "completed" ? "COMPLETED" : mode === "failed" ? "FAILED" : "PARTIAL";
			const status = state.runReads >= 3 ? terminal : state.runReads > 0 ? "RUNNING" : null;
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
		if (request.method() === "POST" && path === `/api/projects/${state.id}/pipeline`) {
			const key = request.headers()["idempotency-key"] ?? "";
			const body = await json();
			const reused = state.pipelineKey !== "" && state.pipelineKey === key;
			if (!reused) state.pipelineKey = key;
			await fulfill(202, {
				pipeline_id: state.pipelineId,
				run_id: state.runId,
				demand_revision: body.demand_revision,
				status: "QUEUED",
				reused,
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/pipeline/${state.pipelineId}`) {
			const terminal = mode === "completed" ? "COMPLETED" : mode === "failed" ? "FAILED" : "PARTIAL";
			const done = state.runReads >= 3;
			await fulfill(200, {
				pipeline_id: state.pipelineId,
				project_id: state.id,
				run_id: state.runId,
				demand_revision: state.demandRevision,
				status: done ? terminal : "RUNNING",
				stage: done ? terminal : "RESEARCH",
				error: null,
				decision_version: done ? "version-1" : null,
				report_id: done ? "report-1" : null,
				report_status: done ? "COMPLETED" : "NOT_STARTED",
				report_error_code: null,
				download_path: done ? `/api/projects/${state.id}/reports/report-1/download` : null,
				candidates_found: 0,
				models_found: 0,
				evidence_found: 0,
				stages: [
					{
						stage: "RESEARCH",
						status: done ? "COMPLETED" : "RUNNING",
						started_at: "2026-10-31T00:03:00.000Z",
						finished_at: done ? "2026-10-31T00:04:00.000Z" : null,
						error_code: null,
					},
				],
				created_at: "2026-10-31T00:03:00.000Z",
				updated_at: "2026-10-31T00:04:00.000Z",
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/analysis`) {
			await fulfill(200, analysisPayload({ projectId: state.id, pipelineId: state.pipelineId, runId: state.runId, candidates: [], assessments: [], decisions: [] }));
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${state.id}/reports`) {
			await fulfill(200, { project_id: state.id, reports: [] });
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${state.id}/runs`) {
			await fulfill(202, { run_id: state.runId, status: "QUEUED", mode: "SOURCING" });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${state.runId}`) {
			state.runReads += 1;
			const terminal = mode === "completed" ? "COMPLETED" : mode === "failed" ? "FAILED" : "PARTIAL";
			const status = state.runReads >= 3 ? terminal : "RUNNING";
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
		if (request.method() === "POST" && path === "/api/session") {
			await fulfill(201, { expires_at: "2026-11-05T00:00:00.000Z" });
			return;
		}
		if (request.method() === "GET" && path === "/api/session") {
			await fulfill(200, { expires_at: "2026-11-05T00:00:00.000Z" });
			return;
		}
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

const REVIEW_PROJECT = "33333333-3333-4333-8333-333333333333";
const REVIEW_RUN = "44444444-4444-4444-8444-444444444444";

export function installReview(page: Page, variant: "mixed" | "none" = "mixed"): Promise<unknown> {
	const requirements = [
		{
			requirement_id: "r1",
			product_name: "工业摄像机",
			product_category: "摄像机",
			quantity: 10,
			quantity_unit: "台",
			constraints: [{ constraint_id: "k-pixel", attribute_key: "pixel", attribute_definition: "像素", operator: "GTE", value: "4", unit: "MP", importance: "HARD", source_quote: null }],
		},
		{
			requirement_id: "r2",
			product_name: "云台探头",
			product_category: "摄像机",
			quantity: 2,
			quantity_unit: "台",
			constraints: [],
		},
	];
	const evidence = [
		{ evidence_id: "ev_pass", url: "https://example.com/ds-2cd", title: "产品规格页", content_sha256: "abc", quote: "500万像素，防护等级 IP67。", quote_status: "ORIGINAL" },
	];
	const candidates = variant === "none" ? [] : [
		{ candidate_id: "c-pass", requirement_id: "r1", supplier_name: "海康威视", product_model: "DS-2CD2347G2-LU", evidence_ids: ["ev_pass"] },
		{ candidate_id: "c-unknown", requirement_id: "r1", supplier_name: "华北区域工业视觉设备联合体（含多园区超长供应商名称不应撑破表格）", product_model: "DH-IPC-HFW5442", evidence_ids: [] },
		{ candidate_id: "c-fail", requirement_id: "r1", supplier_name: "宇视科技", product_model: "IPC-B312", evidence_ids: [] },
		{ candidate_id: "c-verify", requirement_id: "r1", supplier_name: "大华股份", product_model: "DH-SD-VERIFY", evidence_ids: [] },
		{ candidate_id: "c-overview", requirement_id: "r2", supplier_name: "目录中的供应商", product_model: "PTZ-OVERVIEW", evidence_ids: [] },
	];
	const check = (status: string) => ({
		constraint_id: "k-pixel",
		requirement_id: "r1",
		claim_ids: [],
		status,
		reason_code: status === "UNKNOWN" ? "MISSING_CLAIM" : "VERIFIED_COMPARISON",
		operation: "4.9152 MP GTE 4 MP",
		normalized_actual: status === "UNKNOWN" ? null : status === "FAIL" ? "2" : "5",
		normalized_required: "4",
		unit: "MP",
		evidence_ids: ["ev_pass"],
		importance: "HARD",
	});
	const assessment = (id: string, candidateId: string, model: string, overall: string) => ({
		assessment_id: id,
		requirement_id: candidateId === "c-overview" ? "r2" : "r1",
		product_candidate_id: candidateId,
		product_model_ref: model,
		hard_spec_overall: overall,
		overall_reason_codes: [],
		hard_constraint_count: 1,
		checks: candidateId === "c-overview" ? [] : [check(overall)],
		evidence_ids: ["ev_pass"],
	});
	const display = (code: string, text: string) => ({
		version: "decision-display-v1",
		basis: "STRUCTURED_ASSESSMENT_NOT_TRANSLATION",
		summary_code: code,
		summary_zh: text,
		gaps: code === "EVIDENCE_INSUFFICIENT" ? [{ code: "MISSING_CLAIM", constraint_id: "k-pixel", importance: "HARD", evidence_ids: [], text_zh: "尚未找到支持该项指标的可用资料。" }] : [],
		next_actions: code === "EVIDENCE_INSUFFICIENT" ? [{ code: "MISSING_CLAIM", constraint_id: "k-pixel", text_zh: "补充该型号的对应技术资料并核验来源。" }] : [],
		unresolved_question_ids: [],
		untranslated_originals: { rationale: true, gap_count: 0, next_action_count: 0 },
	});
	const decisions = variant === "none" ? [] : [
		{ decision_id: "dec-pass", requirement_id: "r1", product_candidate_id: "c-pass", product_model_ref: "DS-2CD2347G2-LU", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true, display: display("RECOMMENDED_INQUIRY_VERIFIED", "硬性条件的程序核验通过；可作为询价建议，仍需供应商确认。") },
		{ decision_id: "dec-unknown", requirement_id: "r1", product_candidate_id: "c-unknown", product_model_ref: "DH-IPC-HFW5442", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: false, display: display("GATE_REJECTED", "该建议未通过验证门禁，暂不可采纳。") },
		{ decision_id: "dec-fail", requirement_id: "r1", product_candidate_id: "c-fail", product_model_ref: "IPC-B312", recommendation: "EXCLUDE", technical_verdict: "VERIFIED_FAIL", hard_spec_overall: "FAIL", accepted: true, display: display("HARD_REQUIREMENT_FAILED", "至少一项硬性条件核验不通过，建议排除。") },
		{ decision_id: "dec-verify", requirement_id: "r1", product_candidate_id: "c-verify", product_model_ref: "DH-SD-VERIFY", recommendation: "INVESTIGATE", technical_verdict: "UNVERIFIED", hard_spec_overall: "UNKNOWN", accepted: true, display: display("EVIDENCE_INSUFFICIENT", "现有证据不足以判断是否符合全部硬性条件，建议补充核验。") },
		{ decision_id: "dec-overview", requirement_id: "r2", product_candidate_id: "c-overview", product_model_ref: "PTZ-OVERVIEW", recommendation: "INVESTIGATE", technical_verdict: "UNVERIFIED", hard_spec_overall: "UNKNOWN", accepted: true, display: display("EVIDENCE_INSUFFICIENT", "现有证据不足以判断是否符合全部硬性条件，建议补充核验。") },
	];
	const priceContexts = [
		{
			requirement_id: "r1",
			product_name: "工业摄像机",
			budget: "100",
			budget_currency: "CNY",
			budget_unit: "元/套",
			history_scope: "NONE",
			history_available: false,
			history_rows: 0,
			statistics: null,
			overview_statistics: null,
			overview_is_not_a_baseline: false,
			findings: [{ lowest_basis: "PUBLIC_REFERENCE", lowest_value: "128", saving: null, saving_percent: null, comparability: "COMPARABLE", explanation: null, lowest_observation_id: null }],
			notes: [],
		},
		{
			requirement_id: "r2",
			product_name: "云台探头",
			budget: null,
			budget_currency: null,
			budget_unit: null,
			history_scope: "TABLE_OVERVIEW",
			history_available: false,
			history_rows: 0,
			statistics: null,
			overview_statistics: { count: 1000, minimum: "77", maximum: "1255", currency: "CNY", unit: "元/台" },
			overview_is_not_a_baseline: true,
			findings: [],
			notes: [],
		},
	];
	const project = {
		id: REVIEW_PROJECT,
		title: "工业摄像机寻源",
		history_availability: "NOT_PROVIDED",
		demand_revision: 1,
		analysis_version: 1,
		created_at: "2026-10-31T00:00:00.000Z",
		latest_run: { id: REVIEW_RUN, status: "COMPLETED", current_stage: "WEB_RESEARCH", updated_at: "2026-10-31T04:00:00.000Z" },
	};
	return page.route("**/api/**", async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const fulfill = (status: number, body: unknown) =>
			route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
		if (await serveSessionAndPipelines(route, REVIEW_PROJECT, [finishedPipeline("pipe-review", REVIEW_RUN)])) return;
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: [project] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}`) {
			await fulfill(200, { ...project, sources: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/reports`) {
			await fulfill(200, { project_id: REVIEW_PROJECT, reports: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/runs`) {
			await fulfill(200, { runs: [{ id: REVIEW_RUN, status: "COMPLETED", current_stage: "WEB_RESEARCH", last_error: null, stop_reason_code: null, artifact_key_present: false, created_at: "2026-10-31T01:00:00.000Z", updated_at: "2026-10-31T04:00:00.000Z" }] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/requirement-text`) {
			await fulfill(404, { error: "not_found" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/requirements`) {
			await fulfill(200, { analysis_version: 1, compilation: { requirements, issues: [] } });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/analysis`) {
			await fulfill(200, analysisPayload({
				projectId: REVIEW_PROJECT,
				pipelineId: "pipe-review",
				runId: REVIEW_RUN,
				requirements,
				candidates,
				assessments: variant === "none" ? [] : [
					assessment("spc-pass", "c-pass", "DS-2CD2347G2-LU", "PASS"),
					assessment("spc-unknown", "c-unknown", "DH-IPC-HFW5442", "UNKNOWN"),
					assessment("spc-fail", "c-fail", "IPC-B312", "FAIL"),
					assessment("spc-verify", "c-verify", "DH-SD-VERIFY", "UNKNOWN"),
					assessment("spc-overview", "c-overview", "PTZ-OVERVIEW", "UNKNOWN"),
				],
				decisions,
				priceContexts,
				evidence,
			}));
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${REVIEW_RUN}`) {
			await fulfill(200, { id: REVIEW_RUN, project_id: REVIEW_PROJECT, status: "COMPLETED", current_stage: "WEB_RESEARCH", artifact_key: null, last_error: null, created_at: "2026-10-31T01:00:00.000Z", updated_at: "2026-10-31T04:00:00.000Z" });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${REVIEW_RUN}/events`) {
			await fulfill(200, { events: [{ stage: "WEB_RESEARCH", detail: "Supervisor finished", created_at: "2026-10-31T01:30:00.000Z" }] });
			return;
		}
		if (request.method() === "GET" && path === "/api/evidence/ev_pass") {
			await fulfill(200, {
				evidence: {
					evidence_id: "ev_pass",
					source_type: "WEB",
					source_url: "https://example.com/ds-2cd",
					normalized_url: "https://example.com/ds-2cd",
					title: "产品规格页",
					publisher: "example",
					retrieved_at: "2026-10-31T01:16:00.000Z",
					locator: null,
					excerpt: "500万像素，防护等级 IP67。",
					content_sha256: "abc",
					snapshot_r2_key: "workspaces/default/secret-snapshot",
					trust_notes: null,
					snapshot_text: "页面正文：500万像素。",
				},
			});
			return;
		}
		await fulfill(404, { error: "not_found" });
	});
}

const KNOWN_PROJECT = "a54edd18-0000-4000-8000-000000000001";const KNOWN_RUN = "a54edd18-0000-4000-8000-000000000002";

export function installKnownCase(page: Page): Promise<unknown> {
	const longSupplier = "华北区域工业视觉设备联合体（含多园区超长供应商名称不应撑破表格）";
	const nbn = (index: number) => ({
		candidate_id: `c-nbn-${index}`,
		requirement_id: "r1",
		supplier_name: "宁波某供应商",
		product_model: "NBN-80052-BA",
		evidence_ids: ["ev_nbn"],
	});
	const candidates = [
		nbn(1),
		nbn(2),
		nbn(3),
		nbn(4),
		{
			candidate_id: "c-ips",
			requirement_id: "r1",
			supplier_name: longSupplier,
			product_model: "IPS05-R10-OIA4-EXTRA-LONG-MODEL-TOKEN",
			evidence_ids: ["ev_ips"],
		},
		{
			candidate_id: "c-repeat",
			requirement_id: "r1",
			supplier_name: "宁波某供应商",
			product_model: "NBN-80052-BA",
			evidence_ids: ["ev_nbn"],
		},
	];
	const passCheck = {
		constraint_id: "k-pixel",
		requirement_id: "r1",
		claim_ids: [],
		status: "PASS",
		reason_code: "VERIFIED_COMPARISON",
		operation: "5 MP GTE 5 MP",
		normalized_actual: "5",
		normalized_required: "5",
		unit: "MP",
		evidence_ids: ["ev_nbn"],
		importance: "HARD",
	};
	const failCheck = {
		constraint_id: "k-pixel",
		requirement_id: "r1",
		claim_ids: [],
		status: "FAIL",
		reason_code: "VERIFIED_COMPARISON",
		operation: "4.9152 MP GTE 5 MP",
		normalized_actual: "4.9152",
		normalized_required: "5",
		unit: "MP",
		evidence_ids: ["ev_ips"],
		importance: "HARD",
	};
	const assessment = (id: string, candidateId: string, model: string, overall: string, check: unknown) => ({
		assessment_id: id,
		requirement_id: "r1",
		product_candidate_id: candidateId,
		product_model_ref: model,
		hard_spec_overall: overall,
		overall_reason_codes: ["VERIFIED_COMPARISON"],
		hard_constraint_count: 1,
		checks: [check],
		evidence_ids: overall === "FAIL" ? ["ev_ips"] : ["ev_nbn"],
	});
	const display = (code: string, text: string) => ({
		version: "decision-display-v1",
		basis: "STRUCTURED_ASSESSMENT_NOT_TRANSLATION",
		summary_code: code,
		summary_zh: text,
		gaps: [],
		next_actions: [],
		unresolved_question_ids: [],
		untranslated_originals: { rationale: true, gap_count: 0, next_action_count: 0 },
	});
	const decisions = [
		{ decision_id: "dec-nbn-1", requirement_id: "r1", product_candidate_id: "c-nbn-1", product_model_ref: "NBN-80052-BA", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true, display: display("RECOMMENDED_INQUIRY_VERIFIED", "硬性条件的程序核验通过；可作为询价建议，仍需供应商确认。") },
		{ decision_id: "dec-nbn-2", requirement_id: "r1", product_candidate_id: "c-nbn-2", product_model_ref: "NBN-80052-BA", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true, display: display("RECOMMENDED_INQUIRY_VERIFIED", "硬性条件的程序核验通过；可作为询价建议，仍需供应商确认。") },
		{ decision_id: "dec-nbn-3", requirement_id: "r1", product_candidate_id: "c-nbn-3", product_model_ref: "NBN-80052-BA", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true, display: display("RECOMMENDED_INQUIRY_VERIFIED", "硬性条件的程序核验通过；可作为询价建议，仍需供应商确认。") },
		{ decision_id: "dec-nbn-4", requirement_id: "r1", product_candidate_id: "c-nbn-4", product_model_ref: "NBN-80052-BA", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true, display: display("RECOMMENDED_INQUIRY_VERIFIED", "硬性条件的程序核验通过；可作为询价建议，仍需供应商确认。") },
		{ decision_id: "dec-ips", requirement_id: "r1", product_candidate_id: "c-ips", product_model_ref: "IPS05-R10-OIA4-EXTRA-LONG-MODEL-TOKEN", recommendation: "EXCLUDE", technical_verdict: "VERIFIED_FAIL", hard_spec_overall: "FAIL", accepted: true, display: display("HARD_REQUIREMENT_FAILED", "至少一项硬性条件核验不通过，建议排除。") },
		{ decision_id: "dec-repeat", requirement_id: "r1", product_candidate_id: "c-repeat", product_model_ref: "NBN-80052-BA", recommendation: "EXCLUDE", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true, display: display("REVIEW_REQUIRED", "与已列出的同型号重复，不再单独询价。") },
	];
	const project = {
		id: KNOWN_PROJECT,
		title: "M3 cloud acceptance",
		history_availability: "NOT_PROVIDED",
		demand_revision: 1,
		analysis_version: 1,
		created_at: "2026-11-01T09:00:00.000Z",
		latest_run: { id: KNOWN_RUN, status: "COMPLETED", current_stage: "WEB_RESEARCH", updated_at: "2026-11-01T14:00:00.000Z" },
	};
	return page.route("**/api/**", async (route: Route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const fulfill = (status: number, body: unknown) =>
			route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
		if (await serveSessionAndPipelines(route, KNOWN_PROJECT, [finishedPipeline("pipe-known", KNOWN_RUN)])) return;
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: [project] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}`) {
			await fulfill(200, { ...project, sources: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/reports`) {
			await fulfill(200, { project_id: KNOWN_PROJECT, reports: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/runs`) {
			await fulfill(200, { runs: [{ id: KNOWN_RUN, status: "COMPLETED", current_stage: "WEB_RESEARCH", last_error: null, stop_reason_code: "SUPERVISOR_RESEARCHER_ERROR", artifact_key_present: false, created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-01T14:00:00.000Z" }] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/requirement-text`) {
			await fulfill(404, { error: "not_found" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/requirements`) {
			await fulfill(200, {
				analysis_version: 1,
				compilation: {
					requirements: [{
						requirement_id: "r1",
						product_name: "工业摄像机",
						constraints: [{ constraint_id: "k-pixel", attribute_definition: "像素", operator: "GTE", value: "5", unit: "MP" }],
						planned_total_budget: null,
						planned_unit_price: { kind: "PLANNED_PRICE", value: "100", currency: "CNY", unit: "元/套" },
					}],
					issues: [],
				},
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/analysis`) {
			await fulfill(200, analysisPayload({
				projectId: KNOWN_PROJECT,
				pipelineId: "pipe-known",
				runId: KNOWN_RUN,
				requirements: [{
					requirement_id: "r1",
					product_name: "工业摄像机",
					product_category: "摄像机",
					quantity: 10,
					quantity_unit: "台",
					constraints: [{ constraint_id: "k-pixel", attribute_key: "pixel", attribute_definition: "像素", operator: "GTE", value: "5", unit: "MP", importance: "HARD", source_quote: null }],
				}],
				candidates,
				assessments: [
					assessment("spc-nbn-1", "c-nbn-1", "NBN-80052-BA", "PASS", passCheck),
					assessment("spc-nbn-2", "c-nbn-2", "NBN-80052-BA", "PASS", passCheck),
					assessment("spc-nbn-3", "c-nbn-3", "NBN-80052-BA", "PASS", passCheck),
					assessment("spc-nbn-4", "c-nbn-4", "NBN-80052-BA", "PASS", passCheck),
					assessment("spc-ips", "c-ips", "IPS05-R10-OIA4-EXTRA-LONG-MODEL-TOKEN", "FAIL", failCheck),
					assessment("spc-repeat", "c-repeat", "NBN-80052-BA", "PASS", passCheck),
				],
				decisions,
				priceContexts: [{
					requirement_id: "r1",
					product_name: "工业摄像机",
					budget: "100",
					budget_currency: "CNY",
					budget_unit: "元/套",
					history_scope: "NONE",
					history_available: false,
					history_rows: 0,
					statistics: null,
					overview_statistics: null,
					overview_is_not_a_baseline: false,
					findings: [],
					notes: [],
				}],
				evidence: [
					{ evidence_id: "ev_nbn", url: "https://example.com/nbn", title: "NBN 规格页", content_sha256: "abc", quote: "像素不低于 5MP。", quote_status: "ORIGINAL" },
					{ evidence_id: "ev_ips", url: "https://example.com/ips", title: "IPS 规格页", content_sha256: "def", quote: "分辨率约 4.9MP。", quote_status: "ORIGINAL" },
				],
			}));
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${KNOWN_RUN}`) {
			await fulfill(200, { id: KNOWN_RUN, project_id: KNOWN_PROJECT, status: "COMPLETED", current_stage: "WEB_RESEARCH", artifact_key: null, last_error: null, created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-01T14:00:00.000Z" });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${KNOWN_RUN}/events`) {
			await fulfill(200, { events: [] });
			return;
		}
		if (request.method() === "GET" && path === "/api/evidence/ev_ips") {
			await fulfill(200, { evidence: { evidence_id: "ev_ips", title: "IPS 规格页", source_url: "https://example.com/ips", retrieved_at: "2026-11-01T08:05:00.000Z", excerpt: "分辨率约 4.9MP。", snapshot_text: "页面正文：4.9152 MP。", snapshot_r2_key: "workspaces/default/secret-snapshot", locator: "tavily-extract:ips" } });
			return;
		}
		if (request.method() === "GET" && path === "/api/evidence/ev_nbn") {
			await fulfill(200, { evidence: { evidence_id: "ev_nbn", title: "NBN 规格页", source_url: "https://example.com/nbn", retrieved_at: "2026-11-01T08:00:00.000Z", excerpt: "像素不低于 5MP。", snapshot_text: "页面正文：5 MP。", snapshot_r2_key: "workspaces/default/secret-snapshot", locator: "tavily-extract:nbn" } });
			return;
		}
		await fulfill(404, { error: "not_found" });
	});
}

const REPORT_PROJECT = "55555555-5555-4555-8555-555555555555";
const REPORT_RUN = "66666666-6666-4666-8666-666666666666";

export function installReportFlow(page: Page, mode: "generate" | "completed" | "failed" | "blocked" | "prior-failed" | "older"): Promise<unknown> {
	const posts: string[] = [];
	let polls = 0;
	let reportReads = 0;
	const project = {
		id: REPORT_PROJECT,
		title: "正式报告项目",
		history_availability: "NOT_PROVIDED",
		demand_revision: 1,
		analysis_version: 1,
		created_at: "2026-10-31T00:00:00.000Z",
		latest_run: { id: mode === "older" ? "77777777-7777-4777-8777-777777777777" : REPORT_RUN, status: "COMPLETED", current_stage: "WEB_RESEARCH", updated_at: mode === "older" ? "2026-10-31T12:00:00.000Z" : "2026-10-31T02:00:00.000Z" },
	};
	const completed = {
		report_id: "report-1",
		run_id: REPORT_RUN,
		status: "COMPLETED",
		decision_version: "3f2a9c1b7d0e4a55",
		byte_size: 12,
		sha256: "abc",
		error: null,
		download_path: `/api/projects/${REPORT_PROJECT}/reports/report-1/download`,
		created_at: "2026-10-31T02:10:00.000Z",
		updated_at: "2026-10-31T02:12:00.000Z",
	};
	const reportStatus = (runId: string | null) => {
		if (mode === "completed") return { report_id: "report-1", status: "COMPLETED", error_code: null, decision_version: "3f2a9c1b7d0e4a55", download_path: `/api/projects/${REPORT_PROJECT}/reports/report-1/download` };
		if (mode === "failed" || mode === "prior-failed") return { report_id: "report-1", status: "FAILED", error_code: "REPORT_GENERATION_FAILED", decision_version: null, download_path: null };
		if (mode === "blocked") return { report_id: null, status: "NOT_STARTED", error_code: null, decision_version: null, download_path: null };
		if (mode === "older" && runId !== "77777777-7777-4777-8777-777777777777") {
			return { report_id: "report-1", status: "COMPLETED", error_code: null, decision_version: "3f2a9c1b7d0e4a55", download_path: `/api/projects/${REPORT_PROJECT}/reports/report-1/download` };
		}
		return { report_id: "report-1", status: "QUEUED", error_code: null, decision_version: "3f2a9c1b7d0e4a55", download_path: null };
	};
	return page.route("**/api/**", async (route: Route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const fulfill = (status: number, body: unknown) =>
			route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
		if (await serveSessionAndPipelines(route, REPORT_PROJECT, [finishedPipeline("pipe-report", mode === "older" ? "77777777-7777-4777-8777-777777777777" : REPORT_RUN)], "none")) return;
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: [project] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}`) {
			await fulfill(200, { ...project, sources: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}/runs`) {
			const older = { id: REPORT_RUN, status: "COMPLETED", current_stage: "WEB_RESEARCH", last_error: null, stop_reason_code: null, artifact_key_present: false, created_at: "2026-10-31T01:00:00.000Z", updated_at: "2026-10-31T02:00:00.000Z" };
			const newer = { id: "77777777-7777-4777-8777-777777777777", status: "COMPLETED", current_stage: "WEB_RESEARCH", last_error: null, stop_reason_code: null, artifact_key_present: false, created_at: "2026-10-31T12:00:00.000Z", updated_at: "2026-10-31T12:00:00.000Z" };
			await fulfill(200, { runs: mode === "older" ? [newer, older] : [older] });
			return;
		}
		if (request.method() === "GET" && path === "/api/runs/77777777-7777-4777-8777-777777777777") {
			await fulfill(200, { id: "77777777-7777-4777-8777-777777777777", project_id: REPORT_PROJECT, status: "COMPLETED", current_stage: "WEB_RESEARCH", artifact_key: null, last_error: null, created_at: "2026-10-31T12:00:00.000Z", updated_at: "2026-10-31T12:00:00.000Z" });
			return;
		}
		if (request.method() === "GET" && path === "/api/runs/77777777-7777-4777-8777-777777777777/events") {
			await fulfill(200, { events: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${REPORT_RUN}`) {
			await fulfill(200, { id: REPORT_RUN, project_id: REPORT_PROJECT, status: "COMPLETED", current_stage: "WEB_RESEARCH", artifact_key: null, last_error: null, created_at: "2026-10-31T01:00:00.000Z", updated_at: "2026-10-31T02:00:00.000Z" });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${REPORT_RUN}/events`) {
			await fulfill(200, { events: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}/requirement-text`) {
			await fulfill(404, { error: "not_found" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}/requirements`) {
			await fulfill(404, { error: "not_compiled" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}/analysis`) {
			const runId = new URL(request.url()).searchParams.get("run_id");
			const empty = mode === "blocked" || runId === "77777777-7777-4777-8777-777777777777";
			await fulfill(200, analysisPayload({
				projectId: REPORT_PROJECT,
				pipelineId: "pipe-report",
				runId: runId ?? REPORT_RUN,
				requirements: [],
				candidates: empty ? [] : [{ candidate_id: "c1", requirement_id: "r1", supplier_name: "海康威视", product_model: "DS-1", evidence_ids: [] }],
				assessments: empty ? [] : [{ assessment_id: "spc-1", requirement_id: "r1", product_candidate_id: "c1", product_model_ref: "DS-1", hard_spec_overall: "PASS", checks: [] }],
				decisions: empty ? [] : [{ decision_id: "dec-1", requirement_id: "r1", product_candidate_id: "c1", product_model_ref: "DS-1", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true }],
				report: reportStatus(runId),
			}));
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}/reports`) {
			const failed = {
				...completed,
				status: "FAILED",
				error: "报告生成失败，请重试。",
				download_path: null,
				decision_version: null,
			};
			reportReads += 1;
			const listed =
				mode === "completed" ? [completed]
				: mode === "prior-failed" ? [failed]
				: mode === "generate" && reportReads > 1 ? [completed]
				: [];
			await fulfill(200, { project_id: REPORT_PROJECT, reports: listed });
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${REPORT_PROJECT}/reports`) {
			posts.push(request.postData() ?? "");
			await fulfill(202, { report_id: "report-1", run_id: REPORT_RUN, status: "QUEUED", workflow_id: "cf-hidden" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}/reports/report-1`) {
			polls += 1;
			if (mode === "failed") {
				await fulfill(200, { ...completed, status: "FAILED", error: "没有可写入的决策。", download_path: null, decision_version: null });
				return;
			}
			await fulfill(200, polls < 2 ? { ...completed, status: "RUNNING", download_path: null, decision_version: null } : completed);
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REPORT_PROJECT}/reports/report-1/download`) {
			await route.fulfill({
				status: 200,
				contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				body: Buffer.from("PK fixture-docx"),
			});
			return;
		}
		await fulfill(404, { error: "not_found" });
	}).then(() => posts);
}

export { LONG_PPTX, LONG_TITLE };

export type PipelineScript = "stages" | "reload" | "conflict" | "revision" | "unrecognized" | "unavailable" | "retry" | "failed";

const PIPE_PROJECT = "44444444-4444-4444-8444-444444444444";
const PIPE_RUN = "55555555-5555-4555-8555-555555555555";
const PIPE_ID = "88888888-8888-4888-8888-888888888888";

/**
 * Fixture modelled on the documented §5.2 pipeline shapes and error codes.
 * It is not a live gateway response.
 */
export function installPipeline(page: Page, script: PipelineScript): Promise<Array<{ key: string; revision: unknown }>> {
	const posts: Array<{ key: string; revision: unknown }> = [];
	const state = { created: false, title: "流水线项目", revision: 0, text: "", compiled: false, pipelineReads: 0 };

	const pipelineBody = () => {
		const step = state.pipelineReads;
		state.pipelineReads += 1;
		const finished = script === "failed" || (script === "stages" && step >= 3) || (script !== "stages" && script !== "reload");
		const stage = script === "reload" ? "RESEARCH" : step === 0 ? "RESEARCH" : step === 1 ? "EVALUATING" : step === 2 ? "DECIDING" : "COMPLETED";
		const status = script === "failed" ? "FAILED" : script === "reload" ? "RUNNING" : finished ? "COMPLETED" : "RUNNING";
		const at = "2026-11-02T15:06:58.664Z";
		return {
			pipeline_id: PIPE_ID,
			project_id: PIPE_PROJECT,
			run_id: PIPE_RUN,
			demand_revision: state.revision,
			status,
			stage: script === "failed" ? "RESEARCH" : stage,
			error: script === "failed" ? "container exploded and should stay hidden" : null,
			decision_version: finished ? "version-1" : null,
			report_id: finished ? "report-1" : null,
			report_status: finished ? "COMPLETED" : "NOT_STARTED",
			report_error_code: null,
			download_path: finished ? `/api/projects/${PIPE_PROJECT}/reports/report-1/download` : null,
			candidates_found: 0,
			models_found: 0,
			evidence_found: 0,
			stages: [
				{
					stage: "RESEARCH",
					status: script === "failed" ? "FAILED" : status === "RUNNING" && stage === "RESEARCH" ? "RUNNING" : "COMPLETED",
					started_at: at,
					finished_at: status === "RUNNING" ? null : "2026-11-02T15:17:07.053Z",
					error_code: script === "failed" ? "NO_FETCHED_EVIDENCE" : null,
				},
				{ stage: "EVALUATING", status: stage === "EVALUATING" && status === "RUNNING" ? "RUNNING" : finished ? "COMPLETED" : "QUEUED", started_at: null, finished_at: null, error_code: null },
				{ stage: "DECIDING", status: stage === "DECIDING" && status === "RUNNING" ? "RUNNING" : finished ? "COMPLETED" : "QUEUED", started_at: null, finished_at: null, error_code: null },
			],
			created_at: at,
			updated_at: "2026-11-02T15:22:27.075Z",
		};
	};

	return page.route("**/api/**", async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const fulfill = (status: number, body: unknown) =>
			route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
		const posted = () => {
			const raw = request.postData();
			return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		};
		if (await serveSessionAndPipelines(route, PIPE_PROJECT, [])) return;
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, {
				projects: state.created
					? [{
							id: PIPE_PROJECT,
							title: state.title,
							history_availability: "NOT_PROVIDED",
							demand_revision: state.revision,
							analysis_version: state.revision,
							created_at: "2026-11-02T15:00:00.000Z",
							latest_run: null,
						}]
					: [],
			});
			return;
		}
		if (request.method() === "POST" && path === "/api/projects") {
			state.created = true;
			const body = posted();
			state.title = typeof body.title === "string" && body.title.trim() ? body.title : state.title;
			await fulfill(201, { project_id: PIPE_PROJECT, source_id: null, analysis_version: 0 });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${PIPE_PROJECT}`) {
			await fulfill(200, {
				id: PIPE_PROJECT,
				title: state.title,
				analysis_version: state.revision,
				demand_revision: state.revision,
				history_availability: "NOT_PROVIDED",
				created_at: "2026-11-02T15:00:00.000Z",
				sources: state.text
					? [{
							id: "text-1",
							purpose: "REQUIREMENT",
							source_type: "USER_TEXT",
							revision: state.revision,
							filename: null,
							media_type: "text/plain",
							sha256: "abc",
							created_at: "2026-11-02T15:01:00.000Z",
						}]
					: [],
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${PIPE_PROJECT}/requirement-text`) {
			if (!state.text) {
				await fulfill(404, { error: "not_found" });
				return;
			}
			await fulfill(200, { source_id: "text-1", revision: state.revision, text: state.text });
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${PIPE_PROJECT}/requirement-text`) {
			state.revision += 1;
			const body = posted();
			state.text = typeof body.text === "string" ? body.text : state.text;
			await fulfill(201, { project_id: PIPE_PROJECT, source_id: "text-1", revision: state.revision });
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${PIPE_PROJECT}/requirement-compile`) {
			state.compiled = true;
			await fulfill(202, { project_id: PIPE_PROJECT, status: "QUEUED", compile_id: "compile-1", analysis_version: state.revision });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${PIPE_PROJECT}/requirement-compile/compile-1`) {
			await fulfill(200, {
				compile_id: "compile-1",
				project_id: PIPE_PROJECT,
				status: "COMPLETED",
				analysis_version: state.revision,
				demand_revision: state.revision,
				error: null,
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${PIPE_PROJECT}/requirements`) {
			if (!state.compiled) {
				await fulfill(404, { error: "not_compiled" });
				return;
			}
			await fulfill(200, {
				analysis_version: state.revision,
				compilation: { requirements: [{ requirement_id: "r1", product_name: "工业摄像机" }], issues: [] },
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${PIPE_PROJECT}/runs`) {
			await fulfill(200, { runs: [] });
			return;
		}
		if (request.method() === "POST" && path === `/api/projects/${PIPE_PROJECT}/pipeline`) {
			const key = request.headers()["idempotency-key"] ?? "";
			const body = posted();
			posts.push({ key, revision: body.demand_revision });
			if (script === "conflict" && posts.length === 1) {
				await fulfill(409, { error: "idempotency_conflict" });
				return;
			}
			if (script === "revision") {
				await fulfill(409, { error: "demand_revision_changed" });
				return;
			}
			if (script === "unrecognized") {
				await fulfill(422, { error: "no_recognizable_demand" });
				return;
			}
			if (script === "unavailable") {
				await fulfill(503, { error: "operation_unavailable" });
				return;
			}
			if (script === "retry" && posts.length === 1) {
				await fulfill(503, { error: "workflow_start_failed" });
				return;
			}
			await fulfill(202, {
				pipeline_id: PIPE_ID,
				run_id: PIPE_RUN,
				demand_revision: body.demand_revision,
				status: "QUEUED",
				reused: posts.filter((item) => item.key === key).length > 1,
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${PIPE_PROJECT}/pipeline/${PIPE_ID}`) {
			await fulfill(200, pipelineBody());
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${PIPE_PROJECT}/analysis`) {
			await fulfill(200, analysisPayload({ projectId: PIPE_PROJECT, pipelineId: PIPE_ID, runId: PIPE_RUN, candidates: [], assessments: [], decisions: [] }));
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${PIPE_RUN}`) {
			const finished = script === "stages" ? state.pipelineReads >= 4 : script !== "reload";
			await fulfill(200, {
				id: PIPE_RUN,
				project_id: PIPE_PROJECT,
				status: finished ? (script === "failed" ? "FAILED" : "COMPLETED") : "RUNNING",
				current_stage: finished ? "COMPLETED" : "WEB_RESEARCH",
				artifact_key: null,
				last_error: null,
				created_at: "2026-11-02T15:06:58.664Z",
				updated_at: "2026-11-02T15:22:27.075Z",
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${PIPE_RUN}/events`) {
			await fulfill(200, { events: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${PIPE_RUN}/research`) {
			await fulfill(200, { metrics: { stop_reason_code: null, candidate_count: 0 } });
			return;
		}
		await fulfill(404, { error: "not_found" });
	}).then(() => posts);
}

const LATE_PROJECT = "99999999-9999-4999-8999-999999999999";
const LATE_RUN = "88888888-8888-4888-8888-888888888888";

/**
 * The run row turns terminal before the decision snapshot is written. The
 * analysis answers 409 until the snapshot exists.
 */
export function installLateSnapshot(page: Page, readsBeforeSnapshot = 2): Promise<unknown> {
	let reads = 0;
	const project = {
		id: LATE_PROJECT,
		title: "快照晚到项目",
		history_availability: "NOT_PROVIDED",
		demand_revision: 1,
		analysis_version: 1,
		created_at: "2026-11-04T00:00:00.000Z",
		latest_run: { id: LATE_RUN, status: "COMPLETED", current_stage: "COMPLETED", updated_at: "2026-11-04T00:10:00.000Z" },
	};
	return page.route("**/api/**", async (route: Route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const fulfill = (status: number, body: unknown) =>
			route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
		if (await serveSessionAndPipelines(route, LATE_PROJECT, [
			{ pipeline_id: "pipe-late", run_id: LATE_RUN, demand_revision: 1, status: "RUNNING", stage: "DECIDING", decision_version: null, report_id: null, report_status: "NOT_STARTED", created_at: "2026-11-04T00:00:00.000Z", updated_at: "2026-11-04T00:10:00.000Z" },
		])) return;
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: [project] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${LATE_PROJECT}`) {
			await fulfill(200, { ...project, sources: [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${LATE_PROJECT}/runs`) {
			await fulfill(200, { runs: [{ id: LATE_RUN, status: "COMPLETED", current_stage: "COMPLETED", last_error: null, stop_reason_code: null, artifact_key_present: false, created_at: "2026-11-04T00:00:00.000Z", updated_at: "2026-11-04T00:10:00.000Z" }] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${LATE_PROJECT}/requirement-text`) {
			await fulfill(404, { error: "not_found" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${LATE_PROJECT}/requirements`) {
			await fulfill(404, { error: "not_compiled" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${LATE_PROJECT}/analysis`) {
			reads += 1;
			if (reads <= readsBeforeSnapshot) {
				await fulfill(409, { error: "analysis_version_unavailable" });
				return;
			}
			await fulfill(200, analysisPayload({
				projectId: LATE_PROJECT,
				pipelineId: "pipe-late",
				runId: LATE_RUN,
				requirements: [{ requirement_id: "r1", product_name: "工业摄像机", product_category: null, quantity: 1, quantity_unit: "台", constraints: [] }],
				candidates: [{ candidate_id: "c1", requirement_id: "r1", supplier_name: "海康威视", product_model: "DS-1", evidence_ids: [] }],
				assessments: [{ assessment_id: "a1", requirement_id: "r1", product_candidate_id: "c1", product_model_ref: "DS-1", hard_spec_overall: "PASS", checks: [] }],
				decisions: [{ decision_id: "d1", requirement_id: "r1", product_candidate_id: "c1", product_model_ref: "DS-1", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true }],
			}));
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${LATE_RUN}`) {
			await fulfill(200, { id: LATE_RUN, project_id: LATE_PROJECT, status: "COMPLETED", current_stage: "COMPLETED", artifact_key: null, last_error: null, created_at: "2026-11-04T00:00:00.000Z", updated_at: "2026-11-04T00:10:00.000Z" });
			return;
		}
		if (request.method() === "GET" && path === `/api/runs/${LATE_RUN}/events`) {
			await fulfill(200, { events: [] });
			return;
		}
		await fulfill(404, { error: "not_found" });
	});
}
