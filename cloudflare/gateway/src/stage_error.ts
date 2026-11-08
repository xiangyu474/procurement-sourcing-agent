// The reason a pipeline stage failed, in a form a buyer and a client can read.
// Only a known code leaves the Worker; an exception text never does.

/** Reason codes that may leave the Worker. Nothing else is published. */
export const SAFE_STAGE_CODES = new Set([
	"STAGE_SERVICE_ERROR", "MODEL_TIMEOUT", "MODEL_RATE_LIMIT", "DECISION_FAILED", "SPEC_EVALUATION_FAILED",
	"RESEARCH_EXECUTION_FAILED", "RESEARCH_FAILED", "RESEARCH_TIMEOUT", "NO_ASSESSMENTS", "NO_DECISIONS",
	"SNAPSHOT_MISSING", "SNAPSHOT_CONFLICT", "SNAPSHOT_INTEGRITY_ERROR", "TOO_MANY_CANDIDATES",
	// Every reason the frozen context can refuse, so a failed run says why.
	"SNAPSHOT_VERSION_MISMATCH", "SNAPSHOT_INVALID_IDENTIFIERS", "SNAPSHOT_CANDIDATE_MISMATCH",
	"SNAPSHOT_EVIDENCE_MISSING", "SNAPSHOT_DECISION_MISMATCH", "SNAPSHOT_VERDICT_MISMATCH",
	"SNAPSHOT_UNSAFE_PASS", "SNAPSHOT_UNSAFE_SHORTLIST", "SNAPSHOT_MISSING_DECISION",
	"SNAPSHOT_PRICE_MISMATCH", "SNAPSHOT_TOO_LARGE",
	"SPEC_CONTEXT_FAILED", "SPEC_CONTEXT_INVALID", "PIPELINE_NOT_FOUND", "HISTORY_SNAPSHOT_MISSING",
	"HISTORY_SNAPSHOT_INVALID",
	// The reasons a research stops, so the page can say why there is no candidate
	// instead of only "the research failed".
	"INVALID_RESEARCH_INPUT", "RESEARCH_INPUT_REJECTED", "BUDGET_EXHAUSTED", "NO_FETCHED_EVIDENCE",
	"NO_SOURCE_BACKED_CANDIDATES", "SOURCE_FETCH_FAILED", "SEARCH_PROVIDER_TIMEOUT",
	"SEARCH_PROVIDER_RATE_LIMITED",
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
