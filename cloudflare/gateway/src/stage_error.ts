// The reason a pipeline stage failed, in a form a buyer and a client can read.
// Only a known code leaves the Worker; an exception text never does.

/** Reason codes that may leave the Worker. Nothing else is published. */
export const SAFE_STAGE_CODES = new Set([
	"STAGE_SERVICE_ERROR", "MODEL_TIMEOUT", "MODEL_RATE_LIMIT", "DECISION_FAILED", "SPEC_EVALUATION_FAILED",
	"RESEARCH_EXECUTION_FAILED", "RESEARCH_FAILED", "RESEARCH_TIMEOUT", "NO_ASSESSMENTS", "NO_DECISIONS",
	"SNAPSHOT_MISSING", "SNAPSHOT_CONFLICT", "SNAPSHOT_INTEGRITY_ERROR", "NO_CANDIDATES", "TOO_MANY_CANDIDATES",
	"SPEC_CONTEXT_FAILED", "SPEC_CONTEXT_INVALID", "PIPELINE_NOT_FOUND", "HISTORY_SNAPSHOT_MISSING",
	"HISTORY_SNAPSHOT_INVALID", "INVALID_RESEARCH_INPUT", "RESEARCH_INPUT_REJECTED",
]);

/** The container states its own reason; only a known code is carried out. */
export function containerReasonCode(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { detail?: { reason_code?: unknown } };
		const code = parsed?.detail?.reason_code;
		return typeof code === "string" && SAFE_STAGE_CODES.has(code) ? code : null;
	} catch { return null; }
}

/** The public failure reason of a stage, never an exception text. */
export function stageErrorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? "");
	const head = message.split(":")[0]?.trim() ?? "";
	if (SAFE_STAGE_CODES.has(head)) return head;
	return "PIPELINE_STAGE_FAILED";
}
