import { formatProjectDate, sanitizePublicText } from "../api/adapter";
import type { Candidate, JobStatus, RequirementsDocument, SourcingDecision, SpecAssessment, SpecCheck } from "../api/types";

export type Tone = "long" | "short" | "verify" | "pass" | "fail" | "unknown" | "none";

export type StageView = { label: string; tone: Tone; note: string };
export type TechView = { label: string; tone: Tone };

export type CheckView = {
	requirement: string;
	observed: string;
	result: TechView;
	reason: string;
	formula: string | null;
	reasonCode: string | null;
	evidenceIds: string[];
};

export type PriceRow = { label: "计划预算" | "历史成交价" | "公网参考价" | "正式报价"; text: string };

export type CandidateRowView = {
	id: string;
	supplier: string;
	model: string;
	stage: StageView;
	technical: TechView;
	inquiry: boolean;
	checks: CheckView[];
	rationale: string | null;
	ambiguous: boolean;
	sourceTitle: string | null;
	sourceDate: string | null;
	excerpt: string | null;
	evidenceId: string | null;
	sourceUrl: string | null;
	otherEvidence: Array<{ id: string; title: string }>;
	prices: PriceRow[];
};

const PRICE_LABELS = ["计划预算", "历史成交价", "公网参考价", "正式报价"] as const;

export function stageView(stage: string): StageView {
	if (stage === "DISCOVERED_LONG_LIST") return { label: "长名单", tone: "long", note: "公开资料里的线索，还不是建议询价。" };
	if (stage === "NEEDS_VERIFICATION") return { label: "待补证", tone: "verify", note: "还需要补充证据。" };
	if (stage === "RFQ_SHORTLIST") return { label: "建议先询价", tone: "short", note: "可以先发询价。" };
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

/** Shown only when the stored decision itself says both. The stage chip does not use this. */
export function suggestsInquiry(decision: { recommendation: string | null; technical_verdict: string | null } | null): boolean {
	return decision?.recommendation === "SHORTLIST" && decision.technical_verdict === "VERIFIED_PASS";
}

export function jobStatusLine(kind: "spec" | "decision", job: JobStatus | null): string | null {
	const status = job?.status ?? "IDLE";
	if (status === "COMPLETED") return null;
	if (status === "IDLE") return kind === "spec" ? "技术核对还没有开始。" : "决策还没有开始。";
	if (status === "QUEUED" || status === "RUNNING") return kind === "spec" ? "技术核对进行中。" : "决策进行中。";
	if (status === "FAILED") {
		const error = job?.error ? sanitizePublicText(job.error) : "";
		if (error && !/^[A-Za-z0-9_]+$/.test(error)) return error;
		return kind === "spec" ? "技术核对没有完成。" : "决策没有完成。";
	}
	return kind === "spec" ? "技术核对还没有结果。" : "决策还没有结果。";
}

type Amount = { value: string; currency: string | null; unit: string | null };
type HistoryScope = "ITEM" | "TABLE_OVERVIEW" | "NONE";

function amountText(amount: Amount): string {
	return [amount.value, amount.currency, amount.unit].filter((part): part is string => Boolean(part && part.trim())).join(" ");
}

function readAmount(value: unknown, expectedKind: string | null): Amount | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (expectedKind && typeof row.kind === "string" && row.kind !== expectedKind) return null;
	if (typeof row.value !== "string" || !row.value.trim()) return null;
	return {
		value: row.value.trim(),
		currency: typeof row.currency === "string" ? row.currency : null,
		unit: typeof row.unit === "string" ? row.unit : null,
	};
}

function historyScope(value: unknown): HistoryScope | null {
	if (value === "ITEM" || value === "TABLE_OVERVIEW" || value === "NONE") return value;
	return null;
}

export function priceRows(requirement: Record<string, unknown> | null): PriceRow[] {
	const budget = readAmount(requirement?.planned_total_budget, "PLANNED_BUDGET");
	const scope = historyScope(requirement?.history_scope);
	const historyAmount = readAmount(requirement?.history_price, "HISTORICAL_TRANSACTION");
	const publicPrice = readAmount(requirement?.public_reference, "PUBLIC_REFERENCE");
	const formal = readAmount(requirement?.formal_quotation, "FORMAL_QUOTATION");
	let history = "还没有";
	if (scope === "TABLE_OVERVIEW") history = "这是导入目录的整体情况，不能当作这一项的成交记录，也不能用来比较。";
	else if (scope === "ITEM" && historyAmount) history = `${amountText(historyAmount)}。口径是这一项。`;
	else if (scope === "ITEM") history = "有这一项的成交记录，但没有给出金额。";
	else if (scope === "NONE" || !scope) history = "还没有";
	return [
		{ label: "计划预算", text: budget ? amountText(budget) : "还没有" },
		{ label: "历史成交价", text: history },
		{ label: "公网参考价", text: publicPrice ? `${amountText(publicPrice)}。这是网页标价，不是正式报价。` : "还没有" },
		{ label: "正式报价", text: formal ? amountText(formal) : "还没有" },
	];
}

function pairKey(requirementId: string | null, candidateId: string | null): string | null {
	if (!requirementId || !candidateId) return null;
	return `${requirementId}\u001f${candidateId}`;
}

