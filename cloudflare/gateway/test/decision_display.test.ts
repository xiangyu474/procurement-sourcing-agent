import assert from "node:assert/strict";
import { it } from "node:test";
import { shapePipelineAnalysis } from "../src/pipeline_analysis.ts";

it("presents a source-bound Chinese summary without translating or dropping model gaps", () => {
	const assessment = { assessment_id: "a1", requirement_id: "r1", product_candidate_id: "c1", hard_spec_overall: "UNKNOWN", overall_reason_codes: ["MISSING_CLAIM"], checks: [
		{ constraint_id: "k1", status: "UNKNOWN", reason_code: "MISSING_CLAIM", evidence_ids: ["e1"] },
		{ constraint_id: "k2", status: "UNKNOWN", reason_code: "AMBIGUOUS_REQUIREMENT", evidence_ids: [] },
	] };
	const decision = { requirement_id: "r1", product_candidate_id: "c1", recommendation: "INVESTIGATE", technical_verdict: "UNVERIFIED", hard_spec_overall: "UNKNOWN", accepted: true,
		rationale: "No aligned attribute was found.", gaps: ["Missing LTE support", "Delivery terms unavailable"], next_actions: ["Request a datasheet", "Ask about delivery"] };
	const result = shapePipelineAnalysis({ assessments: [assessment], decisions: [decision] }, {});
	const d = (result.decisions as Array<Record<string, unknown>>)[0];
	const display = d.display as Record<string, unknown>;
	assert.equal(display.basis, "STRUCTURED_ASSESSMENT_NOT_TRANSLATION");
	assert.equal(display.summary_code, "EVIDENCE_INSUFFICIENT");
	assert.equal(display.summary_zh, "现有证据不足以判断是否符合全部硬性条件，建议补充核验。");
	assert.equal((display.gaps as Array<Record<string, unknown>>)[0].constraint_id, "k1");
	assert.equal((display.gaps as Array<Record<string, unknown>>)[0].code, "MISSING_CLAIM");
	assert.equal((display.gaps as Array<Record<string, unknown>>)[0].text_zh, "尚未找到支持该项指标的可用资料。");
	assert.equal((display.next_actions as Array<Record<string, unknown>>)[0].constraint_id, "k1");
	assert.deepEqual(display.untranslated_originals, { rationale: true, gap_count: 2, next_action_count: 2 });
	assert.deepEqual(d.gaps, decision.gaps);
	assert.deepEqual(d.next_actions, decision.next_actions);
	assert.equal(d.rationale, decision.rationale);
	assert.equal(assessment.checks[0].reason_code, "MISSING_CLAIM");
});

it("never presents a rejected or UNKNOWN shortlist as a verified recommendation", () => {
	const assessment = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", checks: [] };
	const decision = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", recommendation: "SHORTLIST", technical_verdict: "UNVERIFIED", accepted: false, violations: [{ code: "VERDICT_MISMATCH" }] };
	const result = shapePipelineAnalysis({ assessments: [assessment], decisions: [decision] }, {});
	const d = (result.decisions as Array<Record<string, unknown>>)[0];
	const display = d.display as Record<string, unknown>;
	assert.equal(display.summary_code, "GATE_REJECTED");
	assert.ok(!String(display.summary_zh).includes("建议询价"));
	assert.deepEqual(d.violations, decision.violations);
});

it("shows a structured overall reason even when there are no individual checks", () => {
	const assessment = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", overall_reason_codes: ["NO_HARD_CONSTRAINT"], checks: [] };
	const decision = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", recommendation: "INVESTIGATE", technical_verdict: "UNVERIFIED", accepted: true };
	const result = shapePipelineAnalysis({ assessments: [assessment], decisions: [decision] }, {});
	const display = (result.decisions as Array<Record<string, unknown>>)[0].display as Record<string, unknown>;
	const gap = (display.gaps as Array<Record<string, unknown>>)[0];
	assert.equal(gap.code, "NO_HARD_CONSTRAINT");
	assert.equal(gap.text_zh, "当前没有可自动核验的硬性条件。");
});

it("keeps overall research gaps not represented by individual checks", () => {
	const assessment = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", overall_reason_codes: ["MISSING_CLAIM", "UNRESOLVED_DEMAND"], unresolved_question_ids: ["q1"], checks: [{ constraint_id: "k", status: "UNKNOWN", reason_code: "MISSING_CLAIM", evidence_ids: ["e"] }] };
	const decision = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", recommendation: "INVESTIGATE", technical_verdict: "UNVERIFIED", accepted: true };
	const result = shapePipelineAnalysis({ assessments: [assessment], decisions: [decision] }, {});
	const display = (result.decisions as Array<Record<string, unknown>>)[0].display as Record<string, unknown>;
	assert.deepEqual((display.gaps as Array<Record<string, unknown>>).map(gap => gap.code), ["MISSING_CLAIM", "UNRESOLVED_DEMAND"]);
	assert.deepEqual(display.unresolved_question_ids, ["q1"]);
});

it("handles an unknown reason safely without pretending to translate it", () => {
	const assessment = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", checks: [{ constraint_id: "k", status: "UNKNOWN", reason_code: "FUTURE_REASON", evidence_ids: [] }] };
	const decision = { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", recommendation: "INVESTIGATE", technical_verdict: "UNVERIFIED", accepted: true };
	const result = shapePipelineAnalysis({ assessments: [assessment], decisions: [decision] }, {});
	const display = (result.decisions as Array<Record<string, unknown>>)[0].display as Record<string, unknown>;
	const gap = (display.gaps as Array<Record<string, unknown>>)[0];
	assert.equal(gap.code, "UNMAPPED_ASSESSMENT_REASON");
	assert.equal(gap.source_code, "FUTURE_REASON");
	assert.equal(gap.text_zh, "该项核验存在尚待人工核实的问题。");
	assessment.checks[0].reason_code = "constructor";
	const unexpected = shapePipelineAnalysis({ assessments: [assessment], decisions: [decision] }, {});
	const unexpectedDisplay = (unexpected.decisions as Array<Record<string, unknown>>)[0].display as Record<string, unknown>;
	assert.equal((unexpectedDisplay.gaps as Array<Record<string, unknown>>)[0].code, "UNMAPPED_ASSESSMENT_REASON");
});
