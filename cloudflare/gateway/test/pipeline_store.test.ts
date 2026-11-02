import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { readPipelineDemand, recordPipelineStage, reservePipeline, storePipelineSnapshot } from "../src/pipeline_store.ts";

it("reserves once, checks inputs atomically, and retains the original demand", async () => {
	const sqlite = new DatabaseSync(":memory:");
	const dir = new URL("../migrations/", import.meta.url);
	for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
	}
	const db = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async run() { const out = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(out.changes) } }; },
		async first() { return sqlite.prepare(sql).get(...values) ?? null; },
	}; } }; } };
	sqlite.prepare("INSERT INTO projects (id, title, created_at, demand_revision) VALUES (?, ?, ?, ?)").run("p", "P", "2026", 1);
	sqlite.prepare("INSERT INTO demand_compilations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run("c", "p", 1, 1, "v1", '{"requirements":[{"id":"r"}]}', "[]", "2026");
	const input = { projectId: "p", pipelineId: "pipe-1", runId: "run-1", idempotencyKey: "click-1",
		requestHash: "hash-1", demandRevision: 1, demandJson: '{"requirements":[{"id":"r"}]}' };
	const created = await reservePipeline(db as never, input);
	assert.equal(created.kind, "CREATED");
	const duplicate = await reservePipeline(db as never, { ...input, pipelineId: "other", runId: "other-run" });
	assert.equal(duplicate.kind, "REUSED");
	if (duplicate.kind === "REUSED") assert.equal(duplicate.pipeline.id, "pipe-1");
	assert.equal((await reservePipeline(db as never, { ...input, requestHash: "different" })).kind, "IDEMPOTENCY_CONFLICT");
	sqlite.prepare("UPDATE projects SET demand_revision = ? WHERE id = ?").run(2, "p");
	assert.equal((await reservePipeline(db as never, { ...input, pipelineId: "pipe-2", idempotencyKey: "new" })).kind, "INPUT_CHANGED");
	assert.equal((await reservePipeline(db as never, input)).kind, "REUSED");
	const snapshot = sqlite.prepare("SELECT demand_snapshot_json FROM project_pipelines WHERE id = ?").get("pipe-1");
	assert.equal(snapshot?.demand_snapshot_json, input.demandJson);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM project_pipelines").get()?.n, 1);
	assert.deepEqual(await readPipelineDemand(db as never, "pipe-1", "p", "run-1"), {
		demand_revision: 1, compilation_json: input.demandJson,
	});
	assert.equal(await readPipelineDemand(db as never, "pipe-1", "other-project", "run-1"), null);
	assert.equal(await readPipelineDemand(db as never, "pipe-1", "p", "other-run"), null);
	sqlite.prepare("UPDATE project_pipelines SET demand_snapshot_json = ? WHERE id = ?").run("{}", "pipe-1");
	await assert.rejects(() => readPipelineDemand(db as never, "pipe-1", "p", "run-1"), /integrity/);

	assert.equal(await storePipelineSnapshot(db as never, "pipe-1", "RESEARCH_INPUT", '{"candidates":["a"]}'), "CREATED");
	assert.equal(await storePipelineSnapshot(db as never, "pipe-1", "RESEARCH_INPUT", '{"candidates":["a"]}'), "REUSED");
	assert.equal(await storePipelineSnapshot(db as never, "pipe-1", "RESEARCH_INPUT", '{"candidates":["b"]}'), "CONFLICT");
	assert.equal(sqlite.prepare("SELECT payload_json FROM pipeline_snapshots").get()?.payload_json, '{"candidates":["a"]}');
	await assert.rejects(() => storePipelineSnapshot(db as never, "missing", "RESEARCH_INPUT", "{}"), /pipeline_not_found/);
	assert.equal(await recordPipelineStage(db as never, "pipe-1", "RESEARCH", "RUNNING"), true);
	assert.equal(await recordPipelineStage(db as never, "pipe-1", "RESEARCH", "RUNNING"), false);
	assert.equal(await recordPipelineStage(db as never, "pipe-1", "RESEARCH", "PARTIAL", "BUDGET_EXHAUSTED"), true);
	assert.equal(await recordPipelineStage(db as never, "pipe-1", "RESEARCH", "COMPLETED"), false);
	const stage = sqlite.prepare("SELECT status, error_code, started_at, finished_at FROM pipeline_stages").get();
	assert.equal(stage?.status, "PARTIAL");
	assert.equal(stage?.error_code, "BUDGET_EXHAUSTED");
	assert.ok(stage?.started_at && stage?.finished_at);
});
