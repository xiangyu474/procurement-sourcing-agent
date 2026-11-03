import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { releaseGuestAdmission, reserveGuestTask } from "../src/guest_admission.ts";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	const dir = new URL("../migrations/", import.meta.url);
	for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
	for (const name of ["a", "b", "c"]) {
		sqlite.prepare("INSERT INTO guest_sessions(id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?)").run(name, "2026", "2099-01-01T00:00:00.000Z", "2026");
		sqlite.prepare("INSERT INTO projects(id,title,created_at,session_id) VALUES (?,?,?,?)").run(`p-${name}`, name, "2026", name);
	}
	const db = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async first() { return sqlite.prepare(sql).get(...values) ?? null; },
		async run() { const out = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(out.changes) } }; },
	}; } }; } };
	return { db, sqlite };
}
const policy = { globalConcurrent: 2, sessionConcurrent: 1, globalDailyUnits: 6, sessionDailyUnits: 6, sessionDailyStarts: 4 };
const input = (session: string, operationId: string) => ({ sessionId: session, projectId: `p-${session}`, operationId, kind: "PIPELINE" as const, requestHash: `hash-${operationId}`, units: 3 });

it("reserves atomically, is idempotent and cannot evade daily units by releasing or using another session", async () => {
	const { db, sqlite } = fixture();
	const a = input("a", "task-a"), b = input("b", "task-b"), c = input("c", "task-c");
	assert.equal((await reserveGuestTask(db as never, a, policy)).kind, "CREATED");
	assert.equal((await reserveGuestTask(db as never, a, policy)).kind, "REUSED");
	assert.equal((await reserveGuestTask(db as never, { ...a, requestHash: "different" }, policy)).kind, "CONFLICT");
	assert.equal((await reserveGuestTask(db as never, { ...c, projectId: "p-a" }, policy)).kind, "DENIED");
	assert.equal((await reserveGuestTask(db as never, b, policy)).kind, "CREATED");
	assert.equal((await reserveGuestTask(db as never, c, policy)).kind, "DENIED");
	sqlite.prepare("INSERT INTO runs(id,project_id,status,current_stage,created_at,updated_at) VALUES (?,?,?,?,?,?)")
		.run("run-a", "p-a", "COMPLETED", "WEB_RESEARCH", "2026", "2026");
	sqlite.prepare("INSERT INTO project_pipelines(id,workspace_id,project_id,run_id,demand_revision,status,decision_version,report_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
		.run("task-a", "default", "p-a", "run-a", 1, "COMPLETED", "frozen-version", "COMPLETED", "2026", "2026");
	sqlite.prepare("UPDATE project_pipelines SET status='RUNNING' WHERE id = 'task-a'").run();
	assert.equal(await releaseGuestAdmission(db as never, "task-a", "PIPELINE"), false, "a running pipeline keeps its slot");
	sqlite.prepare("UPDATE project_pipelines SET status='FAILED' WHERE id = 'task-a'").run();
	assert.equal(await releaseGuestAdmission(db as never, "task-a", "PIPELINE"), true, "a failed pipeline frees the concurrency slot");
	assert.equal(await releaseGuestAdmission(db as never, "task-a", "PIPELINE"), false);
	assert.equal((await reserveGuestTask(db as never, c, policy)).kind, "DENIED", "released units are not refunded");
	assert.equal(sqlite.prepare("SELECT sum(reserved_units) AS units FROM guest_task_admissions").get()?.units, 6);
	sqlite.prepare("INSERT INTO project_pipelines(id,workspace_id,project_id,run_id,demand_revision,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
		.run("task-b", "default", "p-b", "run-b", 1, "FAILED", "2026", "2026");
	assert.equal(await releaseGuestAdmission(db as never, "task-b", "PIPELINE"), true);
});

it("does not exceed global or per-session concurrency under competing reservations", async () => {
	const { db, sqlite } = fixture();
	const broad = { globalConcurrent: 2, sessionConcurrent: 1, globalDailyUnits: 100, sessionDailyUnits: 100, sessionDailyStarts: 100 };
	const results = await Promise.all(Array.from({ length: 30 }, (_, i) => reserveGuestTask(db as never, { ...input(["a", "b", "c"][i % 3], `task-${i}`), units: 1 }, broad)));
	assert.equal(results.filter(result => result.kind === "CREATED").length, 2);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM guest_task_admissions WHERE state='HELD'").get()?.n, 2);
	const rows = sqlite.prepare("SELECT session_id,count(*) AS n FROM guest_task_admissions WHERE state='HELD' GROUP BY session_id").all();
	assert.ok(rows.every(row => row.n === 1));
});
