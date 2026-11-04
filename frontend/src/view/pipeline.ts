import { publicReason } from "../api/adapter";
import type { PipelineStage } from "../api/types";

const STAGE_LINES: Record<string, string> = {
	RESEARCH: "正在寻找供应商",
	RESEARCHING: "正在寻找供应商",
	EVALUATING: "正在核对技术与价格",
	DECIDING: "正在整理采购建议",
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

/** A short Chinese line from the public code. Raw error text is never returned. */
export function pipelineProblemLine(status: string, error: string | null, stages: Pick<PipelineStage, "error_code">[]): string | null {
	if (status !== "PARTIAL" && status !== "FAILED") return null;
	// The stage keeps the reason. The top level code is the same for every
	// failure, so the stage code comes first.
	const codes = [...stages.map((stage) => stage.error_code), error].filter((code): code is string => Boolean(code));
	for (const code of codes) {
		const known = publicReason(code);
		if (known) return known;
	}
	return status === "PARTIAL" ? "这次分析只完成了一部分。" : "这次分析没有完成。";
}
