import assert from "node:assert/strict";
import { it } from "node:test";
import { sourcingSummary } from "../src/pipeline_summary.ts";

it("reports models, suppliers, verdicts and the gaps of one run", () => {
	const summary = sourcingSummary({
		requirements: [{ requirement_id: "r" }],
		candidates: [
			{ candidate_id: "c1", product_model: "NBN-80052-BA", product_id: "p1", supplier_id: "s1" },
			{ candidate_id: "c2", product_model: "NBN-80052-BA", product_id: "p1", supplier_id: "s2" },
			{ candidate_id: "c3", product_model: "IPS05", product_id: "p2", supplier_id: "s1" },
		],
		assessments: [
			{ hard_spec_overall: "PASS" }, { hard_spec_overall: "PASS" }, { hard_spec_overall: "UNKNOWN" },
		],
		decisions: [{ recommendation: "SHORTLIST" }, { recommendation: "SHORTLIST" }, { recommendation: "INVESTIGATE" }],
		evidence: [{ evidence_id: "e1" }],
	});
	assert.equal(summary.requirements, 1);
	assert.equal(summary.candidate_rows, 3);
	assert.equal(summary.distinct_models, 2);
	assert.equal(summary.distinct_suppliers, 2);
	assert.deepEqual(summary.by_verdict, { PASS: 2, UNKNOWN: 1 });
	assert.deepEqual(summary.by_recommendation, { SHORTLIST: 2, INVESTIGATE: 1 });
	assert.equal(summary.evidence, 1);
	assert.deepEqual(summary.coverage_warnings, []);
	assert.deepEqual(summary.models, [
		{ product_model: "NBN-80052-BA", product_id: "p1", candidate_rows: 2, supplier_count: 2 },
		{ product_model: "IPS05", product_id: "p2", candidate_rows: 1, supplier_count: 1 },
	]);
});

it("warns when the run found one model only or no evidence", () => {
	const summary = sourcingSummary({
		candidates: [{ candidate_id: "c1", product_model: "A", product_id: "p1", supplier_id: "s1" },
			{ candidate_id: "c2", product_model: "A", product_id: "p1", supplier_id: "s2" }],
		assessments: [{ hard_spec_overall: "UNKNOWN" }],
		evidence: [],
	});
	assert.equal(summary.distinct_models, 1);
	assert.equal(summary.coverage_warnings.length, 3);
	assert.ok(summary.coverage_warnings.some(warning => warning.includes("只找到一个型号")));
	assert.ok(summary.coverage_warnings.some(warning => warning.includes("没有取到公开来源")));
});
