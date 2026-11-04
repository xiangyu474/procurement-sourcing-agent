import { describe, expect, it } from "vitest";
import type { AnalysisCheck, AnalysisConstraint, AnalysisEvidence } from "../api/types";
import { checkViews, httpUrl, presentFormula, reasonText, stageView, technicalView } from "./candidates";

function check(patch: Partial<AnalysisCheck> = {}): AnalysisCheck {
	return {
		constraint_id: "k1",
		requirement_id: "r1",
		claim_ids: [],
		status: "UNKNOWN",
		reason_code: "MISSING_CLAIM",
		operation: null,
		normalized_actual: null,
		normalized_required: "IP66",
		unit: null,
		evidence_ids: [],
		importance: "HARD",
		...patch,
	};
}

const CONSTRAINTS: AnalysisConstraint[] = [
	{ constraint_id: "k1", attribute_key: "ip", attribute_definition: "防护等级", operator: "GTE", value: "IP66", unit: null, importance: "HARD", source_quote: null },
];

const EVIDENCE: AnalysisEvidence[] = [
	{ evidence_id: "ev_1", title: "IPS 规格页", url: "https://example.com/a", content_sha256: null, quote: "摘录", quote_status: "ORIGINAL" },
];

describe("candidate view", () => {
	it("maps stages without calling a long list a recommendation", () => {
		expect(stageView("DISCOVERED_LONG_LIST").label).toBe("长名单");
		expect(stageView("NEEDS_VERIFICATION").label).toBe("待补证");
		expect(stageView("RFQ_SHORTLIST").label).toBe("建议询价");
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

	it("builds a check from structured fields and hides raw ids", () => {
		expect(presentFormula("4.9152 MP GTE 5 MP")).toBe("4.9152 MP ≥ 5 MP");
		expect(presentFormula("actual >= required")).toBeNull();
		expect(reasonText("VERIFIED_COMPARISON")).toBe("已按要求核对");
		expect(reasonText("SUPERVISOR_RESEARCHER_ERROR")).toBe("");
		const [view] = checkViews(
			[
				check({
					status: "FAIL",
					reason_code: "VERIFIED_COMPARISON",
					operation: "4.9152 MP GTE 5 MP",
					normalized_actual: "4.9152",
					normalized_required: "5",
					unit: "MP",
					evidence_ids: ["ev_1"],
				}),
			],
			[{ ...CONSTRAINTS[0], constraint_id: "k1", operator: "GTE", attribute_definition: "像素" }],
			"摄像机",
			EVIDENCE,
		);
		expect(view.observed).toBe("要求 ≥ 5 MP，读到 4.9152 MP");
		expect(view.reason).toBe("已按要求核对");
		expect(view.formula).toBe("4.9152 MP ≥ 5 MP");
		expect(view.evidence).toEqual([{ id: "ev_1", title: "IPS 规格页" }]);
		expect(`${view.observed} ${view.reason} ${view.formula} ${view.evidence[0]?.title}`).not.toMatch(/output_resolution|GTE|ev_1/);
	});

	it("labels a check with the requirement when the constraint is unknown", () => {
		const [view] = checkViews([check({ constraint_id: "missing" })], CONSTRAINTS, "摄像机", EVIDENCE);
		expect(view.requirement).toBe("摄像机");
		expect(view.result.label).toBe("还不能判断");
		expect(view.reason).toBe("没有读到这项");
	});

	it("keeps only web addresses", () => {
		expect(httpUrl("https://example.com/a")).toBe("https://example.com/a");
		expect(httpUrl("javascript:alert(1)")).toBeNull();
		expect(httpUrl(null)).toBeNull();
	});
});
