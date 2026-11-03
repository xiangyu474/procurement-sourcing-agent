// Deterministic UI summaries of frozen structured checks. These are not
// translations of the model's free-text rationale, gaps, or next actions.
type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(obj) : [];
const str = (v: unknown): string => typeof v === "string" ? v : "";

const REASONS: Record<string, { text: string; action: string }> = {
	MISSING_CLAIM: { text: "尚未找到支持该项指标的可用资料。", action: "补充该型号的对应技术资料并核验来源。" },
	INCOMPLETE_SOURCE: { text: "该项指标的来源信息不完整。", action: "补充完整的来源和对应规格说明。" },
	AMBIGUOUS_REQUIREMENT: { text: "该项需求的含义或数值尚待确认。", action: "与需求方确认该项要求的含义和口径。" },
	ATTRIBUTE_NOT_ALIGNED: { text: "现有资料与该项要求是否衡量同一对象尚不明确。", action: "核实该型号的对应指标是否与需求衡量同一对象。" },
	UNIT_NOT_CONVERTIBLE: { text: "该项指标的单位或口径无法可靠换算。", action: "补充可比较的单位和计量口径。" },
	CONDITIONAL_MISMATCH: { text: "该项指标的适用条件与需求未确认一致。", action: "核实产品规格与需求的适用条件。" },
	CONFLICTING_CLAIMS: { text: "该项指标存在相互冲突的资料。", action: "核对冲突来源并确认适用的规格。" },
	UNSUPPORTED_OPERATOR: { text: "该项比较方式暂不能自动核验。", action: "由采购人员人工核验该项比较。" },
	UNVERIFIED_CLAIM: { text: "该项指标的来源尚未核实。", action: "核验该型号指标的原始资料。" },
	MODEL_VARIANT_UNCERTAIN: { text: "资料是否适用于该型号或变体尚不确定。", action: "核实资料对应的具体型号及变体。" },
	UNSUPPORTED_FOR_AUTO_CHECK: { text: "该项要求暂不能自动核验。", action: "由采购人员人工核验该项要求。" },
	NO_HARD_CONSTRAINT: { text: "当前没有可自动核验的硬性条件。", action: "确认采购需求中需要核验的硬性条件。" },
	UNRESOLVED_DEMAND: { text: "部分需求尚未形成可核验的明确条件。", action: "与需求方确认尚未明确的要求。" },
	INVALID_INPUT: { text: "该项核验输入不完整或无效。", action: "检查该项需求和来源资料后重新核验。" },
};

function summary(decision: Row, assessment: Row | undefined): { code: string; text: string } {
	if (decision.accepted !== true) return { code: "GATE_REJECTED", text: "该建议未通过验证门禁，暂不可采纳。" };
	if (!assessment || decision.hard_spec_overall !== assessment.hard_spec_overall) {
		return { code: "ASSESSMENT_UNAVAILABLE", text: "无法确认该建议与技术核验的对应关系，请人工复核。" };
	}
	const hard = str(assessment.hard_spec_overall);
	const recommendation = str(decision.recommendation);
	if (recommendation === "SHORTLIST") {
		if (hard === "PASS" && decision.technical_verdict === "VERIFIED_PASS") {
			return { code: "RECOMMENDED_INQUIRY_VERIFIED", text: "硬性条件的程序核验通过；可作为询价建议，仍需供应商确认。" };
		}
		return { code: "REVIEW_REQUIRED", text: "该建议尚不能作为询价结论，请人工复核。" };
	}
	if (recommendation === "EXCLUDE" && hard === "FAIL") {
		return { code: "HARD_REQUIREMENT_FAILED", text: "至少一项硬性条件核验不通过，建议排除。" };
	}
	if (recommendation === "INVESTIGATE" && hard === "UNKNOWN") {
		return { code: "EVIDENCE_INSUFFICIENT", text: "现有证据不足以判断是否符合全部硬性条件，建议补充核验。" };
	}
	if (recommendation === "INVESTIGATE") {
		return { code: "FURTHER_INVESTIGATION", text: "采购建议为继续调查，请结合核验结果和原始记录复核。" };
	}
	return { code: "REVIEW_REQUIRED", text: "请结合技术核验和原始记录人工复核该建议。" };
}

