import { getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, RunRequest } from "./index";
import { recordPipelineStage, sha256, storePipelineSnapshot } from "./pipeline_store";
import { buildFinalContext } from "./pipeline_final";
import { startPipelineReport } from "./pipeline_report";

export interface PipelineRequest { pipelineId: string; projectId: string; runId: string }
interface PipelineRow { id: string; run_id: string; demand_revision: number; history_dataset_id: string | null; history_r2_key: string | null }
interface SpecContext { project_id: string; run_id: string; demand_revision: number; requirements: unknown[]; candidates: { evidence_ids: string[] }[] }
interface SpecResults { assessments: { assessment: unknown }[] }

async function snapshot(db: D1Database, id: string, type: string): Promise<string> {
	const row = await db.prepare("SELECT payload_json, sha256 FROM pipeline_snapshots WHERE pipeline_id = ?1 AND snapshot_type = ?2")
		.bind(id, type).first<{ payload_json: string; sha256: string }>();
	if (!row) throw new Error("SNAPSHOT_MISSING");
	if (await sha256(row.payload_json) !== row.sha256) throw new Error("SNAPSHOT_INTEGRITY_ERROR");
	return row.payload_json;
}
async function save(db: D1Database, id: string, type: string, value: unknown): Promise<void> {
	const result = await storePipelineSnapshot(db, id, type, JSON.stringify(value));
	if (result === "CONFLICT") throw new Error("SNAPSHOT_CONFLICT");
}
async function update(db: D1Database, id: string, status: string, stage: string, error: string | null = null) {
	await db.prepare("UPDATE project_pipelines SET status = ?2, stage = ?3, error = ?4, updated_at = ?5 WHERE id = ?1")
		.bind(id, status, stage, error, new Date().toISOString()).run();
}
async function callContainer(env: Env, path: string, payload: Record<string, unknown>) {
	const container = getContainer(env.SOURCING_CONTAINER, env.CONTAINER_INSTANCE_NAME);
	await container.start();
	const response = await container.fetch(new Request(`http://container${path}`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
	}));
	if (!response.ok) throw new Error("STAGE_SERVICE_ERROR");
	return await response.json() as { status?: string; assessments?: number; decisions?: number };
}
function runtime(env: Env) {
	return {
		GENESIS_BASE_URL: env.GENESIS_BASE_URL, GENESIS_ACCESS_TOKEN: env.GENESIS_ACCESS_TOKEN,
		GENESIS_MODEL_ID: env.GENESIS_MODEL_ID,
		...(env.LANGSMITH_API_KEY ? { LANGSMITH_API_KEY: env.LANGSMITH_API_KEY } : {}),
		...(env.LANGSMITH_TRACING ? { LANGSMITH_TRACING: env.LANGSMITH_TRACING } : {}),
		...(env.LANGSMITH_PROJECT ? { LANGSMITH_PROJECT: env.LANGSMITH_PROJECT } : {}),
	};
}

