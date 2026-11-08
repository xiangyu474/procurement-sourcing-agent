import { getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, RunRequest } from "./index";
import { waitForContainer } from "./index";
import { recordPipelineStage, sha256, storePipelineSnapshot } from "./pipeline_store";
import { buildFinalContext } from "./pipeline_final";
import { startPipelineReport } from "./pipeline_report";
import { releaseGuestAdmission } from "./guest_admission";
import { containerReasonCode, SAFE_STAGE_CODES, stageErrorCode } from "./stage_error";
import { pipelineInstanceName } from "./container_instance";

export interface PipelineRequest { pipelineId: string; projectId: string; runId: string; probeOnly?: boolean; researchBudget?: { max_search_calls: number; max_fetches: number; max_tasks: number; max_rounds: number; max_model_calls: number } }
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
async function callContainer(env: Env, path: string, payload: Record<string, unknown>, pipelineId?: string) {
	// Every pipeline gets its own container, so one run cannot take another down.
	const container = getContainer(env.SOURCING_CONTAINER, pipelineInstanceName(env.CONTAINER_INSTANCE_NAME, pipelineId));
	await container.start();
	// The container may still be restarting after a crash. Sending work to a
	// closed port would fail the stage for the wrong reason.
	if (!await waitForContainer(container)) throw new Error("STAGE_SERVICE_ERROR:CONTAINER_NOT_READY");
	const response = await container.fetch(new Request(`http://container${path}`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
	}));
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const code = containerReasonCode(body) ?? "STAGE_SERVICE_ERROR";
		console.error("container stage failed", path, response.status, code, body.slice(0, 500));
		throw new Error(`${code}:HTTP_${response.status}`);
	}
	return await response.json() as { status?: string; assessments?: number; decisions?: number; price_contexts?: unknown[] };
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
		// A cost-free operator probe distinguishes the code executing in a
		// Workflow instance from the latest uploaded Worker/version metadata.
		if (event.payload.probeOnly) {
			return await step.do("pipeline-code-version-b2", async () => ({ status: "PROBE", code_revision: "pipeline-b2-snapshot-report" }));
		}
		let activeStage = "RESEARCH";
		let researchStatus = "";
		let researchReason: string | null = null;
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
					// The imported workbook is immutable in R2, so the snapshot keeps a
					// reference instead of a copy. A thousand history rows do not fit
					// in one snapshot, and the rows are read from R2 where they are used.
					await save(this.env.DB, pipelineId, "HISTORY_CONTEXT", {
						dataset_id: row.history_dataset_id,
						r2_key: row.history_r2_key,
						row_count: transactions.length,
					});
				}
				await update(this.env.DB, pipelineId, "RUNNING", "RESEARCHING");
				await recordPipelineStage(this.env.DB, pipelineId, "RESEARCH", "RUNNING");
				const now = new Date().toISOString();
				await this.env.DB.prepare("INSERT INTO runs (id, project_id, status, current_stage, created_at, updated_at) VALUES (?1, ?2, 'QUEUED', 'QUEUED', ?3, ?3) ON CONFLICT(id) DO NOTHING")
					.bind(runId, projectId, now).run();
				const params: RunRequest = { runId, projectId, pipelineId, durationSeconds: 0, mode: "SOURCING", researchBudget: event.payload.researchBudget };
				try { await this.env.WORKFLOW.create({ id: runId, params }); }
				catch (error) {
					// An interrupted create can have succeeded remotely. Reuse only a
					// demonstrably existing instance with the same deterministic id.
					try { await (await this.env.WORKFLOW.get(runId)).status(); } catch { throw error; }
				}
			});
			// The research step itself stops after twenty minutes. Waiting longer
			// here only leaves a visitor looking at a task that cannot finish.
			for (let i = 0; i < 70; i++) {
				const state = await step.do(`read-research-${i}`, { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "30 seconds" }, async () => {
					const row = await this.env.DB.prepare(
						`SELECT r.status,
						        (SELECT c.stop_reason_code FROM research_run_costs c WHERE c.run_id = r.id) AS stop_reason_code
						 FROM runs r WHERE r.id = ?1 AND r.project_id = ?2`,
					).bind(runId, projectId).first<{ status: string; stop_reason_code: string | null }>();
					return { status: row?.status ?? "MISSING", reason: row?.stop_reason_code ?? null };
				});
				if (["COMPLETED", "PARTIAL", "FAILED"].includes(state.status)) {
					researchStatus = state.status;
					researchReason = state.reason;
					break;
				}
				await step.sleep(`wait-research-${i}`, "20 seconds");
			}
			if (!researchStatus) throw new Error("RESEARCH_TIMEOUT");
			if (researchStatus === "FAILED") {
				// The research says why it stopped; the page should say the same.
				throw new Error(researchReason && SAFE_STAGE_CODES.has(researchReason) ? researchReason : "RESEARCH_FAILED");
			}
			await step.do("freeze-spec-context", { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" }, async () => {
				// What the research found is visible before the slower stages, so a
				// visitor can see progress instead of a silent wait.
				const found = await this.env.DB.prepare(`SELECT COUNT(*) AS candidates,
					COUNT(DISTINCT COALESCE(p.model, c.product_id)) AS models
					FROM project_candidates c LEFT JOIN intelligence_products p
					  ON p.workspace_id = c.workspace_id AND p.id = c.product_id
					WHERE c.workspace_id = 'default' AND c.project_id = ?1 AND c.last_seen_run_id = ?2`)
					.bind(projectId, runId).first<{ candidates: number; models: number }>();
				const evidence = await this.env.DB.prepare(`SELECT COUNT(DISTINCT e.evidence_id) AS evidence
					FROM project_candidate_evidence e JOIN project_candidates c
					  ON c.id = e.candidate_id AND c.workspace_id = e.workspace_id
					WHERE c.workspace_id = 'default' AND c.project_id = ?1 AND c.last_seen_run_id = ?2`)
					.bind(projectId, runId).first<{ evidence: number }>();
				await this.env.DB.prepare(`UPDATE project_pipelines SET candidates_found = ?2, models_found = ?3, evidence_found = ?4, updated_at = ?5 WHERE id = ?1`)
					.bind(pipelineId, found?.candidates ?? 0, found?.models ?? 0, evidence?.evidence ?? 0, new Date().toISOString()).run();
				const already = await this.env.DB.prepare("SELECT sha256 FROM pipeline_snapshots WHERE pipeline_id = ?1 AND snapshot_type = 'SPEC_CONTEXT'")
					.bind(pipelineId).first<{ sha256: string }>();
				if (!already) {
					const result = await this.env.DB.prepare(`SELECT c.id FROM project_candidates c
						WHERE c.project_id = ?1 AND c.workspace_id = 'default' AND c.last_seen_run_id = ?2
						AND EXISTS (SELECT 1 FROM project_candidate_evidence e WHERE e.workspace_id = c.workspace_id AND e.candidate_id = c.id)
						ORDER BY c.id LIMIT 301`)
						.bind(projectId, runId).all<{ id: string }>();
					if (result.results.length > 300) throw new Error("TOO_MANY_CANDIDATES");
					const url = new URL(`/internal/projects/${encodeURIComponent(projectId)}/spec-context`, this.env.CONTAINER_GATEWAY_URL);
					url.searchParams.set("pipeline_id", pipelineId); url.searchParams.set("run_id", runId);
					url.searchParams.set("candidate_ids", result.results.map(x => x.id).join(","));
					const response = await fetch(url, { headers: { "x-internal-token": this.env.INTERNAL_GATEWAY_TOKEN } });
					if (!response.ok) throw new Error("SPEC_CONTEXT_FAILED");
					const context = await response.json() as SpecContext;
					// A research that found no candidate is an answer, not a broken
					// task: the analysis then says so in words.
					if (context.project_id !== projectId || context.run_id !== runId || !context.requirements.length) throw new Error("SPEC_CONTEXT_INVALID");
					await save(this.env.DB, pipelineId, "SPEC_CONTEXT", context);
				}
				await recordPipelineStage(
					this.env.DB, pipelineId, "RESEARCH",
					researchStatus === "PARTIAL" ? "PARTIAL" : "COMPLETED",
					researchReason && SAFE_STAGE_CODES.has(researchReason) ? researchReason : null,
				);
				await update(this.env.DB, pipelineId, "RUNNING", "EVALUATING");
				await recordPipelineStage(this.env.DB, pipelineId, "EVALUATING", "RUNNING");
			});
			activeStage = "EVALUATING";
			// The research leaves the container near its memory limit, so the
			// evaluation can meet a container that just died. The frozen input is
			// in the database, so one retry on a fresh container is safe.
			await step.do("evaluate-frozen-context", { retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "30 minutes" }, async () => {
				const output = await callContainer(this.env, "/internal/evaluate-spec", {
					project_id: projectId, pipeline_id: pipelineId, gateway_url: this.env.CONTAINER_GATEWAY_URL,
					token: this.env.INTERNAL_GATEWAY_TOKEN, runtime_config: runtime(this.env),
				}, pipelineId);
				if (output.status !== "COMPLETED" || typeof output.assessments !== "number") throw new Error("NO_ASSESSMENTS");
				await snapshot(this.env.DB, pipelineId, "SPEC_RESULTS");
				await recordPipelineStage(this.env.DB, pipelineId, "EVALUATING", "COMPLETED");
			});
			activeStage = "DECIDING";
			await step.do("freeze-decision-context", { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" }, async () => {
				const spec = JSON.parse(await snapshot(this.env.DB, pipelineId, "SPEC_CONTEXT")) as SpecContext;
				const results = JSON.parse(await snapshot(this.env.DB, pipelineId, "SPEC_RESULTS")) as SpecResults;
				const history = JSON.parse(await snapshot(this.env.DB, pipelineId, "HISTORY_CONTEXT")) as {
					dataset_id?: string | null; r2_key?: string | null; row_count?: number | null;
				};
				await save(this.env.DB, pipelineId, "DECISION_CONTEXT", {
					project_id: projectId, demand_revision: spec.demand_revision, run_id: runId,
					requirements: spec.requirements, assessments: results.assessments.map(row => row.assessment),
					evidence_ids: [...new Set(spec.candidates.flatMap(candidate => candidate.evidence_ids))],
					// The history is read from R2 by the container when it prices it.
					history_reference: {
						dataset_id: history.dataset_id,
						r2_key: history.r2_key,
						row_count: history.row_count,
					},
					history_price_unit: null,
				});
				await update(this.env.DB, pipelineId, "RUNNING", "DECIDING");
				await recordPipelineStage(this.env.DB, pipelineId, "DECIDING", "RUNNING");
			});
			await step.do("decide-frozen-context", { retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "30 minutes" }, async () => {
				// A research that found no candidate has nothing to decide. That is
				// an answer, and the analysis says so in words.
				const assessed = await snapshot(this.env.DB, pipelineId, "SPEC_RESULTS") as { assessments?: unknown[] };
				const assessmentCount = Array.isArray(assessed.assessments) ? assessed.assessments.length : 0;
				if (assessmentCount === 0) {
					// The prices do not depend on a decision. They are still read and
					// frozen, so the page can show the budget and the history scope.
					const prices = await callContainer(this.env, "/internal/projects/price-context", {
						project_id: projectId, gateway_url: this.env.CONTAINER_GATEWAY_URL,
						token: this.env.INTERNAL_GATEWAY_TOKEN, runtime_config: runtime(this.env),
					}, pipelineId);
					await save(this.env.DB, pipelineId, "PRICE_CONTEXT", { price_contexts: prices.price_contexts ?? [] });
					await save(this.env.DB, pipelineId, "DECISION_RESULTS", { decisions: [] });
					return;
				}
				const output = await callContainer(this.env, "/internal/decide", {
					project_id: projectId, pipeline_id: pipelineId, gateway_url: this.env.CONTAINER_GATEWAY_URL,
					token: this.env.INTERNAL_GATEWAY_TOKEN, runtime_config: runtime(this.env),
				}, pipelineId);
				if (output.status !== "COMPLETED" || typeof output.decisions !== "number") throw new Error("NO_DECISIONS");
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
			await releaseGuestAdmission(this.env.DB, pipelineId, "PIPELINE");
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
			// The stage keeps the reason; the task keeps the public failure code.
			const code = stageErrorCode(error);
			await step.do("record-pipeline-failure", { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "1 minute" }, async () => {
				await recordPipelineStage(this.env.DB, pipelineId, activeStage, "FAILED", code);
				await update(this.env.DB, pipelineId, "FAILED", activeStage, "PIPELINE_STAGE_FAILED");
				await releaseGuestAdmission(this.env.DB, pipelineId, "PIPELINE");
			});
			return { status: "FAILED", pipeline_id: pipelineId, stage: activeStage, error: "PIPELINE_STAGE_FAILED", error_code: code };
		}
	}
}
