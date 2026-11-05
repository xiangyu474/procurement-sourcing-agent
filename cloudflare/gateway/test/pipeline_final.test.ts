import assert from "node:assert/strict";
import { it } from "node:test";
import { buildFinalContext } from "../src/pipeline_final.ts";

function fixture() {
	return {
		pipelineId: "pipe", projectId: "project", projectTitle: "Title", runId: "run", demandRevision: 1,
		researchStatus: "PARTIAL", demandSha256: "demand", snapshotHashes: { SPEC_CONTEXT: "spec" },
		specContext: { project_id: "project", run_id: "run", demand_revision: 1,
			requirements: [{ requirement_id: "r" }],
			report_candidates: [{ candidate_id: "c", requirement_id: "r", evidence_ids: ["e"] }],
			report_evidence: [{ evidence_id: "e", content_sha256: "hash" }], claims: [{ claim_id: "cl" }] },
		specResults: { assessments: [{ input_digest: "a".repeat(64), model_config: { model: "m" },
			assessment: { requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", checks: [{ evidence_ids: ["e"] }] } }] },
		decisionResults: { decisions: [{ requirement_id: "r", product_candidate_id: "c", hard_spec_overall: "UNKNOWN", technical_verdict: "UNVERIFIED", recommendation: "INVESTIGATE", accepted: true, evidence_ids: ["e"] }] },
		priceContext: { price_contexts: [{ requirement_id: "r", history_scope: "NONE" }] },
	};
}

it("freezes exact source inputs and stable assessment identity", async () => {
	const input = fixture();
	const first = await buildFinalContext(input);
	assert.deepEqual(first, await buildFinalContext(input));
	assert.equal(first.research_status, "PARTIAL");
	assert.match(String((first.assessments as Array<Record<string, unknown>>)[0].assessment_id), /^pa_[a-f0-9]{40}$/);
	assert.deepEqual(first.claims, [{ claim_id: "cl" }]);
	assert.deepEqual(first.price_contexts, input.priceContext.price_contexts);
});

it("keeps a run without any source snapshot, so the analysis can say so", async () => {
	// A research that captured no source produced candidates without a
	// citation. That is a degraded answer, not a broken task.
	const input = fixture();
	input.specContext.report_evidence = [];
	input.specContext.report_candidates = [{ candidate_id: "c", requirement_id: "r", evidence_ids: [] }];
	input.specResults.assessments = [];
	input.decisionResults.decisions = [];
	input.priceContext.price_contexts = [];
	const result = await buildFinalContext(input);
	assert.deepEqual(result.candidates, input.specContext.report_candidates);
	assert.deepEqual(result.evidence, []);
});

it("fails closed on version mixing, missing evidence and unsafe accepted decisions", async () => {
	const wrongRun = fixture(); wrongRun.specContext.run_id = "other";
	await assert.rejects(() => buildFinalContext(wrongRun), /VERSION_MISMATCH/);
	// A candidate that cites a source snapshot that is not there fails closed.
	const missing = fixture(); missing.specContext.report_evidence = [];
	await assert.rejects(() => buildFinalContext(missing), /EVIDENCE_MISSING/);
	const unsafe = fixture(); unsafe.decisionResults.decisions[0].recommendation = "SHORTLIST";
	unsafe.decisionResults.decisions[0].technical_verdict = "VERIFIED_PASS";
	await assert.rejects(() => buildFinalContext(unsafe), /UNSAFE/);
	const rejected = fixture(); rejected.decisionResults.decisions[0].accepted = false;
	rejected.decisionResults.decisions[0].recommendation = "SHORTLIST";
	const result = await buildFinalContext(rejected);
	assert.equal((result.decisions as Array<Record<string, unknown>>)[0].accepted, false);
});
