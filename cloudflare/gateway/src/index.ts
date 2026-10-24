import { Container, getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	SOURCING_CONTAINER: DurableObjectNamespace<Container<Env>>;
	INTERNAL_GATEWAY_TOKEN: string;
	CONTAINER_GATEWAY_URL: string;
	GENESIS_BASE_URL: string;
	GENESIS_ACCESS_TOKEN: string;
	GENESIS_MODEL_ID: string;
	TAVILY_API_KEY: string;
	WORKFLOW: Workflow<RunRequest>;
}

// The container receives the internal token from the Worker at request time so
// that no secret value is baked into the image or the container configuration.

export interface RunRequest {
	runId: string;
	projectId: string;
	durationSeconds: number;
}

interface RunRow {
	id: string;
	project_id: string;
	status: string;
	current_stage: string;
	artifact_key: string | null;
	created_at: string;
	updated_at: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function requireInternal(request: Request, env: Env): Promise<Response | null> {
	const token = request.headers.get("x-internal-token");
	if (!env.INTERNAL_GATEWAY_TOKEN || token !== env.INTERNAL_GATEWAY_TOKEN) {
		return json({ error: "unauthorized" }, 401);
	}
	return null;
}

async function upsertRun(
	env: Env,
	run: RunRequest,
	idempotencyKey?: string,
): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO runs (id, project_id, status, current_stage, idempotency_key, created_at, updated_at)
		 VALUES (?1, ?2, 'QUEUED', 'QUEUED', ?3, ?4, ?4)
		 ON CONFLICT(id) DO UPDATE SET status = 'QUEUED', current_stage = 'QUEUED', updated_at = ?4`,
	)
		.bind(run.runId, run.projectId, idempotencyKey ?? null, now)
		.run();
}

async function updateRun(
	env: Env,
	runId: string,
	status: string,
	stage: string,
	artifactKey?: string | null,
): Promise<void> {
	const now = new Date().toISOString();
	if (artifactKey === undefined) {
		await env.DB.prepare(
			`UPDATE runs SET status = ?2, current_stage = ?3, updated_at = ?4 WHERE id = ?1`,
		)
			.bind(runId, status, stage, now)
			.run();
		return;
	}
	await env.DB.prepare(
		`UPDATE runs SET status = ?2, current_stage = ?3, updated_at = ?4, artifact_key = ?5 WHERE id = ?1`,
	)
		.bind(runId, status, stage, now, artifactKey)
		.run();
}

async function failRun(env: Env, runId: string, reason: string): Promise<void> {
	// Kept separate so a failure never overwrites a produced artifact.
	await env.DB.prepare(
		`UPDATE runs SET status = 'FAILED', current_stage = 'FAILED', updated_at = ?2, last_error = ?3
		 WHERE id = ?1 AND status NOT IN ('COMPLETED')`,
	)
		.bind(runId, new Date().toISOString(), reason.slice(0, 400))
		.run();
}

async function appendEvent(env: Env, runId: string, stage: string, detail: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO run_events (id, run_id, stage, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
	)
		.bind(crypto.randomUUID(), runId, stage, detail, new Date().toISOString())
		.run();
}

export class SourcingContainer extends Container {
	defaultPort = 8000;
	sleepAfter = "10m";
	// Probe the application's own health route so readiness reflects the
	// Python process, not just an open TCP port.
	pingEndpoint = "localhost/health";
}

export class SourcingWorkflow extends WorkflowEntrypoint<Env, RunRequest> {
	async run(event: WorkflowEvent<RunRequest>, step: WorkflowStep) {
		const { runId, durationSeconds } = event.payload;

		try {
			const result = await step.do(
				"execute-container-task",
				{ retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
				async () => {
					const container = getContainer(this.env.SOURCING_CONTAINER, runId);
					const response = await container.fetch(
						new Request("http://container/internal/execute", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								run_id: runId,
								gateway_url: this.env.CONTAINER_GATEWAY_URL,
								token: this.env.INTERNAL_GATEWAY_TOKEN,
								duration_seconds: durationSeconds,
								runtime_config: {
									GENESIS_BASE_URL: this.env.GENESIS_BASE_URL,
									GENESIS_ACCESS_TOKEN: this.env.GENESIS_ACCESS_TOKEN,
									GENESIS_MODEL_ID: this.env.GENESIS_MODEL_ID,
									TAVILY_API_KEY: this.env.TAVILY_API_KEY,
								},
							}),
						}),
					);
					if (!response.ok) {
						const body = await response.text().catch(() => "");
						throw new Error(
							`container task failed with status ${response.status}: ${body.slice(0, 500)}`,
						);
					}
					return (await response.json()) as { artifact?: { key?: string } };
				},
			);

			const artifactKey = result.artifact?.key ?? null;
			await step.do("finalize-run", async () => {
				await updateRun(this.env, runId, "COMPLETED", "REPORTING", artifactKey);
			});

			return { status: "COMPLETED", artifactKey };
		} catch (error) {
			// A run must never stay QUEUED forever: record the failure so the
			// client can see a terminal state and retry explicitly.
			const message = error instanceof Error ? error.message : String(error);
			await step.do("mark-run-failed", async () => {
				await failRun(this.env, runId, message);
				await appendEvent(this.env, runId, "FAILED", message.slice(0, 400));
			});
			throw error;
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/api/health") {
			return json({ status: "ok", service: "procurement-sourcing-gateway" });
		}

		if (url.pathname.startsWith("/internal/")) {
			const unauthorized = await requireInternal(request, env);
			if (unauthorized) return unauthorized;

			const eventMatch = url.pathname.match(/^\/internal\/runs\/([^/]+)\/events$/);
			if (eventMatch && request.method === "POST") {
				const body = (await request.json()) as { stage: string; detail: string };
				await appendEvent(env, eventMatch[1], body.stage, body.detail);
				await updateRun(env, eventMatch[1], "RUNNING", body.stage);
				return json({ ok: true });
			}

			const artifactMatch = url.pathname.match(/^\/internal\/runs\/([^/]+)\/artifacts$/);
			if (artifactMatch && request.method === "POST") {
				const name = url.searchParams.get("name") ?? "report.docx";
				const contentType =
					url.searchParams.get("content_type") ??
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
				const key = `workspaces/default/projects/${artifactMatch[1]}/reports/${artifactMatch[1]}/${name}`;
				const body = await request.arrayBuffer();
				await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
				await updateRun(env, artifactMatch[1], "RUNNING", "REPORTING", key);
				return json({ ok: true, key, bytes: body.byteLength });
			}

			return json({ error: "not_found" }, 404);
		}

		if (request.method === "POST" && url.pathname === "/api/projects") {
			const body = (await request.json().catch(() => ({}))) as { title?: string };
			const projectId = crypto.randomUUID();
			await env.DB.prepare(`INSERT INTO projects (id, title, created_at) VALUES (?1, ?2, ?3)`)
				.bind(projectId, body.title ?? "未命名寻源项目", new Date().toISOString())
				.run();
			return json({ project_id: projectId }, 201);
		}

		const runsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
		if (runsMatch && request.method === "POST") {
			const projectId = runsMatch[1];
			const body = (await request.json().catch(() => ({}))) as {
				duration_seconds?: number;
				idempotency_key?: string;
			};
			const durationSeconds = body.duration_seconds ?? 150;

			// An idempotency key makes a repeated request return the same run
			// instead of starting a second research task and paying for it.
			if (body.idempotency_key) {
				const existing = await env.DB.prepare(
					`SELECT id, status FROM runs WHERE project_id = ?1 AND idempotency_key = ?2`,
				)
					.bind(projectId, body.idempotency_key)
					.first<{ id: string; status: string }>();
				if (existing) {
					return json({ run_id: existing.id, status: existing.status, reused: true });
				}
			}

			const runId = crypto.randomUUID();
			await upsertRun(env, { runId, projectId, durationSeconds }, body.idempotency_key);
			await env.WORKFLOW.create({ params: { runId, projectId, durationSeconds } });
			return json({ run_id: runId, status: "QUEUED" }, 202);
		}

		const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
		if (runMatch && request.method === "GET") {
			const run = await env.DB.prepare(
				`SELECT id, project_id, status, current_stage, artifact_key, created_at, updated_at
				 FROM runs WHERE id = ?1`,
			)
				.bind(runMatch[1])
				.first<RunRow>();
			if (!run) return json({ error: "not_found" }, 404);
			return json(run);
		}

		const eventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
		if (eventsMatch && request.method === "GET") {
			const { results } = await env.DB.prepare(
				`SELECT stage, detail, created_at FROM run_events WHERE run_id = ?1 ORDER BY created_at ASC`,
			)
				.bind(eventsMatch[1])
				.all();
			return json({ events: results });
		}

		const downloadMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/report\/download$/);
		if (downloadMatch && request.method === "GET") {
			const run = await env.DB.prepare(`SELECT artifact_key FROM runs WHERE id = ?1`)
				.bind(downloadMatch[1])
				.first<{ artifact_key: string | null }>();
			if (!run?.artifact_key) return json({ error: "artifact_not_ready" }, 404);
			const object = await env.BUCKET.get(run.artifact_key);
			if (!object) return json({ error: "artifact_missing" }, 404);
			return new Response(object.body, {
				headers: {
					"content-type":
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"content-disposition": `attachment; filename="report.docx"`,
				},
			});
		}

		return json({ error: "not_found" }, 404);
	},
};
