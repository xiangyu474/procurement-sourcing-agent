/**
 * Tests for the contracts of the gateway routes.
 *
 * They run without a Cloudflare account: `node --experimental-strip-types
 * --test cloudflare/gateway/test/*.test.ts`. What they check is what a
 * browser would notice: the credentials, the parameters of the statements,
 * the shape of the answers, and what happens when the database refuses.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	checkInternalAuth,
	checkPublicAuth,
	compileStatusSql,
	errorJson,
	jobStatusSql,
	okJson,
	placeholderCount,
	projectRunsSql,
	projectsListSql,
	reportAssessmentsSql,
	reportCandidatesSql,
	reportStatusSql,
	reportsListSql,
	requirementTextSql,
	runQuery,
	shapeJobStatus,
	shapeProject,
	shapeReport,
	shapeRun,
} from "../src/gateway_contracts.ts";

const ENV = { DEMO_ACCESS_TOKEN: "public-token", INTERNAL_GATEWAY_TOKEN: "internal-token" };

function request(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://gateway.invalid${path}`, { headers });
}

describe("the credentials of the public routes", () => {
	it("refuses a request without a token", async () => {
		const response = checkPublicAuth(request("/api/projects"), ENV);

		assert.ok(response);
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: "unauthorized" });
	});

	it("refuses a request with the wrong token", async () => {
		const response = checkPublicAuth(
			request("/api/projects", { authorization: "Bearer wrong" }),
			ENV,
		);

		assert.ok(response);
		assert.equal(response.status, 401);
	});

	it("refuses a request that carries the internal token", async () => {
		const response = checkPublicAuth(
			request("/api/projects", { authorization: "Bearer internal-token" }),
			ENV,
		);

		assert.ok(response);
		assert.equal(response.status, 401);
	});

	it("lets a request with the right token through", () => {
		assert.equal(
			checkPublicAuth(request("/api/projects", { authorization: "Bearer public-token" }), ENV),
			null,
		);
	});

	it("says that the token is not configured instead of pretending", () => {
		const response = checkPublicAuth(request("/api/projects"), {});

		assert.ok(response);
		assert.equal(response.status, 503);
	});
});

describe("the credentials of the internal routes", () => {
	it("refuses a request without the internal token", async () => {
		const response = checkInternalAuth(request("/internal/projects/p1/report-context"), ENV);

		assert.ok(response);
		assert.equal(response.status, 401);
	});

	it("refuses a request with the public token", () => {
		const response = checkInternalAuth(
			request("/internal/projects/p1/report-context", { "x-internal-token": "public-token" }),
			ENV,
		);

		assert.ok(response);
		assert.equal(response.status, 401);
	});

	it("lets the container through", () => {
		assert.equal(
			checkInternalAuth(
				request("/internal/projects/p1/report-context", { "x-internal-token": "internal-token" }),
				ENV,
			),
			null,
		);
	});
});

describe("the statements of the new routes", () => {
	it("bind one parameter for the project list", () => {
		assert.equal(placeholderCount(projectsListSql), 1);
	});

	it("bind one parameter for the runs of a project", () => {
		assert.equal(placeholderCount(projectRunsSql), 1);
	});

	it("bind one parameter for the text of a revision", () => {
		assert.equal(placeholderCount(requirementTextSql), 1);
	});

	it("bind the project and the compile for the state of a compile", () => {
		assert.equal(placeholderCount(compileStatusSql), 2);
	});

	it("bind the project and the kind of task for its state", () => {
		assert.equal(placeholderCount(jobStatusSql), 2);
	});

	it("bind the project for the reports", () => {
		assert.equal(placeholderCount(reportsListSql), 1);
		assert.equal(placeholderCount(reportStatusSql), 2);
	});

	it("bind the project for the report context", () => {
		assert.equal(placeholderCount(reportCandidatesSql), 1);
		assert.equal(placeholderCount(reportAssessmentsSql), 1);
	});

	it("never leave a placeholder without a number", () => {
		for (const statement of [
			projectsListSql,
			projectRunsSql,
			requirementTextSql,
			compileStatusSql,
			jobStatusSql,
			reportsListSql,
			reportStatusSql,
			reportCandidatesSql,
			reportAssessmentsSql,
		]) {
			for (const placeholder of statement.match(/\?\d+/g) ?? []) {
				assert.match(placeholder, /^\?[1-9][0-9]*$/);
			}
		}
	});
});

describe("the shape of the answers", () => {
	it("gives a project its latest run, or none", () => {
		const withRun = shapeProject({
			id: "p1",
			title: "项目",
			history_availability: "NOT_PROVIDED",
			demand_revision: 1,
			analysis_version: 2,
			created_at: "2026-10-31T00:00:00.000Z",
			run_id: "r1",
			run_status: "PARTIAL",
			run_stage: "PARTIAL",
			run_updated_at: "2026-10-31T00:04:00.000Z",
		});
		assert.equal(withRun.latest_run !== null, true);
		assert.equal((withRun.latest_run as Record<string, unknown>).status, "PARTIAL");

		const withoutRun = shapeProject({ id: "p2", run_id: null });
		assert.equal(withoutRun.latest_run, null);
	});

	it("gives a run its reason for being partial", () => {
		const row = shapeRun({
			id: "r1",
			status: "PARTIAL",
			current_stage: "PARTIAL",
			last_error: null,
			stop_reason_code: "BUDGET_EXHAUSTED",
			artifact_key: null,
			created_at: "2026-10-31T00:03:00.000Z",
			updated_at: "2026-10-31T00:04:00.000Z",
		});

		assert.equal(row.stop_reason_code, "BUDGET_EXHAUSTED");
		assert.equal(row.artifact_key_present, false);
	});

	it("gives a report its download path", () => {
		const row = shapeReport({ id: "rep1", status: "COMPLETED" }, "p1");

		assert.equal(row.download_path, "/api/projects/p1/reports/rep1/download");
		assert.equal(row.status, "COMPLETED");
	});

	it("says that a task has not started", () => {
		const row = shapeJobStatus(null, 3);

		assert.equal(row.status, "IDLE");
		assert.equal(row.job_id, null);
		assert.equal(row.demand_revision, 3);
	});

	it("reads the state of a task and its detail", () => {
		const row = shapeJobStatus(
			{
				id: "job1",
				status: "COMPLETED",
				error: null,
				detail_json: JSON.stringify({ assessments: 3 }),
				created_at: "2026-10-31T00:00:00.000Z",
				updated_at: "2026-10-31T00:05:00.000Z",
			},
			2,
		);

		assert.equal(row.status, "COMPLETED");
		assert.equal(row.job_id, "job1");
		assert.deepEqual(row.detail, { assessments: 3 });
	});

	it("survives a detail that is not readable", () => {
		const row = shapeJobStatus(
			{ id: "job2", status: "FAILED", error: "the model failed", detail_json: "not json" },
			1,
		);

		assert.equal(row.status, "FAILED");
		assert.deepEqual(row.detail, {});
	});
});

describe("the answers themselves", () => {
	it("are json with a status", async () => {
		const response = okJson({ status: "ok" }, 202);

		assert.equal(response.status, 202);
		assert.equal(response.headers.get("content-type"), "application/json");
		assert.deepEqual(await response.json(), { status: "ok" });
	});

	it("name the error without a code that leaks", async () => {
		const response = errorJson("unauthorized", 401);

		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: "unauthorized" });
	});
});

describe("a database that refuses", () => {
	it("becomes a short error instead of a stack trace", async () => {
		const statement = {
			bind: () => ({
				first: async () => null,
				all: async () => {
					throw new Error("D1_ERROR: no such column: secret_column");
				},
			}),
		};
		const result = await runQuery(statement, ["p1"]);

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error, "database_error");
			assert.equal(result.error.includes("secret_column"), false);
		}
	});

	it("lets the rows through when the database answers", async () => {
		const statement = {
			bind: (...values: unknown[]) => ({
				first: async () => null,
				all: async () => ({ results: [{ id: "p1", values }] }),
			}),
		};
		const result = await runQuery<{ id: string; values: unknown[] }>(statement, ["p1"]);

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.rows.length, 1);
			assert.deepEqual(result.rows[0].values, ["p1"]);
		}
	});
});
