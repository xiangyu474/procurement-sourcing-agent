import type { PipelineStage } from "../api/types";

const STAGE_LINES: Record<string, string> = {
	RESEARCH: "正在寻找供应商",
	RESEARCHING: "正在寻找供应商",
	EVALUATING: "正在核对技术与价格",
	DECIDING: "正在整理采购建议",
};

/** Buyer-facing name of a pipeline step. Top-level RESEARCHING and stages[] RESEARCH are the same step. */
const STAGE_TITLES: Record<string, string> = {
	RESEARCH: "寻找供应商",
	RESEARCHING: "寻找供应商",
	EVALUATING: "供应商核验",
	DECIDING: "采购建议",
};

/**
 * Codes that may be stored on `stages[].error_code`.
 * Source: `cloudflare/gateway/src/stage_error.ts` (`SAFE_STAGE_CODES`), plus
 * `PIPELINE_STAGE_FAILED`, which `stageErrorCode` publishes when the cause is not in that set.
 * Report codes (`report_error_code`) are not stage codes and are not listed here.
 */
export const STAGE_ERROR_CODES = [
	"STAGE_SERVICE_ERROR",
	"MODEL_TIMEOUT",
	"MODEL_RATE_LIMIT",
	"DECISION_FAILED",
	"SPEC_EVALUATION_FAILED",
	"RESEARCH_EXECUTION_FAILED",
	"RESEARCH_FAILED",
	"RESEARCH_TIMEOUT",
	"NO_ASSESSMENTS",
	"NO_DECISIONS",
	"SNAPSHOT_MISSING",
	"SNAPSHOT_CONFLICT",
	"SNAPSHOT_INTEGRITY_ERROR",
	"NO_CANDIDATES",
	"TOO_MANY_CANDIDATES",
	"SPEC_CONTEXT_FAILED",
	"SPEC_CONTEXT_INVALID",
	"PIPELINE_NOT_FOUND",
	"HISTORY_SNAPSHOT_MISSING",
	"HISTORY_SNAPSHOT_INVALID",
	"INVALID_RESEARCH_INPUT",
	"RESEARCH_INPUT_REJECTED",
	"PIPELINE_STAGE_FAILED",
] as const;

/**
 * Research stop reasons the gateway already publishes (`guest_public.ts` SAFE_REASONS
 * and the research completion status). They are not stage codes unless a stage row
 * carries one. `NO_CANDIDATES` above is the stage code that means zero candidates;
 * `NO_SOURCE_BACKED_CANDIDATES` is the research run's own zero-candidate reason.
 */
export const RESEARCH_STOP_CODES = [
	"BUDGET_EXHAUSTED",
	"SEARCH_PROVIDER_TIMEOUT",
	"SEARCH_PROVIDER_RATE_LIMITED",
	"NO_FETCHED_EVIDENCE",
	"NO_SOURCE_BACKED_CANDIDATES",
	"SOURCE_FETCH_FAILED",
	"RESEARCHER_FINDINGS_INCOMPLETE",
] as const;

const CODE_COPY: Record<string, string> = {
	MODEL_TIMEOUT: "分析超时。",
	MODEL_RATE_LIMIT: "分析服务繁忙，请稍后再试。",
	DECISION_FAILED: "采购建议没有生成，可以再试一次。",
	SPEC_EVALUATION_FAILED: "供应商核验没有完成，可以再试一次。",
	RESEARCH_EXECUTION_FAILED: "寻源过程中断，可以再试一次。",
	RESEARCH_FAILED: "寻源没有完成。",
	RESEARCH_TIMEOUT: "寻找供应商超时，可以再试一次。",
	NO_ASSESSMENTS: "供应商核验没有得出结果，可以再试一次。",
	NO_DECISIONS: "采购建议没有生成，可以再试一次。",
	SNAPSHOT_MISSING: "这次结果没有保存下来，可以再试一次。",
	SNAPSHOT_CONFLICT: "这次结果没有保存下来，可以再试一次。",
	SNAPSHOT_INTEGRITY_ERROR: "这次结果没有保存下来，可以再试一次。",
	NO_CANDIDATES: "这次没有候选供应商。",
	TOO_MANY_CANDIDATES: "候选供应商过多，这次没有完成。",
	SPEC_CONTEXT_FAILED: "核验资料没有准备好，可以再试一次。",
	SPEC_CONTEXT_INVALID: "核验资料不完整，可以再试一次。",
	PIPELINE_NOT_FOUND: "没有找到这次分析，可以再试一次。",
	HISTORY_SNAPSHOT_MISSING: "历史数据没有保存下来，可以再试一次。",
	HISTORY_SNAPSHOT_INVALID: "历史数据无法读取，可以再试一次。",
	INVALID_RESEARCH_INPUT: "当前需求无法开始寻源。",
	RESEARCH_INPUT_REJECTED: "有一条资料地址被拒绝。",
	BUDGET_EXHAUSTED: "本次公开查阅的次数已用完。",
	SEARCH_PROVIDER_TIMEOUT: "公开检索超时。",
	SEARCH_PROVIDER_RATE_LIMITED: "公开检索过于频繁，请稍后再试。",
	NO_FETCHED_EVIDENCE: "没有读到可用的公开资料。",
	NO_SOURCE_BACKED_CANDIDATES: "没有找到有公开资料支撑的候选供应商。",
	SOURCE_FETCH_FAILED: "有的公开页面没有读出来。",
	RESEARCHER_FINDINGS_INCOMPLETE: "有一部分公开资料没有形成可用记录。",
};

