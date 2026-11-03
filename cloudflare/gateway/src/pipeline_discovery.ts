// The public route calls this after its authentication middleware. Ownership is
// checked again here so a future routing change cannot widen guest visibility.
function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

export async function listProjectPipelines(
	request: Request, db: D1Database, projectId: string, guestSessionId: string | null,
): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const rawLimit = params.get("limit");
	if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)) {
		return answer({ error: "invalid_limit" }, 400);
	}
	const limit = rawLimit === null ? 20 : Number(rawLimit);
	const active = params.get("active");
	if (active !== null && active !== "true" && active !== "false") return answer({ error: "invalid_active_filter" }, 400);
	try {
		const project = db.prepare(
			guestSessionId
				? "SELECT id FROM projects WHERE id = ?1 AND session_id = ?2"
				: "SELECT id FROM projects WHERE id = ?1",
		);
		const owner = await (guestSessionId ? project.bind(projectId, guestSessionId) : project.bind(projectId)).first<{ id: string }>();
		if (!owner) return answer({ error: "not_found" }, 404);
		const { results } = await db.prepare(`SELECT id, run_id, demand_revision, status, stage,
			decision_version, report_id, report_status, created_at, updated_at
			FROM project_pipelines WHERE workspace_id = 'default' AND project_id = ?1
			AND (?2 = 0 OR status IN ('QUEUED', 'RUNNING') OR report_status IN ('QUEUED', 'RUNNING'))
			ORDER BY created_at DESC, id DESC LIMIT ?3`)
			.bind(projectId, active === "true" ? 1 : 0, limit + 1).all<Record<string, unknown>>();
		return answer({
			project_id: projectId,
			pipelines: results.slice(0, limit).map(row => ({
				pipeline_id: row.id, run_id: row.run_id, demand_revision: row.demand_revision,
				status: row.status, stage: row.stage, decision_version: row.decision_version,
				report_id: row.report_id, report_status: row.report_status,
				created_at: row.created_at, updated_at: row.updated_at,
			})),
			has_more: results.length > limit,
		});
	} catch (error) {
		console.error("pipeline list query failed", error instanceof Error ? error.name : "unknown");
		return answer({ error: "database_unavailable" }, 503);
	}
}
