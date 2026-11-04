import type {
	Analysis,
	AnalysisAssessment,
	AnalysisCandidate,
	AnalysisDecision,
	AnalysisEvidence,
	AnalysisPriceContext,
	AnalysisPriceFinding,
	AnalysisRequirement,
	AnalysisSummary,
} from "../api/types";
import {
	MIXED_VERDICT,
	checkViews,
	distinctByText,
	httpUrl,
	technicalView,
	type CandidateRowView,
	type DecisionSummary,
	type PriceRow,
	type StageView,
	type TechView,
} from "./candidates";

/** The stage a pipeline candidate really is in. A frozen M2 stage is not a decision. */
export const LONG_LIST: StageView = { label: "长名单", tone: "long", note: "公开资料里的线索。" };
export const RECOMMENDED: StageView = { label: "建议询价", tone: "short", note: "可以先发询价。" };
export const NEEDS_EVIDENCE: StageView = { label: "待补证", tone: "verify", note: "还需要补充证据。" };
export const EXCLUDED: StageView = { label: "已排除", tone: "long", note: "不进入询价。" };
/** The suppliers of one model do not agree. The frontend does not pick one. */
export const MIXED_STAGE: StageView = { label: "结论不一致", tone: "none", note: "同一型号的各供应来源结论不同，展开查看。" };

/**
 * A recommendation for inquiry only when the gate accepted it, the technical
 * verdict is a verified pass and the hard requirements passed. Anything else is
 * not an inquiry recommendation.
 */
export function isRecommendedInquiry(decision: AnalysisDecision | null): boolean {
	if (!decision) return false;
	return (
		decision.accepted === true &&
		decision.recommendation === "SHORTLIST" &&
		decision.technical_verdict === "VERIFIED_PASS" &&
		decision.hard_spec_overall === "PASS"
	);
}

export function decisionStage(decision: AnalysisDecision | null): StageView {
	if (!decision) return LONG_LIST;
	if (isRecommendedInquiry(decision)) return RECOMMENDED;
	if (decision.recommendation === "INVESTIGATE") return NEEDS_EVIDENCE;
	if (decision.recommendation === "EXCLUDE") return EXCLUDED;
	return LONG_LIST;
}

export function decisionSummary(decision: AnalysisDecision | null): DecisionSummary | null {
	if (!decision || !decision.display) return null;
	const display = decision.display;
	return {
		code: display.summary_code,
		summary: display.summary_zh,
		gaps: distinctByText(
			display.gaps
				.filter((gap) => Boolean(gap.text_zh))
				.map((gap) => ({ text: gap.text_zh as string, importance: gap.importance, evidenceIds: gap.evidence_ids })),
		),
		nextActions: distinctByText(
			display.next_actions
				.filter((action) => Boolean(action.text_zh))
				.map((action) => ({ text: action.text_zh as string })),
		),
		untranslated: {
			rationale: display.untranslated_originals.rationale,
			gapCount: display.untranslated_originals.gap_count,
			nextActionCount: display.untranslated_originals.next_action_count,
		},
	};
}

/** The original free text was not translated line by line. The page says so. */
export function untranslatedNote(summary: DecisionSummary | null): string | null {
	if (!summary?.untranslated) return null;
	const { rationale, gapCount, nextActionCount } = summary.untranslated;
	if (!rationale && gapCount === 0 && nextActionCount === 0) return null;
	const parts: string[] = [];
	if (rationale) parts.push("理由");
	if (gapCount > 0) parts.push(`${gapCount} 条缺口`);
	if (nextActionCount > 0) parts.push(`${nextActionCount} 条下一步`);
	return `还有原始信息待核对：${parts.join("、")}。`;
}

const BASIS_LABELS: Record<string, PriceRow["label"]> = {
	PLANNED_BUDGET: "计划预算",
	HISTORICAL_TRANSACTION: "历史成交价",
	PUBLIC_REFERENCE: "公网参考价",
	FORMAL_QUOTATION: "正式报价",
};

const OVERVIEW_HISTORY_TEXT = "这是导入目录的整体情况，不能当作这一项的成交记录，也不能用来比较。";

