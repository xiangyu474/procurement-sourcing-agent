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
	db.exec(readFileSync(new URL("../migrations/0016_guest_creation_rate.sql", import.meta.url), "utf8"));
	db.exec(readFileSync(new URL("../migrations/0017_guest_request_rate.sql", import.meta.url), "utf8"));
	const binding = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async first() { return db.prepare(sql).get(...values) ?? null; },
		async run() { return db.prepare(sql).run(...values); },
	}; } }; } };
	return { db, env: { DB: binding, GUEST_SESSION_SECRET: "x".repeat(48), GUEST_SESSION_GLOBAL_PER_HOUR: "60", GUEST_SESSION_IP_PER_HOUR: "10", GUEST_GLOBAL_REQUESTS_PER_MINUTE: "500", GUEST_SESSION_REQUESTS_PER_MINUTE: "100" } };
}
function req(path: string, method = "GET", cookie = "", origin: string | null = "https://example.test", ip: string | null = "198.51.100.1") {
	const headers = new Headers();
	if (cookie) headers.set("cookie", cookie);
	if (origin) headers.set("origin", origin);
	if (ip) headers.set("cf-connecting-ip", ip);
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
		assert.equal(await status(await authorizeGuest(req("/api/projects/p1/requirement-text", "POST", a, null), env as never)), 403);
	});
	it("fails closed without rate settings or a trusted client address", async () => {
		const { env } = setup();
		const noLimit = { ...env, GUEST_SESSION_GLOBAL_PER_HOUR: undefined };
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST"), noLimit as never)), 503);
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", "", "https://example.test", null), env as never)), 503);
	});
	it("limits new sessions per IP and globally without charging a valid-session retry", async () => {
		const { env, db } = setup();
		env.GUEST_SESSION_IP_PER_HOUR = "2";
		env.GUEST_SESSION_GLOBAL_PER_HOUR = "3";
		const first = await create(env);
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", first), env as never)), 200);
		await create(env);
		const limited = await authorizeGuest(req("/api/session", "POST"), env as never);
		assert.ok("response" in limited);
		assert.equal(limited.response.status, 429);
		assert.equal((await limited.response.json() as { error: string }).error, "rate_limited");
		assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
		const anotherIp = await authorizeGuest(req("/api/session", "POST", "", "https://example.test", "198.51.100.2"), env as never);
		assert.equal(await status(anotherIp), 201, "a per-IP rejection does not consume another global slot");
		const globalLimit = await authorizeGuest(req("/api/session", "POST", "", "https://example.test", "198.51.100.3"), env as never);
		assert.equal(await status(globalLimit), 429);
		assert.equal(db.prepare("SELECT count(*) AS n FROM guest_sessions").get()?.n, 3);
		const scopes = db.prepare("SELECT scope FROM guest_session_creation_windows").all();
		assert.ok(!JSON.stringify(scopes).includes("198.51.100."));
	});
	it("rate-limits authenticated requests per session and across sessions", async () => {
		const { env } = setup();
		const a = await create(env), b = await create(env);
		env.GUEST_GLOBAL_REQUESTS_PER_MINUTE = "10";
		env.GUEST_SESSION_REQUESTS_PER_MINUTE = "1";
		assert.equal(await status(await authorizeGuest(req("/api/session", "GET", a), env as never)), 200);
		const limited = await authorizeGuest(req("/api/session", "GET", a), env as never);
		assert.ok("response" in limited);
		assert.equal(limited.response.status, 429);
		assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
		assert.equal(await status(await authorizeGuest(req("/api/session", "GET", b), env as never)), 200);
		const globalCount = (setupEnv: typeof env) => setupEnv.DB.prepare("SELECT request_count FROM guest_request_windows WHERE scope = 'global' ORDER BY window_start DESC LIMIT 1").bind().first();
		assert.equal((await globalCount(env) as { request_count: number }).request_count, 2, "session-rejected requests do not drain global slots");
		const missing = { ...env, GUEST_GLOBAL_REQUESTS_PER_MINUTE: undefined };
		assert.equal(await status(await authorizeGuest(req("/api/session", "GET", b), missing as never)), 503);
	});
	it("does not exceed a session request limit under concurrent requests", async () => {
		const { env } = setup();
		const session = await create(env);
		env.GUEST_GLOBAL_REQUESTS_PER_MINUTE = "60";
		env.GUEST_SESSION_REQUESTS_PER_MINUTE = "5";
		const responses = await Promise.all(Array.from({ length: 20 }, () =>
			authorizeGuest(req("/api/session", "GET", session), env as never)));
		const statuses = await Promise.all(responses.map(status));
		assert.equal(statuses.filter(code => code === 200).length, 5);
		assert.equal(statuses.filter(code => code === 429).length, 15);
	});
	it("cleans old hashed counters and fails closed if D1 is unavailable", async () => {
		const { env, db } = setup();
		db.prepare("INSERT INTO guest_session_creation_windows (scope,window_start,request_count) VALUES (?,?,?)")
			.run("old-hash", Math.floor(Date.now() / 3_600_000) - 25, 1);
		await create(env);
		assert.equal(db.prepare("SELECT count(*) AS n FROM guest_session_creation_windows WHERE scope = 'old-hash'").get()?.n, 0);
		const unavailable = { ...env, DB: { prepare() { throw new Error("private SQL diagnostic"); } } };
		const result = await authorizeGuest(req("/api/session", "POST"), unavailable as never);
		assert.ok("response" in result);
		assert.equal(result.response.status, 503);
		assert.deepEqual(await result.response.json(), { error: "session_unavailable" });
	});
	it("does not exceed the global fixed-window limit under concurrent requests", async () => {
		const { env, db } = setup();
		env.GUEST_SESSION_GLOBAL_PER_HOUR = "5";
		env.GUEST_SESSION_IP_PER_HOUR = "100";
		const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
			authorizeGuest(req("/api/session", "POST", "", "https://example.test", `198.51.100.${i + 1}`), env as never)));
		const statuses = await Promise.all(results.map(status));
		assert.equal(statuses.filter(code => code === 201).length, 5);
		assert.equal(statuses.filter(code => code === 429).length, 15);
		assert.equal(db.prepare("SELECT count(*) AS n FROM guest_sessions").get()?.n, 5);
	});
	it("allows the visitor writes that the demo needs and refuses the rest", async () => {
		const { db, env } = setup();
		const session = await create(env);
		db.prepare("INSERT INTO projects (id, created_at, session_id) VALUES (?, ?, ?)").run("p1", "2026", session.split("=")[1].split(".")[0]);
		for (const path of ["/api/projects", "/api/projects/p1/requirement-text", "/api/projects/p1/upload-sessions",
			"/api/projects/p1/requirement-compile", "/api/projects/p1/history-imports", "/api/projects/p1/pipeline",
			// A visitor may regenerate a report that failed; it never restarts the analysis.
			"/api/projects/p1/pipeline/p1/report"]) {
			assert.equal(await status(await authorizeGuest(req(path, "POST", session), env as never)), 200, path);
		}
		for (const path of ["/api/projects/p1/runs", "/api/projects/p1/spec-assessments", "/api/projects/p1/decisions",
			"/api/projects/p1/reports"]) {
			assert.equal(await status(await authorizeGuest(req(path, "POST", session), env as never)), 503, path);
		}
	});
	it("accepts only the configured origins and the local proxy, not another site", async () => {
		const { env } = setup();
		env.GUEST_PUBLIC_ORIGIN = "https://demo.example.test,http://localhost:5173";
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", "", "https://demo.example.test"), env as never)), 201);
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", "", "http://localhost:5173"), env as never)), 201);
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", "", "https://evil.test"), env as never)), 403);
		assert.equal(await status(await authorizeGuest(req("/api/session", "POST", "", "http://notlocalhost.test"), env as never)), 403);
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
