// Build a self-contained, content-addressed decision input. The caller stores
// the returned JSON immutably before starting a report or exposing analysis.
type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const array = (v: unknown): Row[] => Array.isArray(v) ? v.map(obj) : [];
const str = (v: unknown): string => typeof v === "string" ? v : "";
const key = (r: Row) => `${str(r.requirement_id)}\u001f${str(r.product_candidate_id)}`;

async function digest(text: string): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
}

export interface FinalInput {
	pipelineId: string; projectId: string; projectTitle: string; runId: string;
	demandRevision: number; researchStatus: string; demandSha256: string;
	snapshotHashes: Record<string, string>; specContext: Row; specResults: Row;
	decisionResults: Row; priceContext: Row;
}

export async function buildFinalContext(input: FinalInput): Promise<Row> {
	const spec = input.specContext;
	if (spec.project_id !== input.projectId || spec.run_id !== input.runId || spec.demand_revision !== input.demandRevision) {
		throw new Error("SNAPSHOT_VERSION_MISMATCH");
	}
	const requirements = array(spec.requirements);
	const candidates = array(spec.report_candidates);
	const evidence = array(spec.report_evidence);
	const claims = array(spec.claims);
	const rawAssessments = array(input.specResults.assessments);
	const decisions = array(input.decisionResults.decisions);
	const prices = array(input.priceContext.price_contexts);
	// A run without source snapshots is still an answer: the analysis says in
	// words that no source could be captured. Only the demand itself and the
	// candidates it was matched to are required.
	if (!requirements.length || !candidates.length) {
		throw new Error("SNAPSHOT_INCOMPLETE");
	}
	const requirementIds = new Set(requirements.map(r => str(r.requirement_id)));
	const candidateMap = new Map(candidates.map(r => [str(r.candidate_id), r]));
	const evidenceIds = new Set(evidence.map(r => str(r.evidence_id)));
	if (requirementIds.has("") || candidateMap.has("") || evidenceIds.has("") || candidateMap.size !== candidates.length || evidenceIds.size !== evidence.length) {
		throw new Error("SNAPSHOT_INVALID_IDENTIFIERS");
	}
	for (const candidate of candidates) {
		if (!requirementIds.has(str(candidate.requirement_id))) throw new Error("SNAPSHOT_CANDIDATE_MISMATCH");
		for (const id of Array.isArray(candidate.evidence_ids) ? candidate.evidence_ids : []) {
			if (!evidenceIds.has(str(id))) throw new Error("SNAPSHOT_EVIDENCE_MISSING");
		}
	}
	const assessments: Row[] = [];
	const assessmentsByKey = new Map<string, Row>();
	for (const raw of rawAssessments) {
		const assessment = obj(raw.assessment);
		const candidate = candidateMap.get(str(assessment.product_candidate_id));
		const inputDigest = str(raw.input_digest);
		if (!candidate || candidate.requirement_id !== assessment.requirement_id || !/^[0-9a-f]{64}$/.test(inputDigest)) {
			throw new Error("SNAPSHOT_ASSESSMENT_MISMATCH");
		}
		const pair = key(assessment);
		if (assessmentsByKey.has(pair)) throw new Error("SNAPSHOT_DUPLICATE_ASSESSMENT");
		for (const check of array(assessment.checks)) {
			for (const id of Array.isArray(check.evidence_ids) ? check.evidence_ids : []) {
				if (!evidenceIds.has(str(id))) throw new Error("SNAPSHOT_EVIDENCE_MISSING");
			}
		}
		const stableId = `pa_${(await digest([input.pipelineId, pair, inputDigest].join("\u001f"))).slice(0, 40)}`;
		const result = { ...assessment, assessment_id: stableId, input_digest: inputDigest,
			model_config: raw.model_config ?? {}, prompt_versions: raw.prompt_versions ?? {} };
		assessments.push(result); assessmentsByKey.set(pair, result);
	}
	// The model may not decide every candidate. That is a gap in the answer,
	// not a broken answer: the decided ones are kept and the rest is recorded.
	const seen = new Set<string>();
	const decisionGaps: string[] = [];
	for (const decision of decisions) {
		const pair = key(decision); const assessment = assessmentsByKey.get(pair);
		if (!assessment) { decisionGaps.push(String(decision.product_candidate_id ?? pair)); continue; }
		if (seen.has(pair)) continue;
		seen.add(pair);
		if (decision.hard_spec_overall !== assessment.hard_spec_overall) throw new Error("SNAPSHOT_VERDICT_MISMATCH");
		if (decision.accepted === true && decision.technical_verdict === "VERIFIED_PASS" && assessment.hard_spec_overall !== "PASS") {
			throw new Error("SNAPSHOT_UNSAFE_PASS");
		}
		if (decision.accepted === true && decision.recommendation === "SHORTLIST" &&
			(assessment.hard_spec_overall !== "PASS" || decision.technical_verdict !== "VERIFIED_PASS")) {
			throw new Error("SNAPSHOT_UNSAFE_SHORTLIST");
		}
		for (const id of Array.isArray(decision.evidence_ids) ? decision.evidence_ids : []) {
			if (!evidenceIds.has(str(id))) throw new Error("SNAPSHOT_EVIDENCE_MISSING");
		}
	}
	for (const [pair, assessment] of assessmentsByKey) {
		if (!seen.has(pair)) decisionGaps.push(String(assessment.product_candidate_id ?? pair));
	}
	for (const price of prices) if (!requirementIds.has(str(price.requirement_id))) throw new Error("SNAPSHOT_PRICE_MISMATCH");
	return {
		schema_version: "pipeline-decision-v1", pipeline_id: input.pipelineId, project_id: input.projectId,
		project_title: input.projectTitle, run_id: input.runId, demand_revision: input.demandRevision,
		research_status: input.researchStatus, demand_sha256: input.demandSha256,
		source_snapshot_hashes: input.snapshotHashes, requirements, candidates, claims, evidence,
		assessments, decisions, price_contexts: prices, decision_gaps: decisionGaps,
	};
}