function amountText(value: string | null, currency: string | null, unit: string | null): string | null {
	if (!value || !value.trim()) return null;
	return [value.trim(), currency?.trim(), unit?.trim()].filter((part): part is string => Boolean(part)).join(" ");
}

function statisticText(statistics: Record<string, unknown> | null): { count: number | null; currency: string | null; unit: string | null } {
	if (!statistics) return { count: null, currency: null, unit: null };
	const count = typeof statistics.count === "number" ? statistics.count : null;
	const currency = typeof statistics.currency === "string" ? statistics.currency : null;
	const unit = typeof statistics.unit === "string" ? statistics.unit : null;
	return { count, currency, unit };
}

function findingFor(context: AnalysisPriceContext, label: PriceRow["label"]): AnalysisPriceFinding | null {
	const basis = Object.keys(BASIS_LABELS).find((key) => BASIS_LABELS[key] === label);
	if (!basis) return null;
	return context.findings.find((finding) => finding.lowest_basis === basis) ?? null;
}

function savingText(context: AnalysisPriceContext, finding: { saving: string | null; saving_percent: string | null } | null): string {
	if (!finding?.saving) return "";
	// The whole table overview is not a baseline, so no saving may be shown.
	if (context.overview_is_not_a_baseline) return "";
	const percent = finding.saving_percent ? `（${finding.saving_percent}%）` : "";
	return `可节省 ${finding.saving}${percent}。`;
}

/**
 * The four prices of one requirement, taken from the backend price context.
 * The frontend never computes a price, a scope or a saving.
 */
export function priceRows(context: AnalysisPriceContext | null): PriceRow[] {
	if (!context) {
		return [
			{ label: "计划预算", text: "还没有" },
			{ label: "历史成交价", text: "还没有" },
			{ label: "公网参考价", text: "还没有" },
			{ label: "正式报价", text: "还没有" },
		];
	}
	const statistics = statisticText(context.statistics);
	const budget = amountText(context.budget, context.budget_currency, context.budget_unit);
	const history = findingFor(context, "历史成交价");
	const publicPrice = findingFor(context, "公网参考价");
	const formal = findingFor(context, "正式报价");

	let historyText = "还没有";
	if (context.history_scope === "TABLE_OVERVIEW" || context.overview_is_not_a_baseline) {
		historyText = OVERVIEW_HISTORY_TEXT;
	} else if (history?.lowest_value) {
		const amount = amountText(history.lowest_value, statistics.currency, statistics.unit);
		const scope = context.history_scope === "ITEM" ? "这一项的成交记录。" : "";
		const count = statistics.count ? `（${statistics.count} 条）` : "";
		historyText = `${amount ?? history.lowest_value}${count}${scope}${savingText(context, history)}`;
	} else if (context.history_scope === "ITEM" && statistics.count) {
		historyText = `有这一项的成交记录，但没有给出金额。`;
	}

	let publicText = "还没有";
	if (publicPrice?.lowest_value) {
		publicText = `${publicPrice.lowest_value}。这是网页标价，不是正式报价。${savingText(context, publicPrice)}`;
	} else if (publicPrice && publicPrice.comparability === "NOT_COMPARABLE") {
		publicText = "不可比，不能用来比较。";
	}

	let formalText = "还没有";
	if (formal?.lowest_value) {
		formalText = `${formal.lowest_value}${savingText(context, formal)}`;
	} else if (formal && formal.comparability === "NOT_COMPARABLE") {
		formalText = "不可比，不能用来比较。";
	}

	return [
		{ label: "计划预算", text: budget ?? "还没有" },
		{ label: "历史成交价", text: historyText },
		{ label: "公网参考价", text: publicText },
		{ label: "正式报价", text: formalText },
	];
}

function groupKey(requirementId: string | null, model: string | null): string {
	return `${requirementId ?? ""}\u001f${model ?? ""}`;
}

function modelOf(candidate: AnalysisCandidate): string {
	return candidate.product_model?.trim() || "型号未注明";
}

function latestAssessment(rows: AnalysisAssessment[]): AnalysisAssessment | null {
	if (rows.length === 0) return null;
	return [...rows].sort((left, right) => (left.evaluated_at ?? "") < (right.evaluated_at ?? "") ? 1 : -1)[0];
}

