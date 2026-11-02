import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { authorizeGuest } from "../src/guest_session.ts";
import { guestProjectsListSql } from "../src/gateway_contracts.ts";

// Exercise the real authorization code against SQLite and the actual migration.
function setup() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
		CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
		CREATE TABLE research_evidence (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
		CREATE TABLE research_evidence_tasks (workspace_id TEXT, run_id TEXT, evidence_id TEXT);
		CREATE TABLE project_candidates (id TEXT, workspace_id TEXT, project_id TEXT);
		CREATE TABLE project_candidate_evidence (workspace_id TEXT, candidate_id TEXT, evidence_id TEXT);`);
	db.exec(readFileSync(new URL("../migrations/0012_m4_guest_sessions.sql", import.meta.url), "utf8"));
	const binding = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async first() { return db.prepare(sql).get(...values) ?? null; },
		async run() { return db.prepare(sql).run(...values); },
	}; } }; } };
	return { db, env: { DB: binding, GUEST_SESSION_SECRET: "x".repeat(48) } };
}
function req(path: string, method = "GET", cookie = "", origin: string | null = "https://example.test") {
	const headers = new Headers();
	if (cookie) headers.set("cookie", cookie);
	if (origin) headers.set("origin", origin);
	return new Request(`https://example.test${path}`, { method, headers });
}
async function create(env: ReturnType<typeof setup>["env"]) {
	const result = await authorizeGuest(req("/api/session", "POST"), env as never);
	assert.ok("response" in result);
	assert.equal(result.response.status, 201);
	const cookie = result.response.headers.get("set-cookie")!;
	assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
	return cookie.split(";")[0];
}
async function status(result: Awaited<ReturnType<typeof authorizeGuest>>) {
	return "response" in result ? result.response.status : 200;
}

describe("guest session and resource isolation", () => {
	it("applies all migrations and filters the real project-list query by owner", () => {
		const db = new DatabaseSync(":memory:");
		const dir = new URL("../migrations/", import.meta.url);
		for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) {
			db.exec(readFileSync(new URL(name, dir), "utf8"));
		}
		const insert = db.prepare("INSERT INTO projects (id, title, created_at, session_id) VALUES (?, ?, ?, ?)");
		insert.run("a", "A", "2026-01-01", "session-a");
		insert.run("b", "B", "2026-01-02", "session-b");
		insert.run("old", "Old", "2026-01-03", null);
		const rows = db.prepare(guestProjectsListSql).all(50, "session-a");
		assert.deepEqual(rows.map(row => row.id), ["a"]);
	});
	it("requires explicit creation, validates Origin, and reuses a valid session", async () => {
		const { env } = setup();
		assert.equal(await status(await authorizeGuest(req("/api/session"), env as never)), 401);
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", "", null), env as never)), 403);
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", "", "https://evil.test"), env as never)), 403);
		const cookie = await create(env);
		const again = await authorizeGuest(req("/api/session", "POST", cookie), env as never);
		assert.ok("response" in again);
		assert.equal(again.response.status, 200);
		assert.equal(again.response.headers.get("set-cookie"), null);
		assert.equal(await status(await authorizeGuest(req("/api/session", "GET", cookie), env as never)), 200);
		assert.equal(await status(await authorizeGuest(req("/api/projects", "GET", cookie + "x"), env as never)), 401);
	});
	it("isolates projects, runs, reports and evidence, including legacy projects", async () => {
		const { db, env } = setup();
		const a = await create(env), b = await create(env);
		const aid = a.split("=")[1].split(".")[0];
		db.prepare("INSERT INTO projects (id, created_at, session_id) VALUES (?, ?, ?)").run("p1", "2026", aid);
		db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run("old", "2026");
		db.prepare("INSERT INTO runs VALUES (?, ?)").run("r1", "p1");
		db.prepare("INSERT INTO research_evidence VALUES (?, ?)").run("e1", "default");
		db.prepare("INSERT INTO research_evidence_tasks VALUES (?, ?, ?)").run("default", "r1", "e1");
		for (const path of ["/api/projects/p1", "/api/projects/p1/reports/x/download", "/api/runs/r1/events", "/api/evidence/e1"]) {
			assert.equal(await status(await authorizeGuest(req(path, "GET", a), env as never)), 200, path);
			assert.equal(await status(await authorizeGuest(req(path, "GET", b), env as never)), 404, path);
		}
		assert.equal(await status(await authorizeGuest(req("/api/projects/old", "GET", a), env as never)), 404);
		assert.equal(await status(await authorizeGuest(req("/api/workspaces/default/suppliers", "GET", a), env as never)), 404);
		assert.equal(await status(await authorizeGuest(req("/api/projects/p1/runs", "POST", a), env as never)), 503);
		assert.equal(await status(await authorizeGuest(req("/api/projects/p1/requirement-text", "POST", a, null), env as never)), 403);
	});
	it("does not resurrect expired sessions or authorize a bearer token", async () => {
		const { db, env } = setup();
		const old = await create(env);
		db.exec("UPDATE guest_sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
		assert.equal(await status(await authorizeGuest(req("/api/projects", "GET", old), env as never)), 401);
		const next = await create(env);
		assert.notEqual(next, old);
		const token = new Request("https://example.test/api/projects", { headers: { authorization: "Bearer token" } });
		assert.equal(await status(await authorizeGuest(token, env as never)), 401);
	});
});