export function decisionDisplay(decision: Row, assessment: Row | undefined): Row {
	const title = summary(decision, assessment);
	const gaps: Row[] = [];
	const actions: Row[] = [];
	const represented = new Set<string>();
	for (const check of rows(assessment?.checks)) {
		const state = str(check.status);
		if (state !== "UNKNOWN" && state !== "FAIL") continue;
		const sourceCode = str(check.reason_code);
		if (sourceCode) represented.add(sourceCode);
		const found = state === "FAIL" && sourceCode === "VERIFIED_COMPARISON"
			? { text: "该项指标的比较结果不满足需求。", action: "核对该型号的原始规格与需求条件。" }
			: Object.hasOwn(REASONS, sourceCode) ? REASONS[sourceCode] : undefined;
		const code = found ? sourceCode : "UNMAPPED_ASSESSMENT_REASON";
		const constraintId = str(check.constraint_id) || null;
		const evidenceIds = Array.isArray(check.evidence_ids) ? check.evidence_ids.filter(id => typeof id === "string") : [];
		gaps.push({ code, ...(found ? {} : { source_code: sourceCode || null }), constraint_id: constraintId,
			importance: str(check.importance) || null, evidence_ids: evidenceIds,
			text_zh: found?.text ?? "该项核验存在尚待人工核实的问题。" });
		actions.push({ code, constraint_id: constraintId, text_zh: found?.action ?? "结合原始资料人工核实该项要求。" });
	}
	if (assessment && assessment.hard_spec_overall !== "PASS") {
		const codes = Array.isArray(assessment.overall_reason_codes) ? assessment.overall_reason_codes : [];
		for (const sourceCode of new Set(codes.filter(code => typeof code === "string" && code !== "VERIFIED_COMPARISON" && !represented.has(code)))) {
			const found = Object.hasOwn(REASONS, sourceCode) ? REASONS[sourceCode] : undefined;
			const code = found ? sourceCode : "UNMAPPED_ASSESSMENT_REASON";
			gaps.push({ code, ...(found ? {} : { source_code: sourceCode }), constraint_id: null, importance: null, evidence_ids: [], text_zh: found?.text ?? "该项核验存在尚待人工核实的问题。" });
			actions.push({ code, constraint_id: null, text_zh: found?.action ?? "结合原始资料人工核实该项要求。" });
		}
		if (!gaps.length && assessment.hard_spec_overall === "UNKNOWN") {
			gaps.push({ code: "UNRESOLVED_ASSESSMENT", constraint_id: null, importance: null, evidence_ids: [], text_zh: "该候选的技术核验仍存在未解决的问题。" });
			actions.push({ code: "UNRESOLVED_ASSESSMENT", constraint_id: null, text_zh: "结合需求和原始资料补充核验。" });
		}
	}
	if (decision.accepted !== true) {
		actions.push({ code: "GATE_REVIEW", constraint_id: null, text_zh: "核对验证门禁的违规原因后再决定是否重评。" });
	}
	return {
		version: "decision-display-v1", basis: "STRUCTURED_ASSESSMENT_NOT_TRANSLATION",
		summary_code: title.code, summary_zh: title.text, gaps, next_actions: actions,
		unresolved_question_ids: Array.isArray(assessment?.unresolved_question_ids) ? assessment.unresolved_question_ids.filter(id => typeof id === "string") : [],
		untranslated_originals: {
			rationale: Boolean(str(decision.rationale)),
			gap_count: Array.isArray(decision.gaps) ? decision.gaps.length : 0,
			next_action_count: Array.isArray(decision.next_actions) ? decision.next_actions.length : 0,
		},
	};
}
