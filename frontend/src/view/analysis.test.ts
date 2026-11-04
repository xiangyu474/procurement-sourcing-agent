import { describe, expect, it } from "vitest";
import type { Analysis, AnalysisAssessment, AnalysisCandidate, AnalysisDecision, AnalysisEvidence } from "../api/types";
import {
	analysisSummaryLine,
	buildAnalysisRows,
	decisionStage,
	isRecommendedInquiry,
	priceRows,
	recommendationText,
	untranslatedNote,
} from "./analysis";

function candidate(patch: Partial<AnalysisCandidate> & Pick<AnalysisCandidate, "candidate_id">): AnalysisCandidate {
	return {
		requirement_id: "r1",
		supplier_id: `s-${patch.candidate_id}`,
		product_id: "p1",
		supplier_name: "供应商",
		product_model: "型号A",
		product_name: "摄像机",
		stage: "DISCOVERED_LONG_LIST",
		evidence_ids: [],
		...patch,
	};
}

function assessment(patch: Partial<AnalysisAssessment> & Pick<AnalysisAssessment, "hard_spec_overall">): AnalysisAssessment {
	return {
		assessment_id: "spc-1",
		requirement_id: "r1",
		product_candidate_id: "c1",
		product_model_ref: "型号A",
		overall_reason_codes: [],
		hard_constraint_count: null,
		unresolved_question_ids: [],
		evaluated_at: "2026-11-01T00:00:00.000Z",
		checks: [],
		...patch,
	};
}

function decision(patch: Partial<AnalysisDecision> & Pick<AnalysisDecision, "decision_id">): AnalysisDecision {
	return {
		requirement_id: "r1",
		product_candidate_id: "c1",
		product_model_ref: "型号A",
		recommendation: null,
		technical_verdict: null,
		hard_spec_overall: null,
		accepted: false,
		rationale: "the model did not confirm the pixel count",
		evidence_ids: [],
		decided_at: "2026-11-01T00:00:00.000Z",
		display: null,
		...patch,
	};
}

