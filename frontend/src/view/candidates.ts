import { sanitizePublicText } from "../api/adapter";
import type { AnalysisCheck, AnalysisConstraint, AnalysisEvidence } from "../api/types";

export type Tone = "long" | "short" | "verify" | "pass" | "fail" | "unknown" | "none";

export type StageView = { label: string; tone: Tone; note: string };
export type TechView = { label: string; tone: Tone };

export type EvidenceLink = { id: string; title: string };

export type CheckView = {
	requirement: string;
	observed: string;
	result: TechView;
	reason: string;
	formula: string | null;
	evidence: EvidenceLink[];
};

export type PriceRow = { label: "计划预算" | "计划单价" | "历史成交价" | "公网参考价" | "正式报价"; text: string };

/** The Chinese projection of one frozen decision. */
export type DecisionGap = { text: string; importance: string | null; evidenceIds: string[] };
export type DecisionAction = { text: string };
export type DecisionSummary = {
	code: string | null;
	summary: string | null;
	gaps: DecisionGap[];
	nextActions: DecisionAction[];
	/** How much of the original free text was not translated. */
	untranslated: { rationale: boolean; gapCount: number; nextActionCount: number } | null;
};

export type CandidateRowView = {
	id: string;
	supplier: string;
	supplierCount: number;
	model: string;
	stage: StageView;
	technical: TechView;
	checks: CheckView[];
	/** The Chinese decision summary. The original free text is never shown. */
	summary: string | null;
	decision: DecisionSummary | null;
	ambiguous: boolean;
	sourceTitle: string | null;
	sourceDate: string | null;
	excerpt: string | null;
	evidenceId: string | null;
	sourceUrl: string | null;
	otherEvidence: EvidenceLink[];
	prices: PriceRow[];
	groupCount: number;
	members: CandidateRowView[];
};

const OPERATORS: Record<string, string> = {
	RANGE_COVERS: "覆盖",
	CONTAINS: "包含",
	GTE: "≥",
	LTE: "≤",
	EQ: "=",
	NE: "≠",
	IN: "属于",
	GT: ">",
	LT: "<",
};

const REASONS: Record<string, string> = {
	VERIFIED_COMPARISON: "已按要求核对",
	MISSING_CLAIM: "没有读到这项",
	INCOMPLETE_SOURCE: "来源不完整",
	AMBIGUOUS_REQUIREMENT: "要求本身不清楚",
	ATTRIBUTE_NOT_ALIGNED: "对不上同一项",
	UNIT_NOT_CONVERTIBLE: "单位换不过来",
	CONDITIONAL_MISMATCH: "条件对不上",
	CONFLICTING_CLAIMS: "来源互相矛盾",
	UNSUPPORTED_OPERATOR: "这种比较还不能自动做",
	UNVERIFIED_CLAIM: "这条说法还没被来源确认",
	MODEL_VARIANT_UNCERTAIN: "型号对不上",
	UNSUPPORTED_FOR_AUTO_CHECK: "这项还不能自动核对",
	NO_HARD_CONSTRAINT: "没有硬性要求",
	UNRESOLVED_DEMAND: "需求还没定下来",
	INVALID_INPUT: "这项无法核对",
};

export function stageView(stage: string): StageView {
	if (stage === "DISCOVERED_LONG_LIST") return { label: "长名单", tone: "long", note: "公开资料里的线索。" };
	if (stage === "NEEDS_VERIFICATION") return { label: "待补证", tone: "verify", note: "还需要补充证据。" };
	if (stage === "RFQ_SHORTLIST") return { label: "建议询价", tone: "short", note: "可以先发询价。" };
	if (stage === "EXCLUDED") return { label: "已排除", tone: "long", note: "不进入询价。" };
	if (stage === "SCREENED") return { label: "已筛选", tone: "long", note: "还没有进入询价。" };
	return { label: "阶段未标明", tone: "long", note: "这一阶段没有可显示的说明。" };
}

export function technicalView(overall: string | null): TechView {
	if (overall === "PASS") return { label: "满足", tone: "pass" };
	if (overall === "FAIL") return { label: "不满足", tone: "fail" };
	if (overall === "UNKNOWN") return { label: "还不能判断", tone: "unknown" };
	return { label: "还没有核对", tone: "none" };
}

/** The verdicts of one model disagree. The frontend does not pick one. */
export const MIXED_VERDICT: TechView = { label: "结论不一致", tone: "none" };

export function presentFormula(operation: string | null): string | null {
	if (!operation?.trim()) return null;
	let text = operation;
	const codes = Object.keys(OPERATORS).sort((left, right) => right.length - left.length);
	for (const code of codes) text = text.replace(new RegExp(`\\b${code}\\b`, "g"), OPERATORS[code]);
	text = text.replace(/>=/g, "≥").replace(/<=/g, "≤");
	if (/[A-Za-z]{3,}/.test(text)) return null;
	const cleaned = text.replace(/\s+/g, " ").trim();
	return cleaned || null;
}

export function reasonText(code: string | null): string {
	if (!code) return "";
	return REASONS[code] ?? "";
}

export function httpUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.toString();
	} catch {
		return null;
	}
}

function constraintOf(constraints: AnalysisConstraint[], check: AnalysisCheck): AnalysisConstraint | null {
	for (const item of constraints) {
		if (item.constraint_id && item.constraint_id === check.constraint_id) return item;
	}
	return null;
}

function constraintLabel(constraints: AnalysisConstraint[], fallback: string | null, check: AnalysisCheck): string {
	const row = constraintOf(constraints, check);
	const definition = row?.attribute_definition?.trim();
	if (definition && !/^[a-z0-9_]+$/.test(definition)) return definition;
	if (fallback?.trim()) return fallback.trim();
	return "这条要求";
}

function observedText(check: AnalysisCheck, operator: string | null): string {
	const actual = check.normalized_actual?.trim();
	const required = check.normalized_required?.trim();
	const unit = check.unit?.trim();
	const symbol = operator ? OPERATORS[operator] ?? "" : "";
	if (!actual && !required) return "没有读到对应数值";
	const unitText = unit ? ` ${unit}` : "";
	const requiredText = required ? `${symbol ? `${symbol} ` : ""}${required}${unitText}` : "没有写明";
	const actualText = actual ? `${actual}${unitText}` : "没有读到";
	return `要求 ${requiredText}，读到 ${actualText}`;
}

export function checkViews(
	checks: AnalysisCheck[],
	constraints: AnalysisConstraint[],
	requirementName: string | null,
	evidence: AnalysisEvidence[],
): CheckView[] {
	const hard = checks.filter((check) => check.importance === "HARD");
	const shown = hard.length > 0 ? hard : checks;
	return shown.map((check) => {
		const constraint = constraintOf(constraints, check);
		return {
			requirement: constraintLabel(constraints, requirementName, check),
			observed: observedText(check, constraint?.operator ?? null),
			result: technicalView(check.status),
			reason: reasonText(check.reason_code),
			formula: presentFormula(check.operation),
			evidence: check.evidence_ids.map((id) => ({ id, title: evidence.find((item) => item.evidence_id === id)?.title || "来源" })),
		};
	});
}

export function sanitizeExcerpt(text: string | null): string | null {
	if (!text?.trim()) return null;
	return sanitizePublicText(text);
}
