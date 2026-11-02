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
		if (request.method() === "GET" && path === `/api/projects/${state.id}/candidates`) {
			await fulfill(200, { candidates: [] });
			return;
		}
		if (request.method() === "GET" && (path === `/api/projects/${state.id}/spec-assessments/status` || path === `/api/projects/${state.id}/decisions/status`)) {
			await fulfill(200, { status: "IDLE", job_id: null, demand_revision: state.demandRevision, error: null, updated_at: null });
			return;
		}
		if (request.method() === "GET" && (path === `/api/projects/${state.id}/spec-assessments` || path === `/api/projects/${state.id}/decisions`)) {
			await fulfill(200, { project_id: state.id, assessments: [], decisions: [] });
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

const REVIEW_PROJECT = "33333333-3333-4333-8333-333333333333";
const REVIEW_RUN = "44444444-4444-4444-8444-444444444444";

export function installReview(page: Page, variant: "mixed" | "none" = "mixed"): Promise<unknown> {
	const requirements = [
		{
			requirement_id: "r1",
			product_name: "工业摄像机",
			constraints: [{ constraint_id: "k-pixel", attribute_definition: "像素" }],
			planned_total_budget: { kind: "PLANNED_BUDGET", value: "100", currency: "CNY", unit: "元/套" },
			public_reference: { kind: "PUBLIC_REFERENCE", value: "128", currency: "CNY", unit: "元/台" },
		},
		{
			requirement_id: "r2",
			product_name: "云台探头",
			constraints: [],
			history_scope: "TABLE_OVERVIEW",
			history_price: { kind: "HISTORICAL_TRANSACTION", value: "77", currency: "CNY" },
		},
	];
	const evidence = {
		evidence_id: "ev_pass",
		source_url: "https://example.com/ds-2cd",
		title: "产品规格页",
		retrieved_at: "2026-10-31T01:16:00.000Z",
		excerpt: "500万像素，防护等级 IP67。",
	};
	const candidates = variant === "none" ? [] : [
		{
			candidate_id: "c-pass",
			requirement_id: "r1",
			stage: "RFQ_SHORTLIST",
			rationale: null,
			open_questions: [],
			first_seen_run_id: REVIEW_RUN,
			last_seen_run_id: REVIEW_RUN,
			updated_at: "2026-10-31T02:00:00.000Z",
			supplier: { supplier_id: "s-pass", display_name: "海康威视", website_domain: "hikvision.com", identity_status: "OBSERVED", role: "MANUFACTURER" },
			product: { product_id: "p-pass", product_name: "网络摄像机", brand: "海康威视", model: "DS-2CD2347G2-LU", product_category: "摄像机" },
			evidence: [evidence],
		},
		{
			candidate_id: "c-unknown",
			requirement_id: "r1",
			stage: "DISCOVERED_LONG_LIST",
			rationale: null,
			open_questions: [],
			first_seen_run_id: REVIEW_RUN,
			last_seen_run_id: REVIEW_RUN,
			updated_at: "2026-10-31T02:01:00.000Z",
			supplier: { supplier_id: "s-unknown", display_name: "华北区域工业视觉设备联合体（含多园区超长供应商名称不应撑破表格）", website_domain: null, identity_status: "OBSERVED", role: "DISTRIBUTOR" },
			product: { product_id: "p-unknown", product_name: "网络摄像机", brand: null, model: "DH-IPC-HFW5442", product_category: "摄像机" },
			evidence: [],
		},
		{
			candidate_id: "c-fail",
			requirement_id: "r1",
			stage: "EXCLUDED",
			rationale: null,
			open_questions: [],
			first_seen_run_id: REVIEW_RUN,
			last_seen_run_id: REVIEW_RUN,
			updated_at: "2026-10-31T02:02:00.000Z",
			supplier: { supplier_id: "s-fail", display_name: "宇视科技", website_domain: null, identity_status: "OBSERVED", role: "MANUFACTURER" },
			product: { product_id: "p-fail", product_name: "网络摄像机", brand: "宇视", model: "IPC-B312", product_category: "摄像机" },
			evidence: [],
		},
		{
			candidate_id: "c-verify",
			requirement_id: "r1",
			stage: "NEEDS_VERIFICATION",
			rationale: null,
			open_questions: [],
			first_seen_run_id: REVIEW_RUN,
			last_seen_run_id: REVIEW_RUN,
			updated_at: "2026-10-31T02:03:00.000Z",
			supplier: { supplier_id: "s-verify", display_name: "大华股份", website_domain: null, identity_status: "OBSERVED", role: "MANUFACTURER" },
			product: { product_id: "p-verify", product_name: "网络摄像机", brand: "大华", model: "DH-SD-VERIFY", product_category: "摄像机" },
			evidence: [],
		},
		{
			candidate_id: "c-overview",
			requirement_id: "r2",
			stage: "DISCOVERED_LONG_LIST",
			rationale: null,
			open_questions: [],
			first_seen_run_id: REVIEW_RUN,
			last_seen_run_id: REVIEW_RUN,
			updated_at: "2026-10-31T02:04:00.000Z",
			supplier: { supplier_id: "s-overview", display_name: "目录中的供应商", website_domain: null, identity_status: "OBSERVED", role: "DISTRIBUTOR" },
			product: { product_id: "p-overview", product_name: "云台探头", brand: null, model: "PTZ-OVERVIEW", product_category: "摄像机" },
			evidence: [],
		},
	];
	const check = (status: string, explanation: string) => ({
		constraint_id: "k-pixel",
		requirement_id: "r1",
		status,
		reason_code: status === "PASS" ? "VERIFIED_COMPARISON" : status === "FAIL" ? "VERIFIED_COMPARISON" : "MISSING_CLAIM",
		operation: "actual >= required",
		normalized_actual: status === "UNKNOWN" ? null : status === "FAIL" ? "2" : "5",
		normalized_required: "4",
		unit: "MP",
		evidence_ids: ["ev_pass"],
		explanation,
		importance: "HARD",
	});
	const assessment = (id: string, candidateId: string, overall: string, explanation: string, requirementId = "r1") => ({
		assessment_id: id,
		requirement_id: requirementId,
		product_candidate_id: candidateId,
		product_model_ref: null,
		demand_revision: 1,
		hard_spec_overall: overall,
		overall_reason_codes: [],
		hard_constraint_count: 1,
		calculator_version: "0.1.0",
		dsl_schema_version: "1.0",
		assessment: { checks: [check(overall, explanation)] },
		evidence_ids: ["ev_pass"],
		evaluated_at: "2026-10-31T03:00:00.000Z",
		created_at: "2026-10-31T03:00:00.000Z",
	});
	const decision = (id: string, candidateId: string, recommendation: string, verdict: string, overall: string, accepted: boolean) => ({
		decision_id: id,
		requirement_id: "r1",
		product_candidate_id: candidateId,
		product_model_ref: null,
		recommendation,
		technical_verdict: verdict,
		hard_spec_overall: overall,
		accepted,
		priority_rank: null,
		rationale: "依据已核对的技术结论留下这条记录。",
		evidence_ids: ["ev_pass"],
		gaps: [],
		next_actions: [],
		violations: [],
		decided_at: "2026-10-31T04:00:00.000Z",
		created_at: "2026-10-31T04:00:00.000Z",
	});
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
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: [project] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}`) {
			await fulfill(200, { ...project, sources: [] });
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
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/candidates`) {
			await fulfill(200, { candidates: url.searchParams.get("run_id") === REVIEW_RUN ? candidates : [] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/spec-assessments/status`) {
			await fulfill(200, { status: variant === "none" ? "IDLE" : "COMPLETED", job_id: variant === "none" ? null : "job-spec", demand_revision: 1, error: null, detail: { assessments: 4 } });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/decisions/status`) {
			await fulfill(200, { status: variant === "none" ? "IDLE" : "COMPLETED", job_id: variant === "none" ? null : "job-decision", demand_revision: 1, error: null, detail: { decisions: 3 } });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/spec-assessments`) {
			await fulfill(200, {
				project_id: REVIEW_PROJECT,
				assessments: variant === "none" ? [] : [
					assessment("spc-pass", "c-pass", "PASS", "页面写明 500万像素，满足不低于 4MP。"),
					assessment("spc-unknown", "c-unknown", "UNKNOWN", "没有读到像素。"),
					assessment("spc-fail", "c-fail", "FAIL", "读到的像素低于要求。"),
					assessment("spc-verify", "c-verify", "UNKNOWN", "防护等级还不能从页面确认。"),
					assessment("spc-overview", "c-overview", "UNKNOWN", "没有对应的规格。", "r2"),
				],
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${REVIEW_PROJECT}/decisions`) {
			await fulfill(200, {
				project_id: REVIEW_PROJECT,
				decisions: variant === "none" ? [] : [
					decision("dec-pass", "c-pass", "SHORTLIST", "VERIFIED_PASS", "PASS", true),
					decision("dec-unknown", "c-unknown", "SHORTLIST", "VERIFIED_PASS", "PASS", false),
					decision("dec-fail", "c-fail", "EXCLUDE", "VERIFIED_FAIL", "FAIL", true),
					decision("dec-verify", "c-verify", "INVESTIGATE", "UNVERIFIED", "UNKNOWN", true),
				],
			});
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
					source_url: evidence.source_url,
					normalized_url: evidence.source_url,
					title: evidence.title,
					publisher: "example",
					retrieved_at: evidence.retrieved_at,
					locator: null,
					excerpt: evidence.excerpt,
					content_sha256: "abc",
					content_date_hints_json: "[]",
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

const KNOWN_PROJECT = "a54edd18-0000-4000-8000-000000000001";
const KNOWN_RUN = "a54edd18-0000-4000-8000-000000000002";

export function installKnownCase(page: Page): Promise<unknown> {
	const longSupplier = "华北区域工业视觉设备联合体（含多园区超长供应商名称不应撑破表格）";
	const nbn = (index: number) => ({
		candidate_id: `c-nbn-${index}`,
		requirement_id: "r1",
		stage: "RFQ_SHORTLIST",
		rationale: null,
		open_questions: [],
		first_seen_run_id: KNOWN_RUN,
		last_seen_run_id: KNOWN_RUN,
		updated_at: "2026-11-01T12:00:00.000Z",
		supplier: { supplier_id: "s-nbn", display_name: "宁波某供应商", website_domain: null, identity_status: "OBSERVED", role: "DISTRIBUTOR" },
		product: { product_id: "p-nbn", product_name: "网络摄像机", brand: null, model: "NBN-80052-BA", product_category: "摄像机" },
		evidence: [{ evidence_id: "ev_nbn", source_url: "https://example.com/nbn", title: "NBN 规格页", retrieved_at: "2026-11-01T08:00:00.000Z", excerpt: "像素不低于 5MP。" }],
	});
	const candidates = [
		nbn(1),
		nbn(2),
		nbn(3),
		nbn(4),
		{
			candidate_id: "c-ips",
			requirement_id: "r1",
			stage: "EXCLUDED",
			rationale: null,
			open_questions: [],
			first_seen_run_id: KNOWN_RUN,
			last_seen_run_id: KNOWN_RUN,
			updated_at: "2026-11-01T12:01:00.000Z",
			supplier: { supplier_id: "s-ips", display_name: longSupplier, website_domain: null, identity_status: "OBSERVED", role: "MANUFACTURER" },
			product: { product_id: "p-ips", product_name: "网络摄像机", brand: null, model: "IPS05-R10-OIA4-EXTRA-LONG-MODEL-TOKEN", product_category: "摄像机" },
			evidence: [{ evidence_id: "ev_ips", source_url: "https://example.com/ips", title: "IPS 规格页", retrieved_at: "2026-11-01T08:05:00.000Z", excerpt: "分辨率约 4.9MP。" }],
		},
		{
			candidate_id: "c-repeat",
			requirement_id: "r1",
			stage: "EXCLUDED",
			rationale: null,
			open_questions: [],
			first_seen_run_id: KNOWN_RUN,
			last_seen_run_id: KNOWN_RUN,
			updated_at: "2026-11-01T12:02:00.000Z",
			supplier: { supplier_id: "s-nbn", display_name: "宁波某供应商", website_domain: null, identity_status: "OBSERVED", role: "DISTRIBUTOR" },
			product: { product_id: "p-nbn", product_name: "网络摄像机", brand: null, model: "NBN-80052-BA", product_category: "摄像机" },
			evidence: [{ evidence_id: "ev_nbn", source_url: "https://example.com/nbn", title: "NBN 规格页", retrieved_at: "2026-11-01T08:00:00.000Z", excerpt: "像素不低于 5MP。" }],
		},
	];
	const passCheck = {
		constraint_id: "k-pixel",
		requirement_id: "r1",
		status: "PASS",
		reason_code: "VERIFIED_COMPARISON",
		operation: "5 MP GTE 5 MP",
		normalized_actual: "5",
		normalized_required: "5",
		unit: "MP",
		evidence_ids: ["ev_nbn"],
		explanation: "output_resolution is 5 MP and the requirement asks GTE 5 MP: PASS",
		importance: "HARD",
	};
	const failCheck = {
		constraint_id: "k-pixel",
		requirement_id: "r1",
		status: "FAIL",
		reason_code: "VERIFIED_COMPARISON",
		operation: "4.9152 MP GTE 5 MP",
		normalized_actual: "4.9152",
		normalized_required: "5",
		unit: "MP",
		evidence_ids: ["ev_ips"],
		explanation: "output_resolution is 4.9152 MP and the requirement asks GTE 5 MP: FAIL",
		importance: "HARD",
	};
	const assessment = (id: string, candidateId: string, overall: string, check: unknown) => ({
		assessment_id: id,
		requirement_id: "r1",
		product_candidate_id: candidateId,
		demand_revision: 1,
		hard_spec_overall: overall,
		overall_reason_codes: ["VERIFIED_COMPARISON"],
		hard_constraint_count: 1,
		calculator_version: "0.1.0",
		dsl_schema_version: "1.0",
		assessment: { checks: [check], source_refs: ["workspaces/default/projects/secret/demand.pptx"] },
		evidence_ids: overall === "FAIL" ? ["ev_ips"] : ["ev_nbn"],
		evaluated_at: "2026-11-01T13:00:00.000Z",
		created_at: "2026-11-01T13:00:00.000Z",
	});
	const decision = (id: string, candidateId: string, recommendation: string, verdict: string, overall: string, rationale: string) => ({
		decision_id: id,
		requirement_id: "r1",
		product_candidate_id: candidateId,
		recommendation,
		technical_verdict: verdict,
		hard_spec_overall: overall,
		accepted: true,
		rationale,
		evidence_ids: ["ev_nbn"],
		gaps: [],
		next_actions: [],
		violations: [],
		decided_at: "2026-11-01T14:00:00.000Z",
		created_at: "2026-11-01T14:00:00.000Z",
	});
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
		if (request.method() === "GET" && path === "/api/projects") {
			await fulfill(200, { projects: [project] });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}`) {
			await fulfill(200, { ...project, sources: [] });
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
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/candidates`) {
			await fulfill(200, { candidates });
			return;
		}
		if (request.method() === "GET" && (path.endsWith("/spec-assessments/status") || path.endsWith("/decisions/status"))) {
			await fulfill(200, { status: "COMPLETED", job_id: "job-1", demand_revision: 1, error: null, updated_at: "2026-11-01T14:00:00.000Z" });
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/spec-assessments`) {
			await fulfill(200, {
				project_id: KNOWN_PROJECT,
				assessments: [
					assessment("spc-nbn-1", "c-nbn-1", "PASS", passCheck),
					assessment("spc-nbn-2", "c-nbn-2", "PASS", passCheck),
					assessment("spc-nbn-3", "c-nbn-3", "PASS", passCheck),
					assessment("spc-nbn-4", "c-nbn-4", "PASS", passCheck),
					assessment("spc-ips", "c-ips", "FAIL", failCheck),
					assessment("spc-repeat", "c-repeat", "PASS", passCheck),
				],
			});
			return;
		}
		if (request.method() === "GET" && path === `/api/projects/${KNOWN_PROJECT}/decisions`) {
			await fulfill(200, {
				project_id: KNOWN_PROJECT,
				decisions: [
					decision("dec-nbn-1", "c-nbn-1", "SHORTLIST", "VERIFIED_PASS", "PASS", "可以先询价。引用 pptx_1:r1 与 ev_abc123。"),
					decision("dec-nbn-2", "c-nbn-2", "SHORTLIST", "VERIFIED_PASS", "PASS", "可以先询价。"),
					decision("dec-nbn-3", "c-nbn-3", "SHORTLIST", "VERIFIED_PASS", "PASS", "可以先询价。"),
					decision("dec-nbn-4", "c-nbn-4", "SHORTLIST", "VERIFIED_PASS", "PASS", "可以先询价。"),
					decision("dec-ips", "c-ips", "EXCLUDE", "VERIFIED_FAIL", "FAIL", "像素不够。依据 pptx_1:c1 与 clm_deadbeef。"),
					decision("dec-repeat", "c-repeat", "EXCLUDE", "VERIFIED_PASS", "PASS", "与已列出的同型号重复，不再单独询价。"),
				],
			});
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

export { LONG_PPTX, LONG_TITLE };
