// Persistence primitives for the protected M4 pipeline. This module does not
// start work: the coordinator and version-bound consumers are not ready yet.
export interface PipelineReservation {
	projectId: string;
	pipelineId: string;
	runId: string;
	idempotencyKey: string;
	requestHash: string;
	demandRevision: number;
	demandJson: string;
}

export interface ReservedPipeline {
	id: string;
	project_id: string;
	run_id: string;
	demand_revision: number;
	status: string;
	idempotency_key: string;
	request_hash: string;
	demand_snapshot_sha256: string;
}

export type ReservationResult =
	| { kind: "CREATED" | "REUSED"; pipeline: ReservedPipeline }
	| { kind: "IDEMPOTENCY_CONFLICT" | "INPUT_CHANGED" };

export async function sha256(value: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
	return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reserve the same business task at most once for a project and client key.
 * The single INSERT also tests that the requested revision and exact compiled
 * input are still current; a concurrent edit cannot silently change the input.
 */
export async function reservePipeline(db: D1Database, input: PipelineReservation): Promise<ReservationResult> {
	if (!input.idempotencyKey || input.idempotencyKey.length > 200 || !/^[\x21-\x7e]+$/.test(input.idempotencyKey)) {
		throw new Error("invalid_idempotency_key");
	}
	const now = new Date().toISOString();
	const digest = await sha256(input.demandJson);
	const result = await db.prepare(`INSERT INTO project_pipelines
		(id, workspace_id, project_id, run_id, demand_revision, status, stage, stages_json,
		 created_at, updated_at, idempotency_key, request_hash, demand_snapshot_json, demand_snapshot_sha256,
		 history_dataset_id, history_r2_key, history_content_sha256)
		SELECT ?1, 'default', p.id, ?2, ?3, 'QUEUED', 'QUEUED', '{}', ?4, ?4, ?5, ?6, c.compilation_json, ?7,
		 h.id, h.normalized_r2_key, h.content_sha256
		FROM projects p JOIN demand_compilations c ON c.project_id = p.id AND c.demand_revision = ?3
		LEFT JOIN history_datasets h ON h.id = (SELECT hh.id FROM history_datasets hh WHERE hh.project_id = p.id ORDER BY hh.imported_at DESC, hh.id DESC LIMIT 1)
		WHERE p.id = ?8 AND p.demand_revision = ?3 AND c.compilation_json = ?9
		ON CONFLICT DO NOTHING`)
		.bind(input.pipelineId, input.runId, input.demandRevision, now, input.idempotencyKey,
			input.requestHash, digest, input.projectId, input.demandJson).run();
	const row = await db.prepare(`SELECT id, project_id, run_id, demand_revision, status,
		idempotency_key, request_hash, demand_snapshot_sha256 FROM project_pipelines
		WHERE workspace_id = 'default' AND project_id = ?1 AND idempotency_key = ?2`)
		.bind(input.projectId, input.idempotencyKey).first<ReservedPipeline>();
	if (!row) return { kind: "INPUT_CHANGED" };
	if (row.request_hash !== input.requestHash) return { kind: "IDEMPOTENCY_CONFLICT" };
	return { kind: result.meta.changes === 1 ? "CREATED" : "REUSED", pipeline: row };
}

/** Load only the exact demand frozen for this project and sourcing run. */
export async function readPipelineDemand(
	db: D1Database, pipelineId: string, projectId: string, runId: string,
): Promise<{ demand_revision: number; compilation_json: string } | null> {
	const row = await db.prepare(`SELECT demand_revision, demand_snapshot_json, demand_snapshot_sha256
		FROM project_pipelines WHERE id = ?1 AND project_id = ?2 AND run_id = ?3`)
		.bind(pipelineId, projectId, runId).first<{
			demand_revision: number; demand_snapshot_json: string | null; demand_snapshot_sha256: string | null;
		}>();
	if (!row || row.demand_snapshot_json === null || !row.demand_snapshot_sha256) return null;
	if (await sha256(row.demand_snapshot_json) !== row.demand_snapshot_sha256) throw new Error("pipeline_demand_integrity_error");
	return { demand_revision: row.demand_revision, compilation_json: row.demand_snapshot_json };
}

export type SnapshotResult = "CREATED" | "REUSED" | "CONFLICT";

/** First write wins; never replace the inputs of a completed or retried step. */
export async function storePipelineSnapshot(
	db: D1Database, pipelineId: string, snapshotType: string, payload: string,
): Promise<SnapshotResult> {
	if (!/^[A-Z_]{1,60}$/.test(snapshotType)) throw new Error("invalid_snapshot_type");
	if (new TextEncoder().encode(payload).byteLength > 2_500_000) throw new Error("snapshot_too_large");
	// Reject malformed snapshots before they become immutable.
	JSON.parse(payload);
	const hash = await sha256(payload);
	const inserted = await db.prepare(`INSERT INTO pipeline_snapshots
		(pipeline_id, snapshot_type, payload_json, sha256, created_at)
		SELECT id, ?2, ?3, ?4, ?5 FROM project_pipelines WHERE id = ?1
		ON CONFLICT DO NOTHING`)
		.bind(pipelineId, snapshotType, payload, hash, new Date().toISOString()).run();
	const row = await db.prepare(`SELECT sha256 FROM pipeline_snapshots
		WHERE pipeline_id = ?1 AND snapshot_type = ?2`).bind(pipelineId, snapshotType)
		.first<{ sha256: string }>();
	if (!row) throw new Error("pipeline_not_found");
	if (row.sha256 !== hash) return "CONFLICT";
	return inserted.meta.changes === 1 ? "CREATED" : "REUSED";
}

export type StageStatus = "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";

/** Terminal stage states cannot be overwritten by a duplicate Workflow step. */
export async function recordPipelineStage(
	db: D1Database, pipelineId: string, stage: string, status: StageStatus, errorCode: string | null = null,
): Promise<boolean> {
	if (!/^[A-Z_]{1,60}$/.test(stage) || (errorCode && !/^[A-Z_]{1,80}$/.test(errorCode))) {
		throw new Error("invalid_stage");
	}
	const now = new Date().toISOString();
	const terminal = status !== "RUNNING";
	const result = await db.prepare(`INSERT INTO pipeline_stages
		(pipeline_id, stage, status, started_at, finished_at, error_code)
		SELECT id, ?2, ?3, ?4, ?5, ?6 FROM project_pipelines WHERE id = ?1
		ON CONFLICT(pipeline_id, stage) DO UPDATE SET
		 status = excluded.status, finished_at = excluded.finished_at, error_code = excluded.error_code
		WHERE pipeline_stages.status = 'RUNNING' AND excluded.status <> 'RUNNING'`)
		.bind(pipelineId, stage, status, now, terminal ? now : null, errorCode).run();
	return result.meta.changes === 1;
}