const ACTIVE_STATUS = new Set(["QUEUED", "RUNNING"]);
const TERMINAL_STATUS = new Set(["COMPLETED", "PARTIAL", "FAILED"]);

export type StageProblem = {
	stage?: string | null;
	status?: string | null;
	error_code?: string | null;
};

/**
 * The line for a polled pipeline. RESEARCH and RESEARCHING are the same step:
 * the sample uses RESEARCH and the prose says RESEARCHING.
 *
 * The report has its own status. A finished analysis with a report that is
 * still being written says so instead of claiming the work is done.
 */
export function pipelineProgressLine(status: string, stage: string | null, reportStatus?: string | null): string | null {
	if (status === "COMPLETED") {
		return reportStatus === "QUEUED" || reportStatus === "RUNNING" ? "正在生成报告" : "已完成";
	}
	if (status === "PARTIAL" || status === "FAILED") return "需要处理";
	const normalized = stage?.trim().toUpperCase() ?? "";
	if (STAGE_LINES[normalized]) return STAGE_LINES[normalized];
	if (status === "QUEUED" || (status === "RUNNING" && normalized.length === 0)) return "正在寻找供应商";
	if (status === "RUNNING") return "分析进行中";
	return null;
}

/**
 * Main heading from the pipeline's own status.
 * FAILED is 「需要处理」. COMPLETED stays 「寻源已结束」 and PARTIAL stays 「部分完成」.
 * Returns null while the task is still running, so the research-run heading can show the current step.
 */
export function pipelineHeading(status: string | null | undefined): string | null {
	if (status === "FAILED") return "需要处理";
	if (status === "PARTIAL") return "部分完成";
	if (status === "COMPLETED") return "寻源已结束";
	if (status === "QUEUED") return "排队中";
	return null;
}

/** In progress only while the task itself is queued or running. A terminal pipeline releases the button. */
export function analysisInProgress(pipelineStatus: string | null | undefined, runStatus: string | null | undefined): boolean {
	if (pipelineStatus && TERMINAL_STATUS.has(pipelineStatus)) return false;
	if (pipelineStatus && ACTIVE_STATUS.has(pipelineStatus)) return true;
	if (!pipelineStatus && runStatus && ACTIVE_STATUS.has(runStatus)) return true;
	return false;
}

function stageTitle(stage: string | null | undefined): string | null {
	const key = stage?.trim().toUpperCase() ?? "";
	return STAGE_TITLES[key] ?? null;
}

/** Unknown codes use this. It names the step and does not guess why it failed. */
export function stageFallback(stage: string | null | undefined): string {
	const title = stageTitle(stage);
	return title ? `${title}这一步没有完成，可以再试一次。` : "这一步没有完成，可以再试一次。";
}

/** Chinese for one published code on one step. Null when the code is not in the catalog. */
export function stageErrorCopy(stage: string | null | undefined, code: string): string | null {
	if (code === "STAGE_SERVICE_ERROR" || code === "PIPELINE_STAGE_FAILED") {
		if (code === "PIPELINE_STAGE_FAILED" && !stageTitle(stage)) return "这次分析没有完成，可以再试一次。";
		return stageFallback(stage);
	}
	return CODE_COPY[code] ?? null;
}

function failingEntry(stages: StageProblem[]): StageProblem | null {
	for (let index = stages.length - 1; index >= 0; index -= 1) {
		if (stages[index]?.status === "FAILED") return stages[index] ?? null;
	}
	for (let index = stages.length - 1; index >= 0; index -= 1) {
		if (stages[index]?.error_code) return stages[index] ?? null;
	}
	return null;
}

/**
 * Subtitle for a pipeline that stopped. The failing `stages[]` entry wins over
 * the top-level `PIPELINE_STAGE_FAILED`. Raw codes and exception text are never returned.
 */
export function pipelineProblemLine(status: string, error: string | null, stages: Array<Pick<PipelineStage, "error_code"> & StageProblem>): string | null {
	if (status !== "PARTIAL" && status !== "FAILED") return null;
	const entry = failingEntry(stages);
	const stageName = entry?.stage?.trim() ?? "";
	const stageCode = entry?.error_code?.trim() ?? "";
	const code = stageCode || (entry?.status === "FAILED" || !entry ? error?.trim() ?? "" : "");
	if (code) {
		const mapped = stageErrorCopy(stageName, code);
		if (mapped) return mapped;
		if (stageName) return stageFallback(stageName);
		return status === "PARTIAL" ? "这次分析只完成了一部分。" : "这次分析没有完成。";
	}
	if (stageName && status === "FAILED") return stageFallback(stageName);
	return status === "PARTIAL" ? "这次分析只完成了一部分。" : "这次分析没有完成。";
}

/**
 * 「这次没有候选供应商」 only when a finished analysis actually has none.
 * A later stage that failed does not make an empty table mean zero candidates.
 * A research code that means zero candidates is said by `pipelineProblemLine` instead.
 */
export function showNoCandidateLine(input: {
	pipelineStatus: string | null;
	runStatus: string | null;
	analysisLoaded: boolean;
	candidateCount: number;
}): boolean {
	const finished =
		input.pipelineStatus === "COMPLETED" ||
		input.pipelineStatus === "PARTIAL" ||
		(input.pipelineStatus == null && (input.runStatus === "COMPLETED" || input.runStatus === "PARTIAL"));
	return finished && input.analysisLoaded && input.candidateCount === 0;
}
