import { describe, expect, it } from "vitest";
import type { Candidate, SpecAssessment, SourcingDecision } from "../api/types";
import { buildCandidateRows, cleanRationale, jobIsStalled, presentFormula, priceRows, procurementLine, reasonText, stageView, technicalView } from "./candidates";

function candidate(patch: Partial<Candidate> & Pick<Candidate, "candidate_id" | "stage">): Candidate {
	return {
		requirement_id: "r1",
		last_seen_run_id: "run-1",
		updated_at: "2026-11-01T00:00:00.000Z",
		supplier_name: "供应商",
		model: "型号A",
		evidence: [],
		...patch,
	};
}

function assessment(patch: Partial<SpecAssessment> & Pick<SpecAssessment, "hard_spec_overall">): SpecAssessment {
	return {
		assessment_id: "spc-1",
		requirement_id: "r1",
		product_candidate_id: "c1",
		demand_revision: 1,
		evidence_ids: [],
		evaluated_at: "2026-11-01T00:00:00.000Z",
		created_at: "2026-11-01T00:00:00.000Z",
		checks: [],
		...patch,
	};
}

function decision(patch: Partial<SourcingDecision>): SourcingDecision {
	return {
		decision_id: "dec-1",
		requirement_id: "r1",
		product_candidate_id: "c1",
		recommendation: null,
		technical_verdict: null,
		hard_spec_overall: null,
		accepted: false,
		rationale: null,
		evidence_ids: [],
		decided_at: "2026-11-01T00:00:00.000Z",
		created_at: "2026-11-01T00:00:00.000Z",
		...patch,
	};
}