function latestDecision(rows: AnalysisDecision[]): AnalysisDecision | null {
	if (rows.length === 0) return null;
	return [...rows].sort((left, right) => (left.decided_at ?? "") < (right.decided_at ?? "") ? 1 : -1)[0];
}

function distinctVerdicts(rows: AnalysisAssessment[]): string[] {
	const values = rows.map((row) => row.hard_spec_overall).filter((value): value is string => Boolean(value));
	return [...new Set(values)];
}

/**
 * One row per requirement and model. The technical unit of a check is
 * "requirement × model", so the same model offered by several suppliers shares
 * one conclusion and the table does not repeat it as flat supplier rows.
 */
export function buildAnalysisRows(analysis: Analysis): CandidateRowView[] {
	const evidenceById = new Map<string, AnalysisEvidence>(analysis.evidence.map((item) => [item.evidence_id, item]));
	const requirementById = new Map<string, AnalysisRequirement>(analysis.requirements.map((item) => [item.requirement_id, item]));
	const contextByRequirement = new Map<string, AnalysisPriceContext>(
		analysis.price_contexts.filter((item) => Boolean(item.requirement_id)).map((item) => [item.requirement_id as string, item]),
	);

	const groups = new Map<string, { requirementId: string | null; model: string; candidates: AnalysisCandidate[] }>();
	for (const candidate of analysis.candidates) {
		const model = modelOf(candidate);
		const key = groupKey(candidate.requirement_id, model);
		const bucket = groups.get(key) ?? { requirementId: candidate.requirement_id, model, candidates: [] };
		bucket.candidates.push(candidate);
		groups.set(key, bucket);
	}

	const rows: CandidateRowView[] = [];
	for (const [key, bucket] of groups) {
		const requirement = bucket.requirementId ? requirementById.get(bucket.requirementId) ?? null : null;
		const requirementName = requirement?.product_name ?? null;
		const memberIds = new Set(bucket.candidates.map((candidate) => candidate.candidate_id));

		const groupAssessments = analysis.assessments.filter(
			(assessment) =>
				(assessment.requirement_id ?? null) === (bucket.requirementId ?? null) &&
				((assessment.product_model_ref ?? null) === bucket.model || (assessment.product_candidate_id ? memberIds.has(assessment.product_candidate_id) : false)),
		);
		const groupDecisions = analysis.decisions.filter(
			(decision) =>
				(decision.requirement_id ?? null) === (bucket.requirementId ?? null) &&
				((decision.product_model_ref ?? null) === bucket.model || (decision.product_candidate_id ? memberIds.has(decision.product_candidate_id) : false)),
		);

		const assessment = latestAssessment(groupAssessments);
		const decision = latestDecision(groupDecisions);
		const verdicts = distinctVerdicts(groupAssessments);
		const technical: TechView = verdicts.length === 1 ? technicalView(verdicts[0]) : verdicts.length > 1 ? MIXED_VERDICT : technicalView(null);

		const members: CandidateRowView[] = bucket.candidates
			.map((candidate) => {
				const memberAssessment = latestAssessment(
					analysis.assessments.filter((item) => item.product_candidate_id === candidate.candidate_id),
				);
				const memberDecision = latestDecision(analysis.decisions.filter((item) => item.product_candidate_id === candidate.candidate_id));
				const memberEvidence = candidate.evidence_ids.map((id) => evidenceById.get(id)).filter((item): item is AnalysisEvidence => Boolean(item));
				const first = memberEvidence[0] ?? null;
				const memberSummary = decisionSummary(memberDecision);
				return {
					id: candidate.candidate_id,
					supplier: candidate.supplier_name?.trim() || "未注明供应商",
					supplierCount: 1,
					model: bucket.model,
					stage: decisionStage(memberDecision ?? decision),
					technical: memberAssessment ? technicalView(memberAssessment.hard_spec_overall) : technical,
					checks: [],
					summary: memberSummary?.summary ?? null,
					decision: memberSummary,
					ambiguous: false,
					sourceTitle: first?.title ?? null,
					sourceDate: null,
					excerpt: first?.quote ?? null,
					evidenceId: first?.evidence_id ?? null,
					sourceUrl: httpUrl(first?.url ?? null),
					otherEvidence: memberEvidence.slice(1).map((item) => ({ id: item.evidence_id, title: item.title || "来源" })),
					prices: [],
					groupCount: 1,
					members: [],
				};
			})
			.sort((left, right) => left.supplier.localeCompare(right.supplier, "zh-Hans-CN"));

		// The suppliers of one model may carry different recommendations. The
		// frontend does not merge them into one conclusion.
		const memberStages = new Set(members.map((member) => member.stage.label));
		const groupStage = memberStages.size === 1 ? members[0].stage : MIXED_STAGE;
		const memberCodes = new Set(members.map((member) => member.decision?.code ?? ""));
		const groupSummary = memberCodes.size === 1 ? members[0].decision : null;
		// One supplier can offer the same model more than once. The row counts the
		// suppliers, not the candidate lines.
		const supplierCount = new Set(
			bucket.candidates.map((candidate) => candidate.supplier_id ?? candidate.supplier_name ?? candidate.candidate_id),
		).size;

		const groupEvidence = members.flatMap((member) =>
			(member.evidenceId ? [{ id: member.evidenceId, title: member.sourceTitle || "来源" }] : []).concat(member.otherEvidence),
		);
		const leader = members[0] ?? null;

		rows.push({
			id: key,
			supplier: supplierCount === 1 ? members[0].supplier : `${supplierCount} 家供应商`,
			supplierCount,
			model: bucket.model,
			stage: groupStage,
			technical,
			checks: assessment ? checkViews(assessment.checks, requirement?.constraints ?? [], requirementName, analysis.evidence) : [],
			summary: groupSummary?.summary ?? null,
			decision: groupSummary,
			ambiguous: groupAssessments.length > 1 && verdicts.length > 1,
			sourceTitle: leader?.sourceTitle ?? null,
			sourceDate: null,
			excerpt: leader?.excerpt ?? null,
			evidenceId: leader?.evidenceId ?? null,
			sourceUrl: leader?.sourceUrl ?? null,
			otherEvidence: groupEvidence.filter((item) => item.id !== leader?.evidenceId).slice(0, 12),
			prices: priceRows(bucket.requirementId ? contextByRequirement.get(bucket.requirementId) ?? null : null),
			groupCount: members.length,
			members,
		});
	}

	return rows.sort((left, right) => {
		const byModel = left.model.localeCompare(right.model, "zh-Hans-CN");
		if (byModel !== 0) return byModel;
		return left.id.localeCompare(right.id);
	});
}