function latest<T extends { demand_revision?: number | null; evaluated_at?: string | null; decided_at?: string | null; created_at?: string | null }>(
	rows: T[],
): { row: T | null; ambiguous: boolean } {
	if (rows.length === 0) return { row: null, ambiguous: false };
	const rank = (row: T) => `${String(row.demand_revision ?? -1).padStart(8, "0")}|${row.evaluated_at ?? row.decided_at ?? row.created_at ?? ""}`;
	const sorted = [...rows].sort((left, right) => (rank(left) < rank(right) ? 1 : rank(left) > rank(right) ? -1 : 0));
	const top = sorted[0];
	const ambiguous = sorted.slice(1).some((row) => rank(row) === rank(top));
	return { row: top, ambiguous };
}

function constraintLabel(requirement: Record<string, unknown> | null, check: SpecCheck): string {
	const constraints = requirement && Array.isArray(requirement.constraints) ? requirement.constraints : [];
	for (const item of constraints) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		if (row.constraint_id !== check.constraint_id) continue;
		if (typeof row.attribute_definition === "string" && row.attribute_definition.trim()) return row.attribute_definition.trim();
	}
	if (requirement && typeof requirement.product_name === "string" && requirement.product_name.trim()) return requirement.product_name.trim();
	return "这条要求";
}

function observedText(check: SpecCheck): string {
	const actual = check.normalized_actual?.trim();
	const required = check.normalized_required?.trim();
	const unit = check.unit?.trim();
	if (!actual && !required) return "没有读到对应数值";
	const actualText = actual ? `${actual}${unit ? ` ${unit}` : ""}` : "没有读到";
	const requiredText = required ? `${required}${unit ? ` ${unit}` : ""}` : "没有写明";
	return `要求 ${requiredText}，读到 ${actualText}`;
}

function checkViews(checks: SpecCheck[], requirement: Record<string, unknown> | null): CheckView[] {
	const hard = checks.filter((check) => check.importance === "HARD");
	const shown = hard.length > 0 ? hard : checks;
	return shown.map((check) => ({
		requirement: constraintLabel(requirement, check),
		observed: observedText(check),
		result: technicalView(check.status),
		reason: check.explanation ? sanitizePublicText(check.explanation) : "",
		formula: check.operation,
		reasonCode: check.reason_code,
		evidenceIds: check.evidence_ids,
	}));
}

function requirementOf(document: RequirementsDocument | null, requirementId: string | null): Record<string, unknown> | null {
	if (!document || !requirementId) return null;
	const requirements = document.compilation.requirements;
	if (!Array.isArray(requirements)) return null;
	for (const item of requirements) {
		if (item && typeof item === "object" && (item as { requirement_id?: unknown }).requirement_id === requirementId) return item as Record<string, unknown>;
	}
	return null;
}

function httpUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.toString();
	} catch {
		return null;
	}
}

export function buildCandidateRows(input: {
	candidates: Candidate[];
	assessments: SpecAssessment[];
	decisions: SourcingDecision[];
	requirements: RequirementsDocument | null;
}): CandidateRowView[] {
	const assessmentsByPair = new Map<string, SpecAssessment[]>();
	for (const assessment of input.assessments) {
		const key = pairKey(assessment.requirement_id, assessment.product_candidate_id);
		if (!key) continue;
		assessmentsByPair.set(key, [...(assessmentsByPair.get(key) ?? []), assessment]);
	}
	const decisionsByPair = new Map<string, SourcingDecision[]>();
	for (const decision of input.decisions) {
		const key = pairKey(decision.requirement_id, decision.product_candidate_id);
		if (!key) continue;
		decisionsByPair.set(key, [...(decisionsByPair.get(key) ?? []), decision]);
	}
	return input.candidates.map((candidate) => {
		const key = pairKey(candidate.requirement_id, candidate.candidate_id);
		const assessmentPick = latest(key ? assessmentsByPair.get(key) ?? [] : []);
		const decisionPick = latest(key ? decisionsByPair.get(key) ?? [] : []);
		const requirement = requirementOf(input.requirements, candidate.requirement_id);
		const overall = assessmentPick.row?.hard_spec_overall ?? null;
		const evidence = candidate.evidence[0] ?? null;
		const rationale = decisionPick.row?.rationale ? sanitizePublicText(decisionPick.row.rationale) : "";
		return {
			id: candidate.candidate_id,
			supplier: candidate.supplier_name,
			model: candidate.model?.trim() || "型号未注明",
			stage: stageView(candidate.stage),
			technical: technicalView(overall),
			inquiry: suggestsInquiry(decisionPick.row) && candidate.stage === "RFQ_SHORTLIST",
			checks: checkViews(assessmentPick.row?.checks ?? [], requirement),
			rationale: rationale || null,
			ambiguous: assessmentPick.ambiguous || decisionPick.ambiguous,
			sourceTitle: evidence?.title ?? null,
			sourceDate: evidence?.retrieved_at ? formatProjectDate(evidence.retrieved_at) : null,
			excerpt: evidence?.excerpt ? sanitizePublicText(evidence.excerpt) : null,
			evidenceId: evidence?.evidence_id ?? null,
			sourceUrl: httpUrl(evidence?.source_url ?? null),
			otherEvidence: candidate.evidence.slice(1).map((item) => ({ id: item.evidence_id, title: item.title || "另一条来源" })),
			prices: priceRows(requirement),
		};
	});
}

export function priceLabels(): readonly string[] {
	return PRICE_LABELS;
}
