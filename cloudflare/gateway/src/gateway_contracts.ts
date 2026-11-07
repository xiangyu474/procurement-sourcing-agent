/**
 * The contracts of the gateway routes that the frontend depends on.
 *
 * The routes themselves live in one large file. The parts that can be wrong
 * without a browser are pulled out here: the check of the credentials, the
 * SQL with its parameters, the shape of the answers, and the way a database
 * error is turned into an answer. Those parts are covered by tests that run
 * without a Cloudflare account.
 */

export interface EnvLike {
	DEMO_ACCESS_TOKEN?: string;
	INTERNAL_GATEWAY_TOKEN?: string;
}

/** The answer the gateway gives when something is wrong. */
export function errorJson(error: string, status = 400): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** The answer the gateway gives when something is right. */
export function okJson(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Check the credentials of a public route.
 *
 * A public route needs the bearer token. A gateway without the token
 * configured says so instead of pretending that the request was authorized.
 */
export function checkPublicAuth(request: Request, env: EnvLike): Response | null {
	const expected = env.DEMO_ACCESS_TOKEN;
	if (!expected) return errorJson("demo_access_not_configured", 503);
	if (request.headers.get("authorization") !== `Bearer ${expected}`) {
		return errorJson("unauthorized", 401);
	}
	return null;
}

/**
 * Check the credentials of an internal route.
 *
 * The internal routes are called by the container, which holds the internal
 * token. They are never reachable with the public token.
 */
export function checkInternalAuth(request: Request, env: EnvLike): Response | null {
	const expected = env.INTERNAL_GATEWAY_TOKEN;
	const token = request.headers.get("x-internal-token");
	if (!expected || !token || token !== expected) return errorJson("unauthorized", 401);
	return null;
}

/** Count the placeholders of a statement, so that a bind can be checked. */
export function placeholderCount(statement: string): number {
	const matches = statement.match(/\?\d+/g);
	return matches ? matches.length : 0;
}

/** The projects of the workspace, with the run that finished last. */
export const projectsListSql = `
	SELECT p.id, p.title, p.history_availability, p.demand_revision, p.analysis_version,
	       p.created_at,
	       (SELECT r.id FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_id,
	       (SELECT r.status FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_status,
	       (SELECT r.current_stage FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_stage,
	       (SELECT r.updated_at FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_updated_at
	FROM projects p
	ORDER BY p.created_at DESC LIMIT ?1 OFFSET ?3`;

/** The same list restricted to a visitor, excluding legacy unowned projects. */
export const guestProjectsListSql = projectsListSql.replace(
	"FROM projects p",
	"FROM projects p WHERE p.session_id = ?2",
);

/** The runs of one project. */
export const projectRunsSql = `
	SELECT r.id, r.status, r.current_stage, r.last_error, r.artifact_key, r.created_at, r.updated_at,
	       (SELECT c.stop_reason_code FROM research_run_costs c WHERE c.run_id = r.id) AS stop_reason_code
	FROM runs r
	WHERE r.project_id = ?1
	ORDER BY r.created_at DESC LIMIT 100`;

/** The text of the latest demand revision of a project. */
export const requirementTextSql = `
	SELECT id, revision, text_content FROM source_inputs
	WHERE project_id = ?1 AND purpose = 'REQUIREMENT' AND source_type = 'USER_TEXT'
	ORDER BY revision DESC LIMIT 1`;

/** The state of one demand compilation. */
export const compileStatusSql = `
	SELECT id, job_type, status, error, detail_json, created_at, updated_at
	FROM project_jobs
	WHERE workspace_id = 'default' AND project_id = ?1 AND id = ?2 AND job_type = 'COMPILE'`;

/** The state of the technical check or of the decision. */
export const jobStatusSql = `
	SELECT id, status, error, detail_json, created_at, updated_at
	FROM project_jobs
	WHERE workspace_id = 'default' AND project_id = ?1 AND job_type = ?2
	ORDER BY created_at DESC LIMIT 1`;

/** The reports of one project. */
export const reportsListSql = `
	SELECT id, run_id, pipeline_id, status, decision_version, byte_size, sha256, error, created_at, updated_at
	FROM project_reports
	WHERE workspace_id = 'default' AND project_id = ?1
	ORDER BY created_at DESC LIMIT 100`;

/** One report. */
export const reportStatusSql = `
	SELECT id, run_id, pipeline_id, status, decision_version, byte_size, sha256, error, created_at, updated_at
	FROM project_reports
	WHERE workspace_id = 'default' AND project_id = ?1 AND id = ?2`;

/** The newest judgement of every requirement and candidate. */
export const reportAssessmentsSql = `
	SELECT s.requirement_id, s.product_candidate_id, s.product_model_ref,
	       s.hard_spec_overall, s.overall_reason_codes_json, s.assessment_json,
	       s.judgment_version, s.evaluated_at
	FROM spec_assessments s
	WHERE s.workspace_id = 'default' AND s.project_id = ?1
	  AND s.judgment_version = (
	    SELECT MAX(inner_s.judgment_version) FROM spec_assessments inner_s
	    WHERE inner_s.workspace_id = s.workspace_id AND inner_s.project_id = s.project_id
	      AND inner_s.requirement_id = s.requirement_id
	      AND inner_s.product_candidate_id = s.product_candidate_id
	      AND inner_s.demand_revision = s.demand_revision)
	ORDER BY s.requirement_id, s.product_candidate_id`;

/** The candidates of one project, with their supplier and their model. */
export const reportCandidatesSql = `
	SELECT c.id AS candidate_id, c.requirement_id, c.stage, c.rationale,
	       c.open_questions_json, s.display_name AS supplier_name,
	       p.model AS product_model, p.product_name,
	       (SELECT group_concat(e.evidence_id) FROM project_candidate_evidence e
	        WHERE e.workspace_id = c.workspace_id AND e.candidate_id = c.id) AS evidence_ids
	FROM project_candidates c
	LEFT JOIN intelligence_suppliers s ON s.workspace_id = c.workspace_id AND s.id = c.supplier_id
	LEFT JOIN intelligence_products p ON p.workspace_id = c.workspace_id AND p.id = c.product_id
	WHERE c.workspace_id = 'default' AND c.project_id = ?1
	ORDER BY c.updated_at DESC LIMIT 600`;

/** The shape of one project in the project list. */
export function shapeProject(row: Record<string, unknown>): Record<string, unknown> {
	return {
		id: row.id,
		title: row.title,
		// A sample is a finished run handed over for reading. Starting another
		// research from it would cost model calls and may not answer the same
		// question, so the page does not offer it.
		is_sample: typeof row.title === "string" && row.title.startsWith("示例："),
		history_availability: row.history_availability,
		demand_revision: row.demand_revision,
		analysis_version: row.analysis_version,
		created_at: row.created_at,
		latest_run: row.run_id
			? {
					id: row.run_id,
					status: row.run_status,
					current_stage: row.run_stage,
					updated_at: row.run_updated_at,
				}
			: null,
	};
}

/** The shape of one run in the run list. */
export function shapeRun(row: Record<string, unknown>): Record<string, unknown> {
	return {
		id: row.id,
		status: row.status,
		current_stage: row.current_stage,
		last_error: row.last_error,
		stop_reason_code: row.stop_reason_code,
		artifact_key_present: Boolean(row.artifact_key),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/** The shape of one report. */
export function shapeReport(
	row: Record<string, unknown>,
	projectId: string,
): Record<string, unknown> {
	return {
		report_id: row.id,
		run_id: row.run_id,
		pipeline_id: row.pipeline_id ?? null,
		status: row.status,
		decision_version: row.decision_version,
		byte_size: row.byte_size,
		sha256: row.sha256,
		error: row.error ? "报告生成失败，请重试。" : null,
		error_code: row.error ? "REPORT_GENERATION_FAILED" : null,
		download_path: row.status === "COMPLETED" ? `/api/projects/${projectId}/reports/${String(row.id)}/download` : null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/** The shape of the state of a long task. */
export function shapeJobStatus(
	row: Record<string, unknown> | null,
	demandRevision: number | null,
): Record<string, unknown> {
	if (!row) {
		return { status: "IDLE", job_id: null, demand_revision: demandRevision, error: null };
	}
	let detail: Record<string, unknown> = {};
	try {
		detail = JSON.parse(String(row.detail_json ?? "{}")) as Record<string, unknown>;
	} catch {
		detail = {};
	}
	return {
		status: row.status,
		job_id: row.id,
		demand_revision: demandRevision,
		error: row.error,
		detail,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/**
 * Run a statement and turn a database error into an answer.
 *
 * The message of the database is not returned to the client: it can carry
 * details of the schema. The error is logged on the server and the client
 * gets a short code.
 */
export async function runQuery<T>(
	statement: { bind: (...values: unknown[]) => { first: <R>() => Promise<R | null>; all: <R>() => Promise<{ results: R[] }> } },
	values: unknown[],
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
	try {
		const bound = statement.bind(...values);
		const result = await bound.all<T>();
		return { ok: true, rows: result.results };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error("the gateway query failed", message);
		return { ok: false, error: "database_error" };
	}
}