/** The counts the backend published for this run. */
export function analysisSummaryLine(summary: AnalysisSummary, modelNames: number): string {
	const parts: string[] = [];
	// The number of models the buyer can see. The backend counts product records,
	// so one model name can be counted twice.
	parts.push(`${modelNames} 个型号`);
	parts.push(`${summary.distinct_suppliers} 家供应来源`);
	const verdicts = verdictText(summary.by_verdict);
	if (verdicts) parts.push(`核验 ${summary.assessments} 条：${verdicts}`);
	parts.push(`${summary.evidence} 份证据`);
	return parts.join(" · ");
}

function verdictText(byVerdict: Record<string, number>): string {
	const parts: string[] = [];
	if (byVerdict.PASS) parts.push(`满足 ${byVerdict.PASS}`);
	if (byVerdict.FAIL) parts.push(`不满足 ${byVerdict.FAIL}`);
	if (byVerdict.UNKNOWN) parts.push(`还不能判断 ${byVerdict.UNKNOWN}`);
	return parts.join(" · ");
}

export function recommendationText(byRecommendation: Record<string, number>): string {
	const parts: string[] = [];
	if (byRecommendation.SHORTLIST) parts.push(`建议询价 ${byRecommendation.SHORTLIST}`);
	if (byRecommendation.INVESTIGATE) parts.push(`待补证 ${byRecommendation.INVESTIGATE}`);
	if (byRecommendation.EXCLUDE) parts.push(`已排除 ${byRecommendation.EXCLUDE}`);
	return parts.join(" · ");
}
