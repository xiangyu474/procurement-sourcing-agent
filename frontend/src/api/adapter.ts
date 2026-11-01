import { ApiError, type RequirementsDocument } from "./types";

export type CompileView =
	| { phase: "pending" }
	| { phase: "failed"; issues: string[] }
	| { phase: "ready"; requirementCount: number; unstructuredCount: number };

export type UiError = {
	summary: string;
	technical?: string;
};

const STAGE_LABELS: Record<string, string> = {
	QUEUED: "排队",
	RUNNING: "进行中",
	INGESTING: "读取需求",
	INTERNAL_ANALYSIS: "整理资料",
	WEB_RESEARCH: "查阅公开资料",
	MATCHING: "核对条件",
	VALIDATING: "复核",
	REPORTING: "生成报告",
	PARTIAL: "部分完成",
	FAILED: "未能完成",
	COMPLETED: "已结束",
};

const REASONS: Record<string, string> = {
	BUDGET_EXHAUSTED: "本次公开查阅的次数已用完。",
	MODEL_TIMEOUT: "分析超时。",
	MODEL_RATE_LIMIT: "分析服务繁忙，请稍后再试。",
	SEARCH_PROVIDER_TIMEOUT: "公开检索超时。",
	SEARCH_PROVIDER_RATE_LIMITED: "公开检索过于频繁，请稍后再试。",
	RESEARCH_EXECUTION_FAILED: "寻源过程中断。",
	RESEARCH_FAILED: "寻源没有完成。",
	INVALID_RESEARCH_INPUT: "当前需求无法开始寻源。",
	RESEARCH_INPUT_REJECTED: "有一条资料地址被拒绝。",
	NO_FETCHED_EVIDENCE: "没有读到可用的公开资料。",
	SOURCE_FETCH_FAILED: "有的公开页面没有读出来。",
	RESEARCHER_FINDINGS_INCOMPLETE: "有一部分公开资料没有形成可用记录。",
	demand_not_compiled: "需求还没有整理完成。",
	structured_requirement_required_for_m2: "没有整理出可以寻源的采购条目。",
	no_recognizable_demand: "没有识别出采购需求。",
	unauthorized: "访问被拒绝。",
	demo_access_not_configured: "服务没有配置访问凭证。",
	requirement_text_required: "请填写需求文字。",
	requirement_text_too_large: "需求文字超过长度限制。",
	unsupported_file_for_purpose: "文件类型不符合要求。需求请用 PPTX，历史数据请用 XLSX。",
	file_size_out_of_range: "文件不能为空，且不能超过 32MB。",
	purpose_and_file_required: "请选择文件。",
	"at least one demand source (text or PPTX) is required": "请先填写需求或上传 PPTX。",
	history_source_not_found: "没有找到已上传的历史文件。",
	history_import_failed: "历史数据导入失败。",
	not_found: "没有找到对应的记录。",
	not_compiled: "需求还没有整理完成。",
};

export function stageLabel(stage: string): string {
	return STAGE_LABELS[stage] ?? "处理中";
}

export function runStatusLabel(status: string, stage: string): string {
	if (status === "QUEUED") return "排队中";
	if (status === "RUNNING") return stageLabel(stage);
	if (status === "COMPLETED") return "寻源已结束";
	if (status === "PARTIAL") return "部分完成";
	if (status === "FAILED") return "未能完成";
	return "处理中";
}

export function listStatus(runStatus: string | null, activity: "compiling" | null): string {
	if (activity === "compiling") return "整理需求";
	if (!runStatus) return "未开始";
	if (runStatus === "QUEUED" || runStatus === "RUNNING") return "进行中";
	if (runStatus === "PARTIAL") return "部分完成";
	if (runStatus === "FAILED") return "未完成";
	if (runStatus === "COMPLETED") return "已结束";
	return "处理中";
}

export function sanitizePublicText(text: string): string {
	let value = text.replace(/Bearer\s+\S+/gi, "");
	value = value.replace(/\b(?:sk|tvly|gens)-[A-Za-z0-9_-]+\b/gi, "");
	const replacements: Array<[RegExp, string]> = [
		[/SourcingSupervisor/g, "寻源流程"],
		[/SupplierResearcher/g, "资料查阅"],
		[/SourcingPlan/g, "寻源计划"],
		[/Supervisor/g, "寻源流程"],
		[/Researcher/g, "资料查阅"],
		[/\bDSL\b/g, "需求"],
		[/\btokens?\b/gi, ""],
		[/Tavily/g, "公开检索"],
		[/LangSmith/g, ""],
	];
	for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);
	return value.replace(/[ \t]{2,}/g, " ").trim();
}

