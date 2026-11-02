const PIPELINE_LABELS: Record<string, string> = {
	RESEARCH: "正在寻找供应商",
	RESEARCHING: "正在寻找供应商",
	EVALUATING: "正在核对技术与价格",
	DECIDING: "正在整理采购建议",
	COMPLETED: "已完成",
	PARTIAL: "需要处理",
	FAILED: "需要处理",
};

/**
 * User-facing progress. A followed pipeline wins.
 * B1 `COMPLETED` means the analysis finished. It is not a report, and this map has no report stage.
 */
export function userProgress(input: {
	pipelineStatus?: string | null;
	runStatus: string | null;
	specActive: boolean;
	decisionActive: boolean;
	reportActive: boolean;
	attention: boolean;
	done: boolean;
}): string | null {
	const pipeline = input.pipelineStatus ? PIPELINE_LABELS[input.pipelineStatus] : undefined;
	if (pipeline) return pipeline;
	if (input.reportActive) return "正在生成报告";
	if (input.attention) return "需要处理";
	if (input.decisionActive) return "正在整理采购建议";
	if (input.specActive) return "正在核对技术与价格";
	if (input.runStatus === "QUEUED" || input.runStatus === "RUNNING") return "正在寻找供应商";
	if (input.done) return "已完成";
	return null;
}