/** Internal/feature-gated coordinator; report generation is a separate B2. */
export class ProcurementPipelineWorkflow extends WorkflowEntrypoint<Env, PipelineRequest> {
	async run(event: WorkflowEvent<PipelineRequest>, step: WorkflowStep) {
		const { pipelineId, projectId, runId } = event.payload;
		let activeStage = "RESEARCH";
		let researchStatus = "";
		let analysisFrozen = false;
		try {
			await step.do("freeze-history-and-start-research", { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "2 minutes" }, async () => {
				const row = await this.env.DB.prepare("SELECT id, run_id, demand_revision, history_dataset_id, history_r2_key FROM project_pipelines WHERE id = ?1 AND project_id = ?2 AND run_id = ?3")
					.bind(pipelineId, projectId, runId).first<PipelineRow>();
				if (!row) throw new Error("PIPELINE_NOT_FOUND");
				const existing = await this.env.DB.prepare("SELECT sha256 FROM pipeline_snapshots WHERE pipeline_id = ?1 AND snapshot_type = 'HISTORY_CONTEXT'")
					.bind(pipelineId).first<{ sha256: string }>();
				if (!existing) {
					let transactions: unknown[] = [];
					if (row.history_r2_key) {
						const object = await this.env.BUCKET.get(row.history_r2_key);
						if (!object) throw new Error("HISTORY_SNAPSHOT_MISSING");
						const value = JSON.parse(await object.text()) as { transactions?: unknown[] };
						if (!Array.isArray(value.transactions)) throw new Error("HISTORY_SNAPSHOT_INVALID");
						transactions = value.transactions;
					}
					await save(this.env.DB, pipelineId, "HISTORY_CONTEXT", { dataset_id: row.history_dataset_id, transactions });
				}
				await update(this.env.DB, pipelineId, "RUNNING", "RESEARCHING");
				await recordPipelineStage(this.env.DB, pipelineId, "RESEARCH", "RUNNING");
				const now = new Date().toISOString();
				await this.env.DB.prepare("INSERT INTO runs (id, project_id, status, current_stage, created_at, updated_at) VALUES (?1, ?2, 'QUEUED', 'QUEUED', ?3, ?3) ON CONFLICT(id) DO NOTHING")
					.bind(runId, projectId, now).run();
				const params: RunRequest = { runId, projectId, pipelineId, durationSeconds: 0, mode: "SOURCING" };
				try { await this.env.WORKFLOW.create({ id: runId, params }); }
				catch (error) {
					// An interrupted create can have succeeded remotely. Reuse only a
					// demonstrably existing instance with the same deterministic id.
					try { await (await this.env.WORKFLOW.get(runId)).status(); } catch { throw error; }
				}
			});
			for (let i = 0; i < 180; i++) {
				const state = await step.do(`read-research-${i}`, { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "30 seconds" }, async () => {
					const row = await this.env.DB.prepare("SELECT status FROM runs WHERE id = ?1 AND project_id = ?2").bind(runId, projectId).first<{ status: string }>();
					return row?.status ?? "MISSING";
				});
				if (["COMPLETED", "PARTIAL", "FAILED"].includes(state)) { researchStatus = state; break; }
				await step.sleep(`wait-research-${i}`, "20 seconds");
			}
			if (!researchStatus) throw new Error("RESEARCH_TIMEOUT");
			if (researchStatus === "FAILED") throw new Error("RESEARCH_FAILED");
			await step.do("freeze-spec-context", { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" }, async () => {
				const already = await this.env.DB.prepare("SELECT sha256 FROM pipeline_snapshots WHERE pipeline_id = ?1 AND snapshot_type = 'SPEC_CONTEXT'")
					.bind(pipelineId).first<{ sha256: string }>();
				if (!already) {
					const result = await this.env.DB.prepare(`SELECT c.id FROM project_candidates c
						WHERE c.project_id = ?1 AND c.workspace_id = 'default' AND c.last_seen_run_id = ?2
						AND EXISTS (SELECT 1 FROM project_candidate_evidence e WHERE e.workspace_id = c.workspace_id AND e.candidate_id = c.id)
						ORDER BY c.id LIMIT 301`)
						.bind(projectId, runId).all<{ id: string }>();
					if (!result.results.length) throw new Error("NO_CANDIDATES");
					if (result.results.length > 300) throw new Error("TOO_MANY_CANDIDATES");
					const url = new URL(`/internal/projects/${encodeURIComponent(projectId)}/spec-context`, this.env.CONTAINER_GATEWAY_URL);
					url.searchParams.set("pipeline_id", pipelineId); url.searchParams.set("run_id", runId);
					url.searchParams.set("candidate_ids", result.results.map(x => x.id).join(","));
					const response = await fetch(url, { headers: { "x-internal-token": this.env.INTERNAL_GATEWAY_TOKEN } });
					if (!response.ok) throw new Error("SPEC_CONTEXT_FAILED");
					const context = await response.json() as SpecContext;
					if (context.project_id !== projectId || context.run_id !== runId || !context.requirements.length || !context.candidates.length) throw new Error("SPEC_CONTEXT_INVALID");
					await save(this.env.DB, pipelineId, "SPEC_CONTEXT", context);
				}
				await recordPipelineStage(this.env.DB, pipelineId, "RESEARCH", researchStatus === "PARTIAL" ? "PARTIAL" : "COMPLETED");
				await update(this.env.DB, pipelineId, "RUNNING", "EVALUATING");
				await recordPipelineStage(this.env.DB, pipelineId, "EVALUATING", "RUNNING");
			});
			activeStage = "EVALUATING";
			await step.do("evaluate-frozen-context", { retries: { limit: 0, delay: "10 seconds", backoff: "constant" }, timeout: "30 minutes" }, async () => {
				const output = await callContainer(this.env, "/internal/evaluate-spec", {
					project_id: projectId, pipeline_id: pipelineId, gateway_url: this.env.CONTAINER_GATEWAY_URL,
					token: this.env.INTERNAL_GATEWAY_TOKEN, runtime_config: runtime(this.env),
				});
				if (output.status !== "COMPLETED" || !output.assessments) throw new Error("NO_ASSESSMENTS");
				await snapshot(this.env.DB, pipelineId, "SPEC_RESULTS");
				await recordPipelineStage(this.env.DB, pipelineId, "EVALUATING", "COMPLETED");
			});
			activeStage = "DECIDING";
			await step.do("freeze-decision-context", { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" }, async () => {
				const spec = JSON.parse(await snapshot(this.env.DB, pipelineId, "SPEC_CONTEXT")) as SpecContext;
				const results = JSON.parse(await snapshot(this.env.DB, pipelineId, "SPEC_RESULTS")) as SpecResults;
				const history = JSON.parse(await snapshot(this.env.DB, pipelineId, "HISTORY_CONTEXT")) as { transactions: unknown[] };
				await save(this.env.DB, pipelineId, "DECISION_CONTEXT", {
					project_id: projectId, demand_revision: spec.demand_revision, run_id: runId,
					requirements: spec.requirements, assessments: results.assessments.map(row => row.assessment),
					evidence_ids: [...new Set(spec.candidates.flatMap(candidate => candidate.evidence_ids))],
					history_transactions: history.transactions, history_price_unit: null,
				});
				await update(this.env.DB, pipelineId, "RUNNING", "DECIDING");
				await recordPipelineStage(this.env.DB, pipelineId, "DECIDING", "RUNNING");
			});
			await step.do("decide-frozen-context", { retries: { limit: 0, delay: "10 seconds", backoff: "constant" }, timeout: "30 minutes" }, async () => {
				const output = await callContainer(this.env, "/internal/decide", {
					project_id: projectId, pipeline_id: pipelineId, gateway_url: this.env.CONTAINER_GATEWAY_URL,
					token: this.env.INTERNAL_GATEWAY_TOKEN, runtime_config: runtime(this.env),
				});
				if (output.status !== "COMPLETED" || !output.decisions) throw new Error("NO_DECISIONS");
				await snapshot(this.env.DB, pipelineId, "PRICE_CONTEXT");
				await snapshot(this.env.DB, pipelineId, "DECISION_RESULTS");
			});
			await step.do("freeze-final-decision", { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" }, async () => {
				const names = ["HISTORY_CONTEXT", "SPEC_CONTEXT", "SPEC_RESULTS", "DECISION_CONTEXT", "PRICE_CONTEXT", "DECISION_RESULTS"];
				const values: Record<string, Record<string, unknown>> = {};
				const hashes: Record<string, string> = {};
				for (const name of names) {
					const raw = await snapshot(this.env.DB, pipelineId, name);
					values[name] = JSON.parse(raw) as Record<string, unknown>;
					hashes[name] = await sha256(raw);
				}
				const pipeline = await this.env.DB.prepare(`SELECT pp.demand_revision, pp.demand_snapshot_sha256, p.title
					FROM project_pipelines pp JOIN projects p ON p.id = pp.project_id
					WHERE pp.id = ?1 AND pp.project_id = ?2 AND pp.run_id = ?3`)
					.bind(pipelineId, projectId, runId).first<{ demand_revision: number; demand_snapshot_sha256: string; title: string }>();
				if (!pipeline) throw new Error("PIPELINE_NOT_FOUND");
				const final = await buildFinalContext({ pipelineId, projectId, projectTitle: pipeline.title, runId,
					demandRevision: pipeline.demand_revision, researchStatus, demandSha256: pipeline.demand_snapshot_sha256,
					snapshotHashes: hashes, specContext: values.SPEC_CONTEXT, specResults: values.SPEC_RESULTS,
					decisionResults: values.DECISION_RESULTS, priceContext: values.PRICE_CONTEXT });
				await save(this.env.DB, pipelineId, "FINAL_CONTEXT", final);
				const version = await sha256(await snapshot(this.env.DB, pipelineId, "FINAL_CONTEXT"));
				const terminal = researchStatus === "PARTIAL" ? "PARTIAL" : "COMPLETED";
				await this.env.DB.prepare("UPDATE project_pipelines SET decision_version = ?2, status = ?3, stage = ?3, updated_at = ?4 WHERE id = ?1")
					.bind(pipelineId, version, terminal, new Date().toISOString()).run();
				await recordPipelineStage(this.env.DB, pipelineId, "DECIDING", "COMPLETED");
			});
			analysisFrozen = true;
			// Report is an independent finalizer: its failure never rolls back the
			// already-frozen decision or changes the terminal analysis status.
			try {
				await step.do("start-versioned-report", { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "2 minutes" }, async () => {
					const report = await startPipelineReport(this.env, projectId, pipelineId);
					if (report.kind !== "OK") {
						await this.env.DB.prepare("UPDATE project_pipelines SET report_status = 'FAILED', report_error_code = ?2, updated_at = ?3 WHERE id = ?1")
							.bind(pipelineId, report.kind === "DECISION_UNAVAILABLE" ? "REPORT_DECISION_UNAVAILABLE" : "REPORT_START_FAILED", new Date().toISOString()).run();
					}
					return { status: report.kind };
				});
			} catch (error) {
				console.error("pipeline report finalizer failed", pipelineId, error);
				await step.do("record-report-start-failure", async () => {
					await this.env.DB.prepare("UPDATE project_pipelines SET report_status = 'FAILED', report_error_code = 'REPORT_START_FAILED', updated_at = ?2 WHERE id = ?1")
						.bind(pipelineId, new Date().toISOString()).run();
				});
			}
			return { status: researchStatus === "PARTIAL" ? "PARTIAL" : "COMPLETED", pipeline_id: pipelineId, run_id: runId };
		} catch (error) {
			console.error("pipeline failed", pipelineId, activeStage, error);
			if (analysisFrozen) return { status: researchStatus === "PARTIAL" ? "PARTIAL" : "COMPLETED", pipeline_id: pipelineId, run_id: runId, report_error: "REPORT_START_FAILED" };
			await step.do("record-pipeline-failure", { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "1 minute" }, async () => {
				await recordPipelineStage(this.env.DB, pipelineId, activeStage, "FAILED", "PIPELINE_STAGE_FAILED");
				await update(this.env.DB, pipelineId, "FAILED", activeStage, "PIPELINE_STAGE_FAILED");
			});
			return { status: "FAILED", pipeline_id: pipelineId, stage: activeStage, error: "PIPELINE_STAGE_FAILED" };
		}
	}
}