function isMachineCode(value: string): boolean {
	return /^[A-Za-z0-9_]+$/.test(value);
}

export function explainRun(input: { status: string; lastError: string | null; stopReason: string | null }): string | null {
	if (input.status !== "PARTIAL" && input.status !== "FAILED") return null;
	const mapped =
		(input.stopReason ? REASONS[input.stopReason] : undefined) ??
		(input.lastError ? REASONS[input.lastError] : undefined) ??
		null;
	if (input.status === "PARTIAL") {
		return mapped ? `已保留目前得到的结果。${mapped}` : "已保留目前得到的结果。";
	}
	if (mapped) return mapped;
	if (input.lastError && !isMachineCode(input.lastError)) {
		return `寻源没有完成。${sanitizePublicText(input.lastError)}`;
	}
	return "寻源没有完成。";
}

export function interpretCompilation(body: RequirementsDocument | null, expectedAnalysisVersion: number | null): CompileView {
	if (!body) return { phase: "pending" };
	if (expectedAnalysisVersion != null && body.analysis_version !== expectedAnalysisVersion) return { phase: "pending" };
	const requirements = body.compilation.requirements;
	const issuesRaw = body.compilation.issues;
	const issues = Array.isArray(issuesRaw)
		? issuesRaw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
	if (!Array.isArray(requirements)) {
		if (issues.length > 0) return { phase: "failed", issues };
		return { phase: "pending" };
	}
	const unstructured = body.compilation.unstructured_requirements;
	return {
		phase: "ready",
		requirementCount: requirements.length,
		unstructuredCount: Array.isArray(unstructured) ? unstructured.length : 0,
	};
}

export function hasDemandSource(sources: Array<{ purpose: string }>, draft: string): boolean {
	if (draft.trim()) return true;
	return sources.some((source) => source.purpose === "REQUIREMENT");
}

export function latestSource<T extends { revision: number }>(sources: T[], predicate: (source: T) => boolean): T | null {
	let best: T | null = null;
	for (const source of sources) {
		if (!predicate(source)) continue;
		if (!best || source.revision >= best.revision) best = source;
	}
	return best;
}

export function validateUpload(purpose: "REQUIREMENT" | "HISTORY", file: File): string | null {
	const extension = file.name.toLowerCase().split(".").pop();
	if (purpose === "REQUIREMENT" && extension !== "pptx") return "需求文件请使用 PPTX。";
	if (purpose === "HISTORY" && extension !== "xlsx") return "历史数据请使用 XLSX。";
	if (file.size <= 0 || file.size > 32 * 1024 * 1024) return "文件不能为空，且不能超过 32MB。";
	return null;
}

export function isAbort(error: unknown): boolean {
	return error instanceof ApiError && error.code === "aborted";
}

export function messageForApiError(error: unknown): UiError {
	if (!(error instanceof ApiError)) return { summary: "请求没有完成。" };
	if (error.code === "timeout") return { summary: "请求超时。" };
	if (error.code === "network") return { summary: "网络中断。" };
	const known = REASONS[error.code];
	const technical = technicalDetail(error.body);
	if (known) return technical ? { summary: known, technical } : { summary: known };
	if (error.status === 401) return { summary: "访问被拒绝。" };
	if (error.status === 404) return { summary: "没有找到对应的记录。" };
	if (error.status >= 500) {
		return technical ? { summary: "服务暂时不可用。", technical } : { summary: "服务暂时不可用。" };
	}
	return technical ? { summary: "请求没有被接受。", technical } : { summary: "请求没有被接受。" };
}

function technicalDetail(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const detail = (body as { detail?: unknown }).detail;
	if (typeof detail !== "string" || !detail.trim()) return undefined;
	const cleaned = sanitizePublicText(detail).slice(0, 500);
	return cleaned || undefined;
}

export function formatTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(date);
}

export function isTerminalRun(status: string): boolean {
	return status === "COMPLETED" || status === "PARTIAL" || status === "FAILED";
}
