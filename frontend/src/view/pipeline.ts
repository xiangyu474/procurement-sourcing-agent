import { isAbort, publicReason } from "../api/adapter";
import { ApiError, type PipelineStage } from "../api/types";

const STAGE_LINES: Record<string, string> = {
	RESEARCH: "正在寻找供应商",
	RESEARCHING: "正在寻找供应商",
	EVALUATING: "正在核对技术与价格",
	DECIDING: "正在整理采购建议",
};

/**
 * The line for a polled pipeline. B1 has no report stage, so a finished task says the analysis is done.
 * RESEARCH and RESEARCHING are the same step: the sample uses RESEARCH and the prose says RESEARCHING.
 */
export function pipelineProgressLine(status: string, stage: string | null): string | null {
	if (status === "COMPLETED") return "已完成";
	if (status === "PARTIAL" || status === "FAILED") return "需要处理";
	const normalized = stage?.trim().toUpperCase() ?? "";
	if (STAGE_LINES[normalized]) return STAGE_LINES[normalized];
	if (status === "QUEUED" || (status === "RUNNING" && normalized.length === 0)) return "正在寻找供应商";
	if (status === "RUNNING") return "分析进行中";
	return null;
}

/** A process-log label for one pipeline stage. This is not the run's research stage. */
export function pipelineStageLabel(stage: string): string {
	const normalized = stage.trim().toUpperCase();
	if (normalized === "RESEARCH" || normalized === "RESEARCHING") return "寻找供应商";
	if (normalized === "EVALUATING") return "核对技术与价格";
	if (normalized === "DECIDING") return "整理采购建议";
	return "分析";
}

/**
 * A pipeline poll that ended because the request was aborted or timed out is not a user-facing error.
 * The caller retries. A real abort of the parent task stops the loop.
 */
export function pipelinePollOutcome(caught: unknown, parentAborted: boolean): "stop" | "again" | "missing" | "show" {
	if (parentAborted) return "stop";
	if (caught instanceof ApiError && caught.status === 404) return "missing";
	if (isAbort(caught) || (caught instanceof ApiError && caught.code === "timeout")) return "again";
	return "show";
}

/** A short Chinese line from the public code. Raw error text is never returned. */
export function pipelineProblemLine(status: string, error: string | null, stages: Pick<PipelineStage, "error_code">[]): string | null {
	if (status !== "PARTIAL" && status !== "FAILED") return null;
	const codes = [error, ...stages.map((stage) => stage.error_code)].filter((code): code is string => Boolean(code));
	for (const code of codes) {
		const known = publicReason(code);
		if (known) return known;
	}
	return status === "PARTIAL" ? "这次分析只完成了一部分。" : "这次分析没有完成。";
}
