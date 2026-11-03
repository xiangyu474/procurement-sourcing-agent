import assert from "node:assert/strict";
import { it } from "node:test";
import { shapePipelineAnalysis } from "../src/pipeline_analysis.ts";

it("exposes frozen IDs and scoped prices without internal paths or model configuration", () => {
	const output = shapePipelineAnalysis({ project_id: "p", pipeline_id: "pipe", run_id: "r", demand_revision: 1,
		requirements: [{ requirement_id: "req", product_name: "camera", source_refs: ["private"], constraints: [{ constraint_id: "c", source_quote: "5MP", source_ref: "private" }] }],
		candidates: [{ candidate_id: "cand", requirement_id: "req", supplier_name: "S", evidence_ids: ["e"] }],
		assessments: [{ assessment_id: "a", requirement_id: "req", product_candidate_id: "cand", hard_spec_overall: "UNKNOWN", model_config: { api_key: "private" }, checks: [{ status: "UNKNOWN", source_refs: ["private"], evidence_ids: ["e"] }] }],
		decisions: [{ requirement_id: "req", product_candidate_id: "cand", recommendation: "INVESTIGATE", accepted: true }],
		price_contexts: [{ requirement_id: "req", history_scope: "TABLE_OVERVIEW", history: { available: false }, history_overview: { statistics: { minimum: "77" } }, findings: [] }],
		evidence: [{ evidence_id: "e", title: "doc", url: "https://example.test", content_sha256: "abc", snapshot_r2_key: "private" }],
	}, { status: "FAILED", download_path: null });
	const text = JSON.stringify(output);
	assert.ok(!text.includes("private"));
	assert.equal((output.assessments as Array<Record<string, unknown>>)[0].assessment_id, "a");
	const price = (output.price_contexts as Array<Record<string, unknown>>)[0];
	assert.equal(price.history_scope, "TABLE_OVERVIEW");
	assert.equal(price.overview_is_not_a_baseline, true);
	assert.deepEqual(price.overview_statistics, { minimum: "77" });
});

it("filters an old frozen evidence display without changing its ID, hash or snapshot input", () => {
	const raw = "Add paragraph text. Click “Edit Text” to update the font, size and more.\n\nThe RUT241 is a compact industrial cellular router with LTE and multiple connectivity options.";
	const frozen = { evidence: [{ evidence_id: "ev1", quote: raw, content_sha256: "abc" }] };
	const output = shapePipelineAnalysis(frozen, {});
	const row = (output.evidence as Array<Record<string, unknown>>)[0];
	assert.equal(row.evidence_id, "ev1");
	assert.equal(row.content_sha256, "abc");
	assert.equal(row.quote_status, "FILTERED_BOILERPLATE");
	assert.equal(row.quote, "The RUT241 is a compact industrial cellular router with LTE and multiple connectivity options.");
	assert.deepEqual((output.report as Record<string, unknown>).warning_codes, ["LEGACY_PLACEHOLDER_EXCERPT"]);
	assert.equal(frozen.evidence[0].quote, raw);
	const cleaned = shapePipelineAnalysis({ evidence: [{ evidence_id: "ev1", quote: row.quote, quote_status: "FILTERED_BOILERPLATE", content_sha256: "abc" }] }, {});
	assert.deepEqual((cleaned.report as Record<string, unknown>).warning_codes, []);
});
