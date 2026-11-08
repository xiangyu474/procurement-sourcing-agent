import type { Env, ReportRequest } from "./index";
import { sha256 } from "./pipeline_store.ts";

interface Pipeline { id: string; project_id: string; run_id: string; status: string; decision_version: string | null }
interface Report { id: string; project_id: string; run_id: string; pipeline_id: string; decision_version: string;
	status: string; workflow_id: string; attempt: number; r2_key: string | null; sha256: string | null }
export type ReportStart = { kind: "NOT_FOUND" | "DECISION_UNAVAILABLE" | "REPORT_START_FAILED" } |
	{ kind: "OK"; reportId: string; status: string; decisionVersion: string };

/** Start/recover a report attempt without ever restarting M2/M3. */
export async function startPipelineReport(env: Env, projectId: string, pipelineId: string): Promise<ReportStart> {
	const pipeline = await env.DB.prepare("SELECT id, project_id, run_id, status, decision_version FROM project_pipelines WHERE id = ?1 AND project_id = ?2")
		.bind(pipelineId, projectId).first<Pipeline>();
	if (!pipeline) return { kind: "NOT_FOUND" };
	const version = pipeline.decision_version;
	if (!version || !/^[a-f0-9]{64}$/.test(version) || !["COMPLETED", "PARTIAL"].includes(pipeline.status)) return { kind: "DECISION_UNAVAILABLE" };
	const snapshot = await env.DB.prepare("SELECT payload_json, sha256 FROM pipeline_snapshots WHERE pipeline_id = ?1 AND snapshot_type = 'FINAL_CONTEXT'")
		.bind(pipelineId).first<{ payload_json: string; sha256: string }>();
	if (!snapshot || snapshot.sha256 !== version || await sha256(snapshot.payload_json) !== version) return { kind: "DECISION_UNAVAILABLE" };
	const final = JSON.parse(snapshot.payload_json) as {
		project_id?: string; pipeline_id?: string; run_id?: string;
		decisions?: { accepted?: boolean }[]; candidates?: unknown[]; price_contexts?: unknown[];
	};
	// A report is written whenever the run produced an answer. A run that found
	// no passing candidate still has something to report: what was searched,
	// what the sources said, and what is still missing.
	const answered = Boolean(final.decisions?.length || final.candidates?.length || final.price_contexts?.length);
	if (final.project_id !== projectId || final.pipeline_id !== pipelineId || final.run_id !== pipeline.run_id || !answered) {
		return { kind: "DECISION_UNAVAILABLE" };
	}
	const now = new Date().toISOString();
	const reportId = `pr_${pipelineId}`;
	const workflowId = `report_${crypto.randomUUID().replaceAll("-", "")}`;
	await env.DB.prepare(`INSERT INTO project_reports
		(id, workspace_id, project_id, run_id, decision_version, status, pipeline_id, workflow_id, attempt, created_at, updated_at)
		VALUES (?1, 'default', ?2, ?3, ?4, 'QUEUED', ?5, ?6, 1, ?7, ?7) ON CONFLICT DO NOTHING`)
		.bind(reportId, projectId, pipeline.run_id, version, pipelineId, workflowId, now).run();
	const query = () => env.DB.prepare("SELECT id, project_id, run_id, pipeline_id, decision_version, status, workflow_id, attempt, r2_key, sha256 FROM project_reports WHERE pipeline_id = ?1 AND decision_version = ?2")
		.bind(pipelineId, version).first<Report>();
	let row = await query();
	if (!row) return { kind: "REPORT_START_FAILED" };
	if (row.status === "COMPLETED") {
		const object = row.r2_key ? await env.BUCKET.head(row.r2_key) : null;
		if (object && object.customMetadata?.sha256 === row.sha256 && object.customMetadata?.decision_version === version) {
			await env.DB.prepare("UPDATE project_pipelines SET report_id = ?2, report_status = 'COMPLETED', report_error_code = NULL, updated_at = ?3 WHERE id = ?1")
				.bind(pipelineId, row.id, now).run();
			return { kind: "OK", reportId: row.id, status: row.status, decisionVersion: version };
		}
		await env.DB.prepare("UPDATE project_reports SET status = 'FAILED', error = 'REPORT_ARTIFACT_MISSING', updated_at = ?2 WHERE id = ?1 AND status = 'COMPLETED'")
			.bind(row.id, now).run();
		row = await query();
		if (!row) return { kind: "REPORT_START_FAILED" };
	}
	if (row.status === "RUNNING") {
		const state = await (await env.REPORT_WORKFLOW.get(row.workflow_id)).status();
		if (["errored", "terminated", "complete"].includes(state.status)) {
			await env.DB.prepare("UPDATE project_reports SET status = 'FAILED', error = 'REPORT_WORKFLOW_ENDED', updated_at = ?3 WHERE id = ?1 AND workflow_id = ?2 AND status = 'RUNNING'")
				.bind(row.id, row.workflow_id, now).run();
			row = await query();
			if (!row) return { kind: "REPORT_START_FAILED" };
		}
	}
	if (row.status === "FAILED") {
		const next = `report_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare("UPDATE project_reports SET status = 'QUEUED', workflow_id = ?2, attempt = attempt + 1, error = NULL, updated_at = ?3 WHERE id = ?1 AND status = 'FAILED'")
			.bind(row.id, next, now).run();
		row = await query();
		if (!row) return { kind: "REPORT_START_FAILED" };
	}
	if (row.status === "QUEUED") {
		await env.DB.prepare("UPDATE project_pipelines SET report_id = ?2, report_status = 'QUEUED', report_error_code = NULL, updated_at = ?3 WHERE id = ?1")
			.bind(pipelineId, row.id, now).run();
		const params: ReportRequest = { projectId, runId: pipeline.run_id, reportId: row.id, pipelineId, decisionVersion: version, workflowId: row.workflow_id };
		try { await env.REPORT_WORKFLOW.create({ id: row.workflow_id, params }); }
		catch {
			try {
				const state = await (await env.REPORT_WORKFLOW.get(row.workflow_id)).status();
				if (["errored", "terminated", "complete"].includes(state.status)) {
					const current = await query();
					if (current?.status === "QUEUED") throw new Error("REPORT_WORKFLOW_ENDED_WITHOUT_RESULT");
				}
			}
			catch {
				await env.DB.prepare("UPDATE project_reports SET status = 'FAILED', error = 'REPORT_START_FAILED', updated_at = ?3 WHERE id = ?1 AND workflow_id = ?2 AND status = 'QUEUED'")
					.bind(row.id, row.workflow_id, new Date().toISOString()).run();
				await env.DB.prepare("UPDATE project_pipelines SET report_status = 'FAILED', report_error_code = 'REPORT_START_FAILED', updated_at = ?2 WHERE id = ?1 AND report_id = ?3 AND EXISTS (SELECT 1 FROM project_reports WHERE id = ?3 AND workflow_id = ?4 AND status = 'FAILED')")
					.bind(pipelineId, new Date().toISOString(), row.id, row.workflow_id).run();
				return { kind: "REPORT_START_FAILED" };
			}
		}
	}
	return { kind: "OK", reportId: row.id, status: row.status, decisionVersion: version };
}
