import { evidenceDisplayExcerpt } from "./evidence_excerpt.ts";
import { decisionDisplay } from "./decision_display.ts";

type Row = Record<string, unknown>;
const obj = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(obj) : [];
function pick(value: Row, fields: string[]): Row {
	return Object.fromEntries(fields.filter(field => field in value).map(field => [field, value[field]]));
}

/** Public projection: do not expose model config, internal storage keys or source paths. */
export function shapePipelineAnalysis(final: Row, report: Row): Row {
	const requirements = rows(final.requirements).map(row => ({
		...pick(row, ["requirement_id", "product_name", "product_category", "quantity", "quantity_unit", "open_questions"]),
		planned_unit_price: row.planned_unit_price ? pick(obj(row.planned_unit_price), ["kind", "value", "currency", "unit", "tax_basis", "tax_rate", "source_quote"]) : null,
		planned_total_budget: row.planned_total_budget ? pick(obj(row.planned_total_budget), ["kind", "value", "currency", "unit", "tax_basis", "tax_rate", "source_quote"]) : null,
		constraints: rows(row.constraints).map(item => pick(item, ["constraint_id", "attribute_key", "attribute_definition", "operator", "value", "unit", "importance", "source_quote"])),
	}));
	const candidates = rows(final.candidates).map(row => pick(row, ["candidate_id", "requirement_id", "supplier_id", "product_id", "supplier_name", "product_model", "product_name", "stage", "rationale", "evidence_ids", "open_questions"]));
	const assessments = rows(final.assessments).map(row => ({
		...pick(row, ["assessment_id", "requirement_id", "product_candidate_id", "product_model_ref", "hard_spec_overall", "overall_reason_codes", "hard_constraint_count", "unresolved_question_ids", "evaluated_at"]),
		checks: rows(row.checks).map(check => pick(check, ["constraint_id", "requirement_id", "claim_ids", "status", "reason_code", "operation", "normalized_actual", "normalized_required", "unit", "evidence_ids", "importance"])),
	}));
	const assessmentsByKey = new Map<string, Row | null>();
	for (const assessment of rows(final.assessments)) {
		const key = `${String(assessment.requirement_id ?? "")}\u001f${String(assessment.product_candidate_id ?? "")}`;
		assessmentsByKey.set(key, assessmentsByKey.has(key) ? null : assessment);
	}
	const decisions = rows(final.decisions).map(row => {
		const key = `${String(row.requirement_id ?? "")}\u001f${String(row.product_candidate_id ?? "")}`;
		return {
			...pick(row, ["decision_id", "requirement_id", "product_candidate_id", "product_model_ref", "recommendation", "technical_verdict", "hard_spec_overall", "accepted", "rationale", "evidence_ids", "gaps", "next_actions", "priority_rank", "violations", "decided_at"]),
			display: decisionDisplay(row, assessmentsByKey.get(key) ?? undefined),
		};
	});
	const priceContexts = rows(final.price_contexts).map(row => {
		const history = obj(row.history); const overview = obj(row.history_overview);
		return {
			requirement_id: row.requirement_id, product_name: row.product_name, budget: row.budget_value,
			budget_currency: row.budget_currency, budget_unit: row.budget_unit, budget_tax_basis: row.budget_tax_basis,
			history_scope: row.history_scope, history_scope_note: history.scope_note, history_available: history.available,
			history_rows: history.transaction_count, statistics: history.statistics ?? null,
			overview_statistics: overview.statistics ?? null, overview_is_not_a_baseline: row.history_scope === "TABLE_OVERVIEW",
			findings: rows(row.findings).map(f => pick(f, ["lowest_basis", "lowest_value", "saving", "saving_percent", "comparability", "explanation", "lowest_observation_id"])),
			notes: row.notes ?? [],
		};
	});
	const frozenEvidence = rows(final.evidence);
	const evidence = frozenEvidence.map(row => {
		const excerpt = evidenceDisplayExcerpt(typeof row.quote === "string" ? row.quote : null);
		const status = excerpt.status === "ORIGINAL" && row.quote_status === "FILTERED_BOILERPLATE" ? row.quote_status : excerpt.status;
		return { ...pick(row, ["evidence_id", "title", "url", "content_sha256"]), quote: excerpt.text, quote_status: status };
	});
	// The displayed quote can be safely filtered without mutating the frozen
	// snapshot, but a DOCX produced from an older raw snapshot may still contain
	// the original template text. Do not silently overwrite that artifact.
	const legacyBoilerplate = frozenEvidence.some(row =>
		typeof row.quote === "string" && row.quote.trim().length > 0 && evidenceDisplayExcerpt(row.quote).status !== "ORIGINAL");
	const reportView = { ...report, warning_codes: legacyBoilerplate ? ["LEGACY_PLACEHOLDER_EXCERPT"] : [] };
	return { ...pick(final, ["project_id", "pipeline_id", "run_id", "demand_revision", "research_status"]),
		requirements, candidates, assessments, decisions, price_contexts: priceContexts, evidence, report: reportView };
}
