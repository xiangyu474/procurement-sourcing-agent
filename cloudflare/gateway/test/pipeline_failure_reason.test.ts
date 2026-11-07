import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { releaseGuestAdmission, reserveGuestTask } from "../src/guest_admission.ts";
import { stageErrorCode } from "../src/stage_error.ts";

it("keeps the reason of a failed stage and never an exception text", () => {
	assert.equal(stageErrorCode(new Error("MODEL_TIMEOUT:HTTP_504")), "MODEL_TIMEOUT");
	assert.equal(stageErrorCode(new Error("DECISION_FAILED:HTTP_502")), "DECISION_FAILED");
	assert.equal(stageErrorCode(new Error("SNAPSHOT_MISSING")), "SNAPSHOT_MISSING");
	// Anything unknown stays the public code.
	assert.equal(stageErrorCode(new Error("cannot read properties of undefined")), "PIPELINE_STAGE_FAILED");
	assert.equal(stageErrorCode(new Error("Traceback (most recent call last): ...")), "PIPELINE_STAGE_FAILED");
	assert.equal(stageErrorCode(undefined), "PIPELINE_STAGE_FAILED");
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	const dir = new URL("../migrations/", import.meta.url);
	for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
	sqlite.prepare("INSERT INTO guest_sessions(id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?)").run("s1", "2026", "2099-01-01T00:00:00.000Z", "2026");
	sqlite.prepare("INSERT INTO projects(id,title,created_at,session_id) VALUES (?,?,?,?)").run("p1", "p", "2026", "s1");
	sqlite.prepare("INSERT INTO project_reports(id,workspace_id,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("pr_p1", "default", "p1", "FAILED", "2026", "2026");
	const db = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async first() { return sqlite.prepare(sql).get(...values) ?? null; },
		async run() { const out = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(out.changes) } }; },
	}; } }; } };
	return { db, sqlite };
}

it("admits a report retry of a visitor under the daily unit budget", async () => {
	const { db, sqlite } = fixture();
	const policy = { globalConcurrent: 2, sessionConcurrent: 1, globalDailyUnits: 10, sessionDailyUnits: 4, sessionDailyStarts: 3 };
	const first = await reserveGuestTask(db as never, { sessionId: "s1", projectId: "p1", operationId: "pr_p1#1", kind: "REPORT", requestHash: "h1", units: 1 }, policy);
	assert.equal(first.kind, "CREATED");
	// The same attempt is reused.
	const same = await reserveGuestTask(db as never, { sessionId: "s1", projectId: "p1", operationId: "pr_p1#1", kind: "REPORT", requestHash: "h1", units: 1 }, policy);
	assert.equal(same.kind, "REUSED");
	// One visitor runs one report at a time.
	const blocked = await reserveGuestTask(db as never, { sessionId: "s1", projectId: "p1", operationId: "pr_p1#2", kind: "REPORT", requestHash: "h2", units: 1 }, policy);
	assert.equal(blocked.kind, "DENIED");
	// A terminal report frees the slot of every attempt of that report.
	assert.equal(await releaseGuestAdmission(db as never, "pr_p1", "REPORT"), true);
	const held = sqlite.prepare("SELECT count(*) AS n FROM guest_task_admissions WHERE state = 'HELD'").get()?.n;
	assert.equal(held, 0);
	// The retry is admitted and costs a unit of its own.
	const second = await reserveGuestTask(db as never, { sessionId: "s1", projectId: "p1", operationId: "pr_p1#2", kind: "REPORT", requestHash: "h2", units: 1 }, policy);
	assert.equal(second.kind, "CREATED");
	const units = sqlite.prepare("SELECT sum(reserved_units) AS n FROM guest_task_admissions WHERE operation_kind = 'REPORT'").get()?.n;
	assert.equal(units, 2);
});

it("keeps the research stop reasons as the reason of the research stage", () => {
	// The codes a research stops with are the codes the page may show.
	for (const code of [
		"BUDGET_EXHAUSTED", "NO_FETCHED_EVIDENCE", "NO_SOURCE_BACKED_CANDIDATES",
		"SOURCE_FETCH_FAILED", "INVALID_RESEARCH_INPUT", "RESEARCH_INPUT_REJECTED",
		"SEARCH_PROVIDER_TIMEOUT", "SEARCH_PROVIDER_RATE_LIMITED",
	]) {
		assert.equal(stageErrorCode(new Error(code)), code);
	}
	// An unknown reason stays the generic code.
	assert.equal(stageErrorCode(new Error("SOMETHING_ELSE")), "PIPELINE_STAGE_FAILED");
});