function analysis(patch: Partial<Analysis> = {}): Analysis {
	return {
		project_id: "p",
		pipeline_id: "pipe-1",
		run_id: "run-1",
		demand_revision: 1,
		research_status: "COMPLETED",
		decision_version: "v1",
		requirements: [
			{
				requirement_id: "r1",
				product_name: "摄像机",
				product_category: null,
				quantity: 10,
				quantity_unit: "台",
				constraints: [{ constraint_id: "k1", attribute_key: "ip", attribute_definition: "防护等级", operator: "GTE", value: "IP66", unit: null, importance: "HARD", source_quote: null }],
			},
		],
		candidates: [],
		assessments: [],
		decisions: [],
		price_contexts: [],
		evidence: [],
		summary: {
			requirements: 1,
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
		report: { report_id: null, status: "NOT_STARTED", error_code: null, decision_version: null, download_path: null, warning_codes: [] },
		...patch,
	};
}

const EVIDENCE: AnalysisEvidence[] = [
	{ evidence_id: "ev_1", title: "规格页", url: "https://example.com/a", content_sha256: null, quote: "像素 4.9152 MP", quote_status: "ORIGINAL" },
];

describe("analysis view", () => {
	it("calls a short list a long list until a verified recommendation exists", () => {
		expect(decisionStage(null).label).toBe("长名单");
		expect(decisionStage(decision({ decision_id: "d1", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: false })).label).toBe("长名单");
		expect(decisionStage(decision({ decision_id: "d2", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true })).label).toBe("建议询价");
		expect(decisionStage(decision({ decision_id: "d3", recommendation: "INVESTIGATE" })).label).toBe("待补证");
		expect(decisionStage(decision({ decision_id: "d4", recommendation: "EXCLUDE" })).label).toBe("已排除");
		expect(JSON.stringify(decisionStage(null))).not.toContain("推荐");
	});

	it("needs the gate, the shortlist, the technical pass and the hard pass", () => {
		const full = decision({ decision_id: "d", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true });
		expect(isRecommendedInquiry(full)).toBe(true);
		expect(isRecommendedInquiry({ ...full, accepted: false })).toBe(false);
		expect(isRecommendedInquiry({ ...full, recommendation: "INVESTIGATE" })).toBe(false);
		expect(isRecommendedInquiry({ ...full, technical_verdict: "UNVERIFIED" })).toBe(false);
		expect(isRecommendedInquiry({ ...full, hard_spec_overall: "UNKNOWN" })).toBe(false);
		expect(isRecommendedInquiry(null)).toBe(false);
	});

	it("groups one model with its suppliers instead of flat supplier rows", () => {
		const rows = buildAnalysisRows(
			analysis({
				candidates: [
					candidate({ candidate_id: "c1", supplier_name: "甲公司" }),
					candidate({ candidate_id: "c2", supplier_name: "乙公司" }),
					candidate({ candidate_id: "c3", supplier_name: "丙公司", product_model: "型号B" }),
				],
				assessments: [
					assessment({ assessment_id: "a1", product_candidate_id: "c1", hard_spec_overall: "PASS" }),
					assessment({ assessment_id: "a2", product_candidate_id: "c2", hard_spec_overall: "PASS" }),
					assessment({ assessment_id: "a3", product_candidate_id: "c3", product_model_ref: "型号B", hard_spec_overall: "UNKNOWN" }),
				],
				decisions: [
					decision({ decision_id: "d1", product_candidate_id: "c1", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true }),
					decision({ decision_id: "d2", product_candidate_id: "c2", recommendation: "SHORTLIST", technical_verdict: "VERIFIED_PASS", hard_spec_overall: "PASS", accepted: true }),
					decision({ decision_id: "d3", product_candidate_id: "c3", product_model_ref: "型号B", recommendation: "INVESTIGATE", hard_spec_overall: "UNKNOWN", accepted: true }),
				],
				evidence: EVIDENCE,
			}),
		);
		expect(rows).toHaveLength(2);
		const first = rows.find((row) => row.model === "型号A");
		expect(first?.groupCount).toBe(2);
		expect(first?.supplierCount).toBe(2);
		expect(first?.supplier).toBe("2 家供应商");
		expect(first?.technical.label).toBe("满足");
		expect(first?.stage.label).toBe("建议询价");
		expect(first?.members.map((member) => member.supplier)).toEqual(["乙公司", "甲公司"].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")));
		const second = rows.find((row) => row.model === "型号B");
		expect(second?.technical.label).toBe("还不能判断");
		expect(second?.stage.label).toBe("待补证");
		expect(second?.supplier).toBe("丙公司");
	});

	it("shows the Chinese decision summary and says that the original text is not translated", () => {
		const [row] = buildAnalysisRows(
			analysis({
				candidates: [candidate({ candidate_id: "c1" })],
				assessments: [assessment({ assessment_id: "a1", hard_spec_overall: "UNKNOWN" })],
				decisions: [
					decision({
						decision_id: "d1",
						recommendation: "INVESTIGATE",
						hard_spec_overall: "UNKNOWN",
						accepted: true,
						display: {
							version: "decision-display-v1",
							basis: "STRUCTURED_ASSESSMENT_NOT_TRANSLATION",
							summary_code: "EVIDENCE_INSUFFICIENT",
							summary_zh: "现有证据不足以判断是否符合全部硬性条件，建议补充核验。",
							gaps: [{ code: "MISSING_CLAIM", constraint_id: "k1", importance: "HARD", evidence_ids: [], text_zh: "尚未找到支持该项指标的可用资料。" }],
							next_actions: [{ code: "MISSING_CLAIM", constraint_id: "k1", text_zh: "补充该型号的对应技术资料并核验来源。" }],
							unresolved_question_ids: [],
							untranslated_originals: { rationale: true, gap_count: 5, next_action_count: 3 },
						},
					}),
				],
			}),
		);
		expect(row.summary).toBe("现有证据不足以判断是否符合全部硬性条件，建议补充核验。");
		expect(row.decision?.gaps[0].text).toBe("尚未找到支持该项指标的可用资料。");
		expect(row.decision?.nextActions[0].text).toBe("补充该型号的对应技术资料并核验来源。");
		expect(untranslatedNote(row.decision)).toContain("还有原始信息待核对");
		expect(JSON.stringify(row)).not.toContain("the model did not confirm");
	});

	it("keeps the price bases apart and refuses the overview wording", () => {
		const rows = priceRows({
			requirement_id: "r1",
			product_name: "摄像机",
			budget: "200000",
			budget_currency: "CNY",
			budget_unit: "元",
			history_scope: "TABLE_OVERVIEW",
			history_scope_note: "…",
			history_available: false,
			history_rows: 0,
			statistics: null,
			overview_statistics: { count: 1000, minimum: "77", maximum: "1255" },
			overview_is_not_a_baseline: true,
			findings: [
				{ lowest_basis: "PUBLIC_REFERENCE", lowest_value: "128", saving: null, saving_percent: null, comparability: "COMPARABLE", explanation: null, lowest_observation_id: null },
			],
			notes: [],
		});
		expect(rows.map((row) => row.label)).toEqual(["计划预算", "历史成交价", "公网参考价", "正式报价"]);
		expect(rows.map((row) => row.text).join(" ")).not.toMatch(/历史价|节支/);
		expect(rows[0].text).toBe("200000 CNY 元");
		expect(rows[1].text).toContain("导入目录");
		expect(rows[1].text).not.toContain("77");
		expect(rows[2].text).toContain("网页标价");
		expect(rows[3].text).toBe("还没有");
	});

	it("shows the item history and the saving only on a usable baseline", () => {
		const rows = priceRows({
			requirement_id: "r1",
			product_name: "摄像机",
			budget: "200000",
			budget_currency: "CNY",
			budget_unit: "元",
			history_scope: "ITEM",
			history_scope_note: null,
			history_available: true,
			history_rows: 12,
			statistics: { count: 12, currency: "CNY", unit: "元/套" },
			overview_statistics: null,
			overview_is_not_a_baseline: false,
			findings: [
				{ lowest_basis: "HISTORICAL_TRANSACTION", lowest_value: "350", saving: "40", saving_percent: "26", comparability: "COMPARABLE", explanation: null, lowest_observation_id: null },
			],
			notes: [],
		});
		expect(rows[1].text).toContain("350");
		expect(rows[1].text).toContain("这一项");
		expect(rows[1].text).toContain("40");
		expect(rows[1].text).not.toMatch(/历史价/);
	});

	it("reads the published counts", () => {
		const line = analysisSummaryLine({
			requirements: 1,
			candidate_rows: 23,
			distinct_models: 3,
			distinct_suppliers: 23,
			models: [],
			assessments: 23,
			by_verdict: { PASS: 22, UNKNOWN: 1 },
			decisions: 23,
			by_recommendation: { SHORTLIST: 22, INVESTIGATE: 1 },
			evidence: 29,
			coverage_warnings: [],
		}, 3);
		expect(line).toContain("3 个型号");
		expect(line).toContain("23 家供应来源");
		expect(line).toContain("满足 22");
		expect(line).toContain("还不能判断 1");
		expect(line).toContain("29 份证据");
		expect(recommendationText({ SHORTLIST: 22, INVESTIGATE: 1 })).toBe("建议询价 22 · 待补证 1");
	});
});
