import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { startPipelineReport } from "../src/pipeline_report.ts";
import { sha256 } from "../src/pipeline_store.ts";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	const dir = new URL("../migrations/", import.meta.url);
	for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
	const db = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
		async first() { return sqlite.prepare(sql).get(...values) ?? null; },
	}; } }; } };
	const final = JSON.stringify({ project_id: "p", pipeline_id: "pipe", run_id: "run", decisions: [{ accepted: true }] });
	const version = await sha256(final);
	sqlite.prepare("INSERT INTO projects (id,title,created_at) VALUES (?,?,?)").run("p", "P", "2026");
	sqlite.prepare("INSERT INTO project_pipelines (id,workspace_id,project_id,run_id,demand_revision,status,decision_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
		.run("pipe", "default", "p", "run", 1, "COMPLETED", version, "2026", "2026");
	sqlite.prepare("INSERT INTO pipeline_snapshots VALUES (?,?,?,?,?)").run("pipe", "FINAL_CONTEXT", final, version, "2026");
	const instances = new Set<string>();
	let creates = 0;
	let object: Record<string, unknown> | null = null;
	const workflow = {
		async create({ id }: { id: string }) { creates++; if (instances.has(id)) throw new Error("exists"); instances.add(id); return { id }; },
		async get(id: string) { return { async status() { if (!instances.has(id)) throw new Error("not found"); return { status: "running" }; } }; },
	};
	const env = { DB: db, BUCKET: { async head() { return object; } }, REPORT_WORKFLOW: workflow };
	return { sqlite, env, version, get creates() { return creates; }, setObject(value: Record<string, unknown>) { object = value; } };
}

it("reuses an attempt and completed object; failed report retries without resetting analysis", async () => {
	const f = await fixture();
	assert.equal((await startPipelineReport(f.env as never, "p", "pipe")).kind, "OK");
	assert.equal((await startPipelineReport(f.env as never, "p", "pipe")).kind, "OK");
	assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM project_reports").get()?.n, 1);
	assert.equal(f.sqlite.prepare("SELECT attempt FROM project_reports").get()?.attempt, 1);
	f.sqlite.exec("UPDATE project_reports SET status='FAILED',error='simulated' WHERE pipeline_id='pipe'");
	assert.equal((await startPipelineReport(f.env as never, "p", "pipe")).kind, "OK");
	assert.equal(f.sqlite.prepare("SELECT attempt FROM project_reports").get()?.attempt, 2);
	assert.equal(f.sqlite.prepare("SELECT status FROM project_pipelines WHERE id='pipe'").get()?.status, "COMPLETED");
	f.sqlite.exec("UPDATE project_reports SET status='COMPLETED',r2_key='k',sha256='doc-hash' WHERE pipeline_id='pipe'");
	f.setObject({ customMetadata: { sha256: "doc-hash", decision_version: f.version } });
	const count = f.creates;
	const reuse = await startPipelineReport(f.env as never, "p", "pipe");
	assert.equal(reuse.kind, "OK");
	if (reuse.kind === "OK") assert.equal(reuse.status, "COMPLETED");
	assert.equal(f.creates, count);
	assert.equal((await startPipelineReport(f.env as never, "other-project", "pipe")).kind, "NOT_FOUND");
});

it("records a workflow launch failure without failing the frozen decision", async () => {
	const f = await fixture();
	f.env.REPORT_WORKFLOW.create = async () => { throw new Error("unavailable"); };
	const result = await startPipelineReport(f.env as never, "p", "pipe");
	assert.equal(result.kind, "REPORT_START_FAILED");
	const pipeline = f.sqlite.prepare("SELECT status, report_status, report_error_code FROM project_pipelines WHERE id='pipe'").get();
	assert.equal(pipeline?.status, "COMPLETED");
	assert.equal(pipeline?.report_status, "FAILED");
	assert.equal(pipeline?.report_error_code, "REPORT_START_FAILED");
});

it("refuses a tampered snapshot and leaves the decision untouched", async () => {
	const f = await fixture();
	f.sqlite.exec("UPDATE pipeline_snapshots SET payload_json='{}' WHERE pipeline_id='pipe'");
	assert.equal((await startPipelineReport(f.env as never, "p", "pipe")).kind, "DECISION_UNAVAILABLE");
	assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM project_reports").get()?.n, 0);
	assert.equal(f.sqlite.prepare("SELECT status FROM project_pipelines WHERE id='pipe'").get()?.status, "COMPLETED");
});
