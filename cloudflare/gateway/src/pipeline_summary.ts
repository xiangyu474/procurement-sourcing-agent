// The outcome of one sourcing run in a form a buyer can read: how many models
// were found, how many suppliers offer them, what the checks concluded, and
// where the evidence is thin. Counts never replace the per-candidate records.
type Row = Record<string, unknown>;
const obj = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(obj) : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";

export function sourcingSummary(final: Row): Row {
	const candidates = rows(final.candidates);
	const assessments = rows(final.assessments);
	const decisions = rows(final.decisions);
	const evidence = rows(final.evidence);
	const requirements = rows(final.requirements);

	// A buyer counts the model names they can see. The same model offered by
	// several suppliers is one model, even when the supplier intelligence
	// stores it under two product records.
	const models = new Map<string, { model: string; products: Set<string>; candidates: number; suppliers: Set<string> }>();
	for (const candidate of candidates) {
		const raw = str(candidate.product_model).trim();
		const model = raw || "(型号未确认)";
		const key = raw ? raw.toUpperCase() : "";
		const entry = models.get(key) ?? { model, products: new Set<string>(), candidates: 0, suppliers: new Set<string>() };
		entry.candidates += 1;
		const product = str(candidate.product_id);
		if (product) entry.products.add(product);
		const supplier = str(candidate.supplier_id);
		if (supplier) entry.suppliers.add(supplier);
		models.set(key, entry);
	}
	const byVerdict: Record<string, number> = {};
	for (const assessment of assessments) {
		const verdict = str(assessment.hard_spec_overall) || "UNKNOWN";
		byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
	}
	const byRecommendation: Record<string, number> = {};
	for (const decision of decisions) {
		const recommendation = str(decision.recommendation) || "INVESTIGATE";
		byRecommendation[recommendation] = (byRecommendation[recommendation] ?? 0) + 1;
	}
	const distinctModels = [...models.values()].filter(entry => entry.model !== "(型号未确认)").length;
	const distinctSuppliers = new Set(candidates.map(candidate => str(candidate.supplier_id)).filter(Boolean)).size;
	const warnings: string[] = [];
	if (!candidates.length) warnings.push("这次寻源没有找到可核对的候选。");
	if (candidates.length > 0 && distinctModels <= 1) warnings.push("这次只找到一个型号，候选行来自不同供应商，而不是不同型号。");
	if (byVerdict.PASS === undefined && assessments.length > 0) warnings.push("没有任何候选通过硬性核验，结论多为证据不足。");
	if (evidence.length === 0) warnings.push("没有取到公开来源快照，结论无法复核。");
	return {
		requirements: requirements.length,
		candidate_rows: candidates.length,
		distinct_models: distinctModels,
		distinct_suppliers: distinctSuppliers,
		models: [...models.values()].map(entry => ({
			product_model: entry.model, product_id: [...entry.products][0] ?? "",
			product_ids: [...entry.products],
			candidate_rows: entry.candidates, supplier_count: entry.suppliers.size,
		})),
		assessments: assessments.length,
		by_verdict: byVerdict,
		decisions: decisions.length,
		by_recommendation: byRecommendation,
		evidence: evidence.length,
		coverage_warnings: warnings,
	};
}
