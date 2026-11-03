// Guest-safe projections. Internal diagnostics remain stored for trusted
// operators, but raw exceptions, role names and storage keys do not reach a
// visitor's browser.
type Row = Record<string, unknown>;
const SAFE_STAGES = new Set(["QUEUED", "RUNNING", "INGESTING", "ANALYZING", "WEB_RESEARCH", "MATCHING", "VALIDATING", "REPORTING", "COMPLETED", "PARTIAL", "FAILED"]);
const SAFE_REASONS = new Set(["BUDGET_EXHAUSTED", "MODEL_TIMEOUT", "MODEL_RATE_LIMIT", "SEARCH_PROVIDER_TIMEOUT", "SEARCH_PROVIDER_RATE_LIMITED", "RESEARCH_EXECUTION_FAILED", "RESEARCH_FAILED", "INVALID_RESEARCH_INPUT", "RESEARCH_INPUT_REJECTED", "NO_FETCHED_EVIDENCE", "NO_SOURCE_BACKED_CANDIDATES", "SOURCE_FETCH_FAILED"]);
const TEXT: Record<string, string> = {
	QUEUED: "任务正在排队。", RUNNING: "任务进行中。", INGESTING: "正在读取需求。",
	ANALYZING: "正在整理资料。", WEB_RESEARCH: "正在查阅公开资料。",
	MATCHING: "正在核对条件。", VALIDATING: "正在复核结果。", REPORTING: "正在生成报告。",
	COMPLETED: "任务已结束。", PARTIAL: "任务部分完成。", FAILED: "任务未能完成。",
};

export function guestStage(value: unknown, fallback: unknown = "RUNNING"): string {
	const stage = typeof value === "string" ? value.replace(/^(?:SUPERVISOR|RESEARCHER):\s*/i, "").toUpperCase() : "";
	if (stage === "INTERNAL_ANALYSIS") return "ANALYZING";
	if (SAFE_STAGES.has(stage)) return stage;
	return typeof fallback === "string" && SAFE_STAGES.has(fallback) ? fallback : "RUNNING";
}

export function guestStopReason(value: unknown): string | null {
	if (!value) return null;
	if (value === "SUPERVISOR_RESEARCHER_ERROR") return "RESEARCH_EXECUTION_FAILED";
	return typeof value === "string" && SAFE_REASONS.has(value) ? value : "RESEARCH_INCOMPLETE";
}

export function guestRun(value: object): Row {
	const row = value as Row;
	return { id: row.id, project_id: row.project_id, status: row.status,
		current_stage: guestStage(row.current_stage, row.status), artifact_key: null,
		last_error: row.status === "FAILED" ? "RESEARCH_EXECUTION_FAILED" : null,
		created_at: row.created_at, updated_at: row.updated_at };
}

export function guestRunSummary(row: Row): Row {
	return { id: row.id, status: row.status, current_stage: guestStage(row.current_stage, row.status),
		last_error: row.status === "FAILED" ? "RESEARCH_EXECUTION_FAILED" : null,
		stop_reason_code: guestStopReason(row.stop_reason_code), artifact_key_present: Boolean(row.artifact_key_present),
		created_at: row.created_at, updated_at: row.updated_at };
}

export function guestEvent(row: Row): Row {
	const stage = guestStage(row.stage);
	return { stage, display_text: TEXT[stage] ?? TEXT.RUNNING, created_at: row.created_at };
}
