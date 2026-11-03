import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { listProjectPipelines } from "../src/pipeline_discovery.ts";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	const dir = new URL("../migrations/", import.meta.url);
	for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
	}
	const db = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async first() { return sqlite.prepare(sql).get(...values) ?? null; },
		async all() { return { results: sqlite.prepare(sql).all(...values) }; },
	}; } }; } };
	sqlite.prepare("INSERT INTO projects (id,title,created_at,session_id) VALUES (?,?,?,?)").run("p1", "P1", "2026", "guest-a");
	sqlite.prepare("INSERT INTO projects (id,title,created_at,session_id) VALUES (?,?,?,?)").run("p2", "P2", "2026", "guest-b");
	const add = sqlite.prepare(`INSERT INTO project_pipelines
		(id,workspace_id,project_id,run_id,demand_revision,status,stage,report_status,created_at,updated_at,idempotency_key)
		VALUES (?, 'default', ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
	add.run("queued", "p1", "not-yet-created", "QUEUED", "QUEUED", "NOT_STARTED", "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z", "secret-key");
	add.run("reporting", "p1", "r2", "COMPLETED", "COMPLETED", "RUNNING", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", "secret-key-2");
	add.run("done", "p1", "r1", "COMPLETED", "COMPLETED", "COMPLETED", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "secret-key-3");
	add.run("foreign", "p2", "r3", "RUNNING", "RESEARCHING", "NOT_STARTED", "2026-01-04T00:00:00Z", "2026-01-04T00:00:00Z", "secret-key-4");
	return { db, sqlite };
}
function req(query = "") { return new Request(`https://gateway.test/api/projects/p1/pipelines${query}`); }

it("finds queued analysis and running reports without depending on the runs table", async () => {
	const { db } = fixture();
	const response = await listProjectPipelines(req("?active=true"), db as never, "p1", null);
	assert.equal(response.status, 200);
	const body = await response.json() as { pipelines: Array<Record<string, unknown>>; has_more: boolean };
	assert.deepEqual(body.pipelines.map(row => row.pipeline_id), ["queued", "reporting"]);
	assert.equal(body.pipelines[0].run_id, "not-yet-created");
	assert.equal(body.pipelines[1].report_status, "RUNNING");
	assert.equal(body.has_more, false);
	assert.ok(!JSON.stringify(body).includes("secret-key"));
	assert.equal(response.headers.get("cache-control"), "private, no-store");
});

it("limits deterministic results and checks owner/project without exposing foreign rows", async () => {
	const { db } = fixture();
	const response = await listProjectPipelines(req("?limit=1"), db as never, "p1", "guest-a");
	const body = await response.json() as { pipelines: Array<Record<string, unknown>>; has_more: boolean };
	assert.deepEqual(body.pipelines.map(row => row.pipeline_id), ["queued"]);
	assert.equal(body.has_more, true);
	assert.equal((await listProjectPipelines(req(), db as never, "p1", "guest-b")).status, 404);
	assert.equal((await listProjectPipelines(req(), db as never, "missing", null)).status, 404);
	assert.equal((await listProjectPipelines(req("?limit=0"), db as never, "p1", null)).status, 400);
	assert.equal((await listProjectPipelines(req("?active=yes"), db as never, "p1", null)).status, 400);
	assert.equal((await listProjectPipelines(req("?limit=101"), db as never, "p1", null)).status, 400);
	const all = await (await listProjectPipelines(req("?active=false"), db as never, "p1", null)).json() as { pipelines: Array<Record<string, unknown>> };
	assert.deepEqual(all.pipelines.map(row => row.pipeline_id), ["queued", "reporting", "done"]);
});

it("sanitizes D1 failures", async () => {
	const db = { prepare() { throw new Error("SQL private diagnostic"); } };
	const response = await listProjectPipelines(req(), db as never, "p1", null);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "database_unavailable" });
});