describe("candidate view", () => {
	it("maps stages without calling a long list a recommendation", () => {
		expect(stageView("DISCOVERED_LONG_LIST").label).toBe("长名单");
		expect(stageView("NEEDS_VERIFICATION").label).toBe("待补证");
		expect(stageView("RFQ_SHORTLIST").label).toBe("建议先询价");
		expect(stageView("EXCLUDED").label).toBe("已排除");
		expect(stageView("SOMETHING_ELSE").label).toBe("阶段未标明");
		expect(stageView("DISCOVERED_LONG_LIST").label).not.toContain("推荐");
	});

	it("keeps UNKNOWN distinct from pass and fail", () => {
		expect(technicalView("PASS")).toEqual({ label: "满足", tone: "pass" });
		expect(technicalView("FAIL")).toEqual({ label: "不满足", tone: "fail" });
		expect(technicalView("UNKNOWN")).toEqual({ label: "还不能判断", tone: "unknown" });
		expect(technicalView(null)).toEqual({ label: "还没有核对", tone: "none" });
	});

	it("does not turn an unaccepted shortlist into 建议先询价", () => {
		const [row] = buildCandidateRows({
			candidates: [candidate({ candidate_id: "c1", stage: "DISCOVERED_LONG_LIST" })],
			assessments: [assessment({ hard_spec_overall: "PASS" })],
			decisions: [decision({ recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", accepted: false })],
			requirements: null,
		});
		expect(row.stage.label).toBe("长名单");
		expect(row.technical.label).toBe("满足");
		expect(JSON.stringify(row)).not.toContain("建议先询价");
	});

	it("does not treat accepted as technically qualified", () => {
		const [row] = buildCandidateRows({
			candidates: [candidate({ candidate_id: "c1", stage: "EXCLUDED" })],
			assessments: [assessment({ hard_spec_overall: "FAIL" })],
			decisions: [decision({ recommendation: "EXCLUDE", technical_verdict: "VERIFIED_FAIL", accepted: true, hard_spec_overall: "FAIL" })],
			requirements: null,
		});
		expect(row.technical.label).toBe("不满足");
		expect(row.stage.label).toBe("已排除");
		expect(JSON.stringify(row)).not.toContain("合格");
	});

	it("joins on requirement and candidate ids and keeps the latest revision", () => {
		const [row] = buildCandidateRows({
			candidates: [candidate({ candidate_id: "c1", stage: "NEEDS_VERIFICATION" })],
			assessments: [
				assessment({ assessment_id: "old", hard_spec_overall: "PASS", demand_revision: 1 }),
				assessment({
					assessment_id: "new",
					hard_spec_overall: "UNKNOWN",
					demand_revision: 2,
					checks: [
						{
							constraint_id: "k1",
							requirement_id: "r1",
							status: "UNKNOWN",
							reason_code: "MISSING_CLAIM",
							operation: "compare",
							normalized_actual: null,
							normalized_required: "IP66",
							unit: null,
							evidence_ids: ["ev_1"],
							explanation: "没有读到防护等级。",
							importance: "HARD",
						},
					],
				}),
			],
			decisions: [],
			requirements: {
				analysis_version: 2,
				compilation: {
					requirements: [
						{
							requirement_id: "r1",
							product_name: "摄像机",
							constraints: [{ constraint_id: "k1", attribute_definition: "防护等级" }],
							planned_total_budget: { kind: "PLANNED_BUDGET", value: "200000", currency: "CNY", unit: "元" },
						},
					],
				},
			},
		});
		expect(row.technical.label).toBe("还不能判断");
		expect(row.checks[0]).toMatchObject({ requirement: "防护等级", result: { label: "还不能判断" }, reason: "没有读到这项" });
		expect(row.checks[0].observed + row.checks[0].reason).not.toContain("没有读到防护等级");
		expect(row.checks[0].evidence[0]?.title).toBe("来源");
		expect(row.prices.map((price) => price.label)).toEqual(["计划预算", "历史成交价", "公网参考价", "正式报价"]);
		expect(row.prices[0].text).toContain("200000");
		expect(row.prices[1].text).toBe("还没有");
	});

	it("keeps price bases apart and refuses overview wording", () => {
		const rows = priceRows({
			history_scope: "TABLE_OVERVIEW",
			history_price: { kind: "HISTORICAL_TRANSACTION", value: "77", currency: "CNY" },
			public_reference: { kind: "PUBLIC_REFERENCE", value: "128", currency: "CNY", unit: "元/台" },
			formal_quotation: null,
			planned_total_budget: null,
		});
		expect(rows.map((row) => row.text).join(" ")).not.toMatch(/历史价|节支/);
		expect(rows[1].text).toContain("导入目录");
		expect(rows[1].text).not.toContain("77");
		expect(rows[2].text).toContain("网页标价");
		expect(rows[2].text).toContain("不是正式报价");
		expect(rows[3].text).toBe("还没有");
		const item = priceRows({
			history_scope: "ITEM",
			history_price: { kind: "HISTORICAL_TRANSACTION", value: "350", currency: "CNY", unit: "元/套" },
		});
		expect(item[1].text).toContain("350");
		expect(item[1].text).toContain("这一项");
		expect(item[1].text).not.toMatch(/节支/);
	});

	it("shows the unit price when the analysis has no total budget", () => {
		const rows = priceRows({
			planned_total_budget: null,
			planned_unit_price: { kind: "PLANNED_PRICE", value: "100", currency: "CNY", unit: "元/套" },
		});
		expect(rows[0]).toEqual({ label: "计划单价", text: "100 CNY 元/套" });
	});

	it("builds a check from structured fields and hides raw ids", () => {
		expect(presentFormula("4.9152 MP GTE 5 MP")).toBe("4.9152 MP ≥ 5 MP");
		expect(presentFormula("actual >= required")).toBeNull();
		expect(reasonText("VERIFIED_COMPARISON")).toBe("已按要求核对");
		expect(reasonText("SUPERVISOR_RESEARCHER_ERROR")).toBe("");
		expect(cleanRationale("像素不够。依据 pptx_1:c1 与 clm_deadbeef。")).toBe("像素不够。");
		expect(cleanRationale("ev_abc123")).toBeNull();
		const [row] = buildCandidateRows({
			candidates: [
				candidate({
					candidate_id: "c1",
					stage: "EXCLUDED",
					evidence: [{ evidence_id: "ev_ips", source_url: "https://example.com/a", title: "IPS 规格页", retrieved_at: null, excerpt: "摘录" }],
				}),
			],
			assessments: [
				assessment({
					hard_spec_overall: "FAIL",
					checks: [
						{
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
						},
					],
				}),
			],
			decisions: [decision({ recommendation: "EXCLUDE", technical_verdict: "VERIFIED_FAIL", rationale: "像素不够。依据 pptx_1:r1 与 ev_ips。" })],
			requirements: {
				analysis_version: 1,
				compilation: {
					requirements: [{
						requirement_id: "r1",
						product_name: "摄像机",
						constraints: [{ constraint_id: "k-pixel", attribute_definition: "像素", operator: "GTE" }],
						planned_total_budget: null,
						planned_unit_price: { kind: "PLANNED_PRICE", value: "100", currency: "CNY", unit: "元/套" },
					}],
				},
			},
		});
		expect(row.checks[0].observed).toBe("要求 ≥ 5 MP，读到 4.9152 MP");
		expect(row.checks[0].reason).toBe("已按要求核对");
		expect(row.checks[0].formula).toBe("4.9152 MP ≥ 5 MP");
		expect(row.checks[0].evidence).toEqual([{ id: "ev_ips", title: "IPS 规格页" }]);
		expect(row.rationale).toBe("像素不够。");
		expect(`${row.checks[0].observed} ${row.checks[0].reason} ${row.checks[0].formula} ${row.checks[0].evidence[0]?.title}`).not.toMatch(/output_resolution|GTE|ev_ips/);
		expect(row.prices[0].label).toBe("计划单价");
	});

	it("groups identical listings and keeps a long list until decisions exist", () => {
		const rows = buildCandidateRows({
			candidates: [1, 2, 3].map((index) => candidate({ candidate_id: `c${index}`, stage: "RFQ_SHORTLIST", supplier_name: "宁波", model: "NBN-80052-BA" })),
			assessments: [1, 2, 3].map((index) => assessment({ assessment_id: `a${index}`, product_candidate_id: `c${index}`, hard_spec_overall: "PASS" })),
			decisions: [],
			requirements: null,
			decisionsReady: false,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].groupCount).toBe(3);
		expect(rows[0].stage.label).toBe("长名单");
		expect(JSON.stringify(rows)).not.toContain("建议先询价");
	});

	it("reads one procurement line from job status without inventing a later stage", () => {
		const idle = { status: "IDLE", job_id: null, demand_revision: 1, error: null, updated_at: null };
		expect(procurementLine({ runStatus: "COMPLETED", spec: idle, decision: idle, hasAssessments: false, hasDecisions: false })).toMatchObject({
			line: "",
			decisionsReady: false,
			listNote: "还没有核验和决策，以下只是长名单。",
		});
		expect(procurementLine({ runStatus: "RUNNING", spec: idle, decision: idle, hasAssessments: false, hasDecisions: false }).line).toBe("正在寻找供应商");
		expect(
			procurementLine({
				runStatus: "COMPLETED",
				spec: { ...idle, status: "COMPLETED" },
				decision: { ...idle, status: "COMPLETED" },
				hasAssessments: true,
				hasDecisions: true,
			}).line,
		).toBe("已完成");
		const stuck = { ...idle, status: "QUEUED", updated_at: "2026-11-01T16:55:00.000Z" };
		expect(jobIsStalled(stuck, Date.parse("2026-11-02T07:00:00.000Z"))).toBe(true);
		expect(procurementLine({ runStatus: "COMPLETED", spec: idle, decision: stuck, hasAssessments: true, hasDecisions: false }).line).toBe("需要处理");
	});
});
