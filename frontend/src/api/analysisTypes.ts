/**
 * The frozen analysis of one sourcing run.
 *
 * `GET /api/projects/{id}/analysis?pipeline_id=…` (or `?run_id=…`) is the only
 * source for a pipeline result. The project level `/spec-assessments` and
 * `/decisions` lists do not contain pipeline output, so the frontend never
 * reads them for a run.
 */

export type AnalysisConstraint = {
	constraint_id: string | null;
	attribute_key: string | null;
	attribute_definition: string | null;
	operator: string | null;
	value: string | null;
	unit: string | null;
	importance: string | null;
	source_quote: string | null;
};

export type AnalysisRequirement = {
	requirement_id: string;
	product_name: string | null;
	product_category: string | null;
	quantity: number | null;
	quantity_unit: string | null;
	constraints: AnalysisConstraint[];
};

export type AnalysisCandidate = {
	candidate_id: string;
	requirement_id: string | null;
	supplier_id: string | null;
	product_id: string | null;
	supplier_name: string | null;
	product_model: string | null;
	product_name: string | null;
	stage: string | null;
	evidence_ids: string[];
};

export type AnalysisCheck = {
	constraint_id: string | null;
	requirement_id: string | null;
	claim_ids: string[];
	status: string | null;
	reason_code: string | null;
	operation: string | null;
	normalized_actual: string | null;
	normalized_required: string | null;
	unit: string | null;
	evidence_ids: string[];
	importance: string | null;
};

export type AnalysisAssessment = {
	assessment_id: string;
	requirement_id: string | null;
	product_candidate_id: string | null;
	product_model_ref: string | null;
	hard_spec_overall: string | null;
	overall_reason_codes: string[];
	hard_constraint_count: number | null;
	unresolved_question_ids: string[];
	evaluated_at: string | null;
	checks: AnalysisCheck[];
};

export type AnalysisDisplayGap = {
	code: string | null;
	constraint_id: string | null;
	importance: string | null;
	evidence_ids: string[];
	text_zh: string | null;
};

export type AnalysisDisplayAction = {
	code: string | null;
	constraint_id: string | null;
	text_zh: string | null;
};

/** The Chinese projection of a frozen decision. It is not a translation of the original text. */
export type AnalysisDecisionDisplay = {
	version: string | null;
	basis: string | null;
	summary_code: string | null;
	summary_zh: string | null;
	gaps: AnalysisDisplayGap[];
	next_actions: AnalysisDisplayAction[];
	unresolved_question_ids: string[];
	untranslated_originals: {
		rationale: boolean;
		gap_count: number;
		next_action_count: number;
	};
};

export type AnalysisDecision = {
	decision_id: string;
	requirement_id: string | null;
	product_candidate_id: string | null;
	product_model_ref: string | null;
	recommendation: string | null;
	technical_verdict: string | null;
	hard_spec_overall: string | null;
	accepted: boolean;
	rationale: string | null;
	evidence_ids: string[];
	decided_at: string | null;
	display: AnalysisDecisionDisplay | null;
};

export type AnalysisPriceFinding = {
	lowest_basis: string | null;
	lowest_value: string | null;
	saving: string | null;
	saving_percent: string | null;
	comparability: string | null;
	explanation: string | null;
	lowest_observation_id: string | null;
};

export type AnalysisPriceContext = {
	requirement_id: string | null;
	product_name: string | null;
	budget: string | null;
	budget_currency: string | null;
	budget_unit: string | null;
	budget_kind: string | null;
	history_scope: string | null;
	history_scope_note: string | null;
	history_available: boolean;
	history_rows: number | null;
	statistics: Record<string, unknown> | null;
	overview_statistics: Record<string, unknown> | null;
	overview_is_not_a_baseline: boolean;
	findings: AnalysisPriceFinding[];
	notes: string[];
};

export type AnalysisEvidence = {
	evidence_id: string;
	title: string | null;
	url: string | null;
	content_sha256: string | null;
	quote: string | null;
	quote_status: string | null;
};

export type AnalysisSummaryModel = {
	product_model: string;
	product_id: string;
	candidate_rows: number;
	supplier_count: number;
};

export type AnalysisSummary = {
	requirements: number;
	candidate_rows: number;
	distinct_models: number;
	distinct_suppliers: number;
	models: AnalysisSummaryModel[];
	assessments: number;
	by_verdict: Record<string, number>;
	decisions: number;
	by_recommendation: Record<string, number>;
	evidence: number;
	coverage_warnings: string[];
};

export type AnalysisReport = {
	report_id: string | null;
	status: string | null;
	error_code: string | null;
	decision_version: string | null;
	download_path: string | null;
	warning_codes: string[];
};

export type Analysis = {
	project_id: string;
	pipeline_id: string;
	run_id: string;
	demand_revision: number;
	research_status: string;
	decision_version: string | null;
	requirements: AnalysisRequirement[];
	candidates: AnalysisCandidate[];
	assessments: AnalysisAssessment[];
	decisions: AnalysisDecision[];
	price_contexts: AnalysisPriceContext[];
	evidence: AnalysisEvidence[];
	summary: AnalysisSummary;
	report: AnalysisReport;
};
