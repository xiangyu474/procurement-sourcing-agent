import { formatProjectDate, sanitizePublicText } from "../api/adapter";
import type { Candidate, CandidateEvidence, JobStatus, RequirementsDocument, SourcingDecision, SpecAssessment, SpecCheck } from "../api/types";

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

export type CandidateRowView = {
	id: string;
	supplier: string;
	model: string;
	stage: StageView;
	technical: TechView;
	checks: CheckView[];
	rationale: string | null;
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

export const JOB_STALL_MS = 30 * 60 * 1000;

const LONG_LIST_NOTE = "还没有核验和决策，以下只是长名单。";
const DECISION_NOTE = "还没有决策，以下只是长名单。";

export function stageView(stage: string): StageView {
	if (stage === "DISCOVERED_LONG_LIST") return { label: "长名单", tone: "long", note: "公开资料里的线索。" };
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

export function jobIsStalled(job: JobStatus | null, now = Date.now()): boolean {
	if (!job || (job.status !== "QUEUED" && job.status !== "RUNNING")) return false;
	if (!job.updated_at) return false;
	const at = Date.parse(job.updated_at);
	return Number.isFinite(at) && now - at > JOB_STALL_MS;
}

export function procurementLine(input: {
	runStatus: string;
	spec: JobStatus | null;
	decision: JobStatus | null;
	hasAssessments: boolean;
	hasDecisions: boolean;
	now?: number;
}): { line: string; decisionsReady: boolean; listNote: string | null } {
	const now = input.now ?? Date.now();
	const specStatus = input.hasAssessments && (input.spec?.status === "IDLE" || !input.spec) ? "COMPLETED" : (input.spec?.status ?? "IDLE");
	const decisionStatus = input.hasDecisions && (input.decision?.status === "IDLE" || !input.decision) ? "COMPLETED" : (input.decision?.status ?? "IDLE");
	const specStalled = jobIsStalled(input.spec, now);
	const decisionStalled = jobIsStalled(input.decision, now);
	const decisionsReady = input.hasDecisions;
	const listNote = decisionsReady ? null : input.hasAssessments ? DECISION_NOTE : LONG_LIST_NOTE;

	if (input.runStatus === "QUEUED" || input.runStatus === "RUNNING") {
		return { line: "研究", decisionsReady: false, listNote: null };
	}
	if (input.runStatus === "FAILED" && specStatus === "IDLE" && !input.hasAssessments) {
		return { line: "研究没有完成", decisionsReady: false, listNote: null };
	}
	if (specStalled && !input.hasAssessments) {
		return { line: "研究 → 核验已超过 30 分钟仍未结束。", decisionsReady: false, listNote: null };
	}
	if (specStatus === "FAILED" && !input.hasAssessments) {
		return { line: "研究 → 核验没有完成", decisionsReady: false, listNote: null };
	}
	if ((specStatus === "QUEUED" || specStatus === "RUNNING") && !input.hasAssessments) {
		return { line: "研究 → 核验", decisionsReady: false, listNote: null };
	}
	if (specStatus === "IDLE" && !input.hasAssessments) {
		const line = input.runStatus === "PARTIAL" ? "研究部分完成" : "研究已结束";
		return { line, decisionsReady: false, listNote };
	}
	if (decisionStalled && !input.hasDecisions) {
		return { line: "研究 → 核验 → 决策已超过 30 分钟仍未结束。", decisionsReady: false, listNote };
	}
	if (decisionStatus === "FAILED" && !input.hasDecisions) {
		return { line: "研究 → 核验 → 决策没有完成", decisionsReady: false, listNote };
	}
	if ((decisionStatus === "QUEUED" || decisionStatus === "RUNNING") && !input.hasDecisions) {
		return { line: "研究 → 核验 → 决策", decisionsReady: false, listNote };
	}
	if (decisionsReady) {
		const prefix = input.runStatus === "PARTIAL" ? "研究部分完成 → 核验 → 决策 → 完成" : "研究 → 核验 → 决策 → 完成";
		return { line: prefix, decisionsReady: true, listNote: null };
	}
	return { line: input.runStatus === "PARTIAL" ? "研究部分完成 → 核验" : "研究 → 核验", decisionsReady: false, listNote };
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
	const unitPrice = readAmount(requirement?.planned_unit_price, "PLANNED_PRICE");
	const scope = historyScope(requirement?.history_scope);
	const historyAmount = readAmount(requirement?.history_price, "HISTORICAL_TRANSACTION");
	const publicPrice = readAmount(requirement?.public_reference, "PUBLIC_REFERENCE");
	const formal = readAmount(requirement?.formal_quotation, "FORMAL_QUOTATION");
	let history = "还没有";
	if (scope === "TABLE_OVERVIEW") history = "这是导入目录的整体情况，不能当作这一项的成交记录，也不能用来比较。";
	else if (scope === "ITEM" && historyAmount) history = `${amountText(historyAmount)}。口径是这一项。`;
	else if (scope === "ITEM") history = "有这一项的成交记录，但没有给出金额。";
	const planned: PriceRow = budget
		? { label: "计划预算", text: amountText(budget) }
		: unitPrice
			? { label: "计划单价", text: amountText(unitPrice) }
			: { label: "计划预算", text: "还没有" };
	return [
		planned,
		{ label: "历史成交价", text: history },
		{ label: "公网参考价", text: publicPrice ? `${amountText(publicPrice)}。这是网页标价，不是正式报价。` : "还没有" },
		{ label: "正式报价", text: formal ? amountText(formal) : "还没有" },
	];
}

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

export function cleanRationale(text: string | null): string | null {
	if (!text?.trim()) return null;
	let value = sanitizePublicText(text);
	value = value.replace(/\b(?:pptx|xlsx|txt|text)_[A-Za-z0-9]+(?::[A-Za-z0-9_]+)?/gi, "");
	value = value.replace(/\b(?:ev|clm|pc|spc|dec)_[A-Za-z0-9]+/gi, "");
	value = value.replace(/\s{2,}/g, " ");
	value = value.replace(/引用\s*[与和]?\s*[。.]/g, "");
	value = value.replace(/依据\s*[与和]?\s*[。.]/g, "");
	value = value.replace(/\s*[与和]\s*[。.]/g, "。");
	value = value.replace(/[。.]{2,}/g, "。").replace(/\s+/g, " ").trim();
	if (!/[\u4e00-\u9fff]/.test(value)) return null;
	if (/\b[A-Za-z]+_[A-Za-z0-9_]+/.test(value)) return null;
	return value;
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

function constraintOf(requirement: Record<string, unknown> | null, check: SpecCheck): Record<string, unknown> | null {
	const constraints = requirement && Array.isArray(requirement.constraints) ? requirement.constraints : [];
	for (const item of constraints) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		if (row.constraint_id === check.constraint_id) return row;
	}
	return null;
}

function constraintLabel(requirement: Record<string, unknown> | null, check: SpecCheck): string {
	const row = constraintOf(requirement, check);
	if (typeof row?.attribute_definition === "string" && row.attribute_definition.trim() && !/^[a-z0-9_]+$/.test(row.attribute_definition.trim())) {
		return row.attribute_definition.trim();
	}
	if (requirement && typeof requirement.product_name === "string" && requirement.product_name.trim()) return requirement.product_name.trim();
	return "这条要求";
}

function observedText(check: SpecCheck, operator: string | null): string {
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

function evidenceLinks(ids: string[], evidence: CandidateEvidence[]): EvidenceLink[] {
	return ids.map((id) => ({ id, title: evidence.find((item) => item.evidence_id === id)?.title || "来源" }));
}

function checkViews(checks: SpecCheck[], requirement: Record<string, unknown> | null, evidence: CandidateEvidence[]): CheckView[] {
	const hard = checks.filter((check) => check.importance === "HARD");
	const shown = hard.length > 0 ? hard : checks;
	return shown.map((check) => {
		const operator = constraintOf(requirement, check);
		const operatorCode = typeof operator?.operator === "string" ? operator.operator : null;
		return {
			requirement: constraintLabel(requirement, check),
			observed: observedText(check, operatorCode),
			result: technicalView(check.status),
			reason: reasonText(check.reason_code),
			formula: presentFormula(check.operation),
			evidence: evidenceLinks(check.evidence_ids, evidence),
		};
	});
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

function leafRow(input: {
	candidate: Candidate;
	assessment: SpecAssessment | null;
	ambiguous: boolean;
	decision: SourcingDecision | null;
	requirement: Record<string, unknown> | null;
	decisionsReady: boolean;
}): CandidateRowView {
	const overall = input.assessment?.hard_spec_overall ?? null;
	const evidence = input.candidate.evidence[0] ?? null;
	const stage = input.decisionsReady ? stageView(input.candidate.stage) : { label: "长名单", tone: "long" as const, note: "公开资料里的线索。" };
	const rationale = input.decisionsReady ? cleanRationale(input.decision?.rationale ?? null) : null;
	const row: CandidateRowView = {
		id: input.candidate.candidate_id,
		supplier: input.candidate.supplier_name,
		model: input.candidate.model?.trim() || "型号未注明",
		stage,
		technical: technicalView(overall),
		checks: checkViews(input.assessment?.checks ?? [], input.requirement, input.candidate.evidence),
		rationale,
		ambiguous: input.ambiguous,
		sourceTitle: evidence?.title ?? null,
		sourceDate: evidence?.retrieved_at ? formatProjectDate(evidence.retrieved_at) : null,
		excerpt: evidence?.excerpt ? sanitizePublicText(evidence.excerpt) : null,
		evidenceId: evidence?.evidence_id ?? null,
		sourceUrl: httpUrl(evidence?.source_url ?? null),
		otherEvidence: input.candidate.evidence.slice(1).map((item) => ({ id: item.evidence_id, title: item.title || "来源" })),
		prices: priceRows(input.requirement),
		groupCount: 1,
		members: [],
	};
	return row;
}

function groupListings(rows: CandidateRowView[]): CandidateRowView[] {
	const order: string[] = [];
	const groups = new Map<string, CandidateRowView[]>();
	for (const row of rows) {
		const key = [row.supplier, row.model, row.stage.label, row.technical.label].join("\u001f");
		if (!groups.has(key)) order.push(key);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	return order.map((key) => {
		const members = groups.get(key) ?? [];
		return { ...members[0], groupCount: members.length, members };
	});
}

export function buildCandidateRows(input: {
	candidates: Candidate[];
	assessments: SpecAssessment[];
	decisions: SourcingDecision[];
	requirements: RequirementsDocument | null;
	decisionsReady?: boolean;
}): CandidateRowView[] {
	const decisionsReady = input.decisionsReady ?? input.decisions.length > 0;
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
	const leaves = input.candidates.map((candidate) => {
		const key = pairKey(candidate.requirement_id, candidate.candidate_id);
		const assessmentPick = latest(key ? (assessmentsByPair.get(key) ?? []) : []);
		const decisionPick = latest(key ? (decisionsByPair.get(key) ?? []) : []);
		return leafRow({
			candidate,
			assessment: assessmentPick.row,
			ambiguous: assessmentPick.ambiguous || decisionPick.ambiguous,
			decision: decisionPick.row,
			requirement: requirementOf(input.requirements, candidate.requirement_id),
			decisionsReady,
		});
	});
	return groupListings(leaves);
}
