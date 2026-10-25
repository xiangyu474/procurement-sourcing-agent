import { Container, getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	SOURCING_CONTAINER: DurableObjectNamespace<Container<Env>>;
	INTERNAL_GATEWAY_TOKEN: string;
	DEMO_ACCESS_TOKEN: string;
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

interface ProjectRow {
	id: string;
	title: string;
	analysis_version: number;
	demand_revision: number;
	history_availability: string;
	created_at: string;
}

interface SourceInputRow {
	id: string;
	project_id: string;
	purpose: string;
	source_type: string;
	revision: number;
	filename: string | null;
	media_type: string;
	sha256: string;
	r2_key: string | null;
	text_content: string | null;
	created_at: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const digest = await crypto.subtle.digest("SHA-256", input);
	return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

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

async function requireDemoAccess(request: Request, env: Env): Promise<Response | null> {
	if (!env.DEMO_ACCESS_TOKEN) return json({ error: "demo_access_not_configured" }, 503);
	if (request.headers.get("authorization") !== `Bearer ${env.DEMO_ACCESS_TOKEN}`) {
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

		if (url.pathname.startsWith("/api/")) {
			const unauthorized = await requireDemoAccess(request, env);
			if (unauthorized) return unauthorized;
		}

		if (url.pathname.startsWith("/internal/")) {
			const unauthorized = await requireInternal(request, env);
			if (unauthorized) return unauthorized;

			const inputMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/inputs\/([^/]+)$/);
			if (inputMatch && request.method === "GET") {
				const source = await env.DB.prepare(
					`SELECT id, project_id, r2_key, media_type FROM source_inputs WHERE project_id = ?1 AND id = ?2`,
				)
					.bind(inputMatch[1], inputMatch[2])
					.first<{ id: string; project_id: string; r2_key: string | null; media_type: string }>();
				if (!source?.r2_key) return json({ error: "source_not_found" }, 404);
				const object = await env.BUCKET.get(source.r2_key);
				if (!object) return json({ error: "source_object_missing" }, 404);
				return new Response(object.body, { headers: { "content-type": source.media_type } });
			}

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
			const body = (await request.json().catch(() => ({}))) as {
				title?: string;
				requirement_text?: string;
			};
			const text = body.requirement_text?.trim() ?? "";
			if (text.length > 100_000) return json({ error: "requirement_text_too_large" }, 413);
			const projectId = crypto.randomUUID();
			const now = new Date().toISOString();
			const analysisVersion = text ? 1 : 0;
			await env.DB.prepare(
				`INSERT INTO projects (id, title, created_at, analysis_version, demand_revision, history_availability)
				 VALUES (?1, ?2, ?3, ?4, ?5, 'NOT_PROVIDED')`,
			)
				.bind(projectId, body.title ?? "未命名寻源项目", now, analysisVersion, text ? 1 : 0)
				.run();
			let sourceId: string | null = null;
			if (text) {
				sourceId = crypto.randomUUID();
				const digest = await sha256Hex(new TextEncoder().encode(text));
				await env.DB.prepare(
					`INSERT INTO source_inputs
					 (id, project_id, purpose, source_type, revision, filename, media_type, sha256, r2_key, text_content, created_at)
					 VALUES (?1, ?2, 'REQUIREMENT', 'USER_TEXT', 1, NULL, 'text/plain; charset=utf-8', ?3, NULL, ?4, ?5)`,
				)
					.bind(sourceId, projectId, digest, text, now)
					.run();
			}
			return json({ project_id: projectId, source_id: sourceId, analysis_version: analysisVersion }, 201);
		}

		const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
		if (projectMatch && request.method === "GET") {
			const project = await env.DB.prepare(
				`SELECT id, title, analysis_version, demand_revision, history_availability, created_at FROM projects WHERE id = ?1`,
			)
				.bind(projectMatch[1])
				.first<ProjectRow>();
			if (!project) return json({ error: "not_found" }, 404);
			const { results: sources } = await env.DB.prepare(
				`SELECT id, purpose, source_type, revision, filename, media_type, sha256, created_at
				 FROM source_inputs WHERE project_id = ?1 ORDER BY created_at ASC`,
			)
				.bind(projectMatch[1])
				.all();
			return json({ ...project, sources });
		}

		const textMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirement-text$/);
		if (textMatch && request.method === "POST") {
			const projectId = textMatch[1];
			const project = await env.DB.prepare(`SELECT id FROM projects WHERE id = ?1`)
				.bind(projectId)
				.first<{ id: string }>();
			if (!project) return json({ error: "not_found" }, 404);
			const body = (await request.json().catch(() => ({}))) as { text?: string };
			const text = body.text?.trim() ?? "";
			if (!text) return json({ error: "requirement_text_required" }, 422);
			if (text.length > 100_000) return json({ error: "requirement_text_too_large" }, 413);
			const current = await env.DB.prepare(
				`SELECT COALESCE(MAX(revision), 0) AS revision FROM source_inputs
				 WHERE project_id = ?1 AND purpose = 'REQUIREMENT' AND source_type = 'USER_TEXT'`,
			)
				.bind(projectId)
				.first<{ revision: number }>();
			const revision = (current?.revision ?? 0) + 1;
			const sourceId = crypto.randomUUID();
			const now = new Date().toISOString();
			const digest = await sha256Hex(new TextEncoder().encode(text));
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO source_inputs
					 (id, project_id, purpose, source_type, revision, filename, media_type, sha256, r2_key, text_content, created_at)
					 VALUES (?1, ?2, 'REQUIREMENT', 'USER_TEXT', ?3, NULL, 'text/plain; charset=utf-8', ?4, NULL, ?5, ?6)`,
				).bind(sourceId, projectId, revision, digest, text, now),
				env.DB.prepare(`UPDATE projects SET analysis_version = analysis_version + 1, demand_revision = demand_revision + 1 WHERE id = ?1`).bind(projectId),
			]);
			return json({ project_id: projectId, source_id: sourceId, revision }, 201);
		}

		const uploadMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/upload-sessions$/);
		if (uploadMatch && request.method === "POST") {
			const projectId = uploadMatch[1];
			const project = await env.DB.prepare(`SELECT id FROM projects WHERE id = ?1`)
				.bind(projectId)
				.first<{ id: string }>();
			if (!project) return json({ error: "not_found" }, 404);
			const form = await request.formData();
			const purpose = form.get("purpose");
			const file = form.get("file");
			if (typeof purpose !== "string" || !(file instanceof File)) {
				return json({ error: "purpose_and_file_required" }, 422);
			}
			const filename = file.name ?? "upload.bin";
			const extension = filename.toLowerCase().split(".").pop();
			const allowed =
				(purpose === "REQUIREMENT" && extension === "pptx") ||
				(purpose === "HISTORY" && extension === "xlsx");
			if (!allowed) return json({ error: "unsupported_file_for_purpose" }, 415);
			if (file.size <= 0 || file.size > 32 * 1024 * 1024) {
				return json({ error: "file_size_out_of_range" }, 413);
			}
			const sourceId = crypto.randomUUID();
			const bytes = await file.arrayBuffer();
			const digest = await sha256Hex(bytes);
			const key = `workspaces/default/projects/${projectId}/inputs/${sourceId}/${sourceId}.${extension}`;
			const mediaType = purpose === "REQUIREMENT"
				? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
				: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
			await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mediaType } });
			const current = await env.DB.prepare(
				`SELECT COALESCE(MAX(revision), 0) AS revision FROM source_inputs WHERE project_id = ?1 AND purpose = ?2`,
			)
				.bind(projectId, purpose)
				.first<{ revision: number }>();
			const revision = (current?.revision ?? 0) + 1;
			await env.DB.prepare(
				`INSERT INTO source_inputs
				 (id, project_id, purpose, source_type, revision, filename, media_type, sha256, r2_key, text_content, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)`,
			)
				.bind(
					sourceId,
					projectId,
					purpose,
					purpose === "REQUIREMENT" ? "INTERNAL_PPTX" : "INTERNAL_XLSX",
					revision,
					filename,
					mediaType,
					digest,
					key,
					new Date().toISOString(),
				)
				.run();
			if (purpose === "REQUIREMENT") {
				await env.DB.prepare(`UPDATE projects SET analysis_version = analysis_version + 1, demand_revision = demand_revision + 1 WHERE id = ?1`)
					.bind(projectId)
					.run();
			}
			return json({ source_id: sourceId, purpose, revision, r2_key: key, sha256: digest }, 201);
		}

		const compileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirement-compile$/);
		if (compileMatch && request.method === "POST") {
			const projectId = compileMatch[1];
			const project = await env.DB.prepare(
				`SELECT id, analysis_version, demand_revision FROM projects WHERE id = ?1`,
			)
				.bind(projectId)
				.first<{ id: string; analysis_version: number; demand_revision: number }>();
			if (!project) return json({ error: "not_found" }, 404);
			const { results } = await env.DB.prepare(
				`SELECT id, source_type, revision, filename, text_content FROM source_inputs
				 WHERE project_id = ?1 AND purpose = 'REQUIREMENT' ORDER BY revision ASC`,
			)
				.bind(projectId)
				.all<{
					id: string;
					source_type: string;
					revision: number;
					filename: string | null;
					text_content: string | null;
				}>();
			const latestTextRevision = Math.max(
				0,
				...results.filter(s => s.source_type === "USER_TEXT").map(s => s.revision),
			);
			const textSources = results
				.filter(s => s.source_type === "USER_TEXT" && s.text_content && s.revision === latestTextRevision)
				.map(s => ({ source_id: s.id, revision: s.revision, text: s.text_content }));
			const pptxSources = results
				.filter(s => s.source_type === "INTERNAL_PPTX")
				.map(s => ({ source_id: s.id, filename: s.filename ?? "requirement.pptx", revision: s.revision }));
			if (textSources.length === 0 && pptxSources.length === 0) {
				return json({ error: "at least one demand source (text or PPTX) is required" }, 422);
			}

			const container = getContainer(env.SOURCING_CONTAINER, `compile:${projectId}:${project.analysis_version}`);
			const response = await container.fetch(
				new Request("http://container/internal/compile-demand", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						project_id: projectId,
						analysis_version: project.analysis_version,
						gateway_url: env.CONTAINER_GATEWAY_URL,
						token: env.INTERNAL_GATEWAY_TOKEN,
						runtime_config: {
							GENESIS_BASE_URL: env.GENESIS_BASE_URL,
							GENESIS_ACCESS_TOKEN: env.GENESIS_ACCESS_TOKEN,
							GENESIS_MODEL_ID: env.GENESIS_MODEL_ID,
						},
						text_sources: textSources,
						pptx_sources: pptxSources,
					}),
				}),
			);
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				return json({ error: "requirement_compilation_failed", detail: detail.slice(0, 500) }, response.status);
			}
			const compilation = await response.json();
			const compilationId = crypto.randomUUID();
			const now = new Date().toISOString();
			const sourcesJson = JSON.stringify(results.map(s => s.id));
			await env.DB.prepare(
				`INSERT INTO demand_compilations (id, project_id, demand_revision, analysis_version, compiler_version, compilation_json, source_refs_json, created_at)
				 VALUES (?1, ?2, ?3, ?4, 'm1-0.1.0', ?5, ?6, ?7)
				 ON CONFLICT(project_id, demand_revision) DO UPDATE SET
					 compilation_json = excluded.compilation_json,
					 source_refs_json = excluded.source_refs_json,
					 created_at = excluded.created_at`,
			)
				.bind(compilationId, projectId, project.demand_revision, project.analysis_version, JSON.stringify(compilation), sourcesJson, now)
				.run();
			return json({ project_id: projectId, analysis_version: project.analysis_version, compilation });
		}

		const requirementsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirements$/);
		if (requirementsMatch && request.method === "GET") {
			const projectId = requirementsMatch[1];
			const row = await env.DB.prepare(
				`SELECT analysis_version, compilation_json FROM demand_compilations
				 WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`
			)
				.bind(projectId)
				.first<{ analysis_version: number; compilation_json: string }>();
			if (!row) return json({ error: "not_compiled" }, 404);
			return json({ analysis_version: row.analysis_version, compilation: JSON.parse(row.compilation_json) });
		}

		const historyImportMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/history-imports$/);
		if (historyImportMatch && request.method === "POST") {
			const projectId = historyImportMatch[1];
			const body = (await request.json().catch(() => ({}))) as { source_id?: string };
			if (!body.source_id) return json({ error: "source_id_required" }, 422);
			const source = await env.DB.prepare(
				`SELECT id, filename, sha256, r2_key FROM source_inputs
				 WHERE project_id = ?1 AND id = ?2 AND purpose = 'HISTORY'`,
			)
				.bind(projectId, body.source_id)
				.first<{ id: string; filename: string; sha256: string; r2_key: string }>();
			if (!source) return json({ error: "history_source_not_found" }, 404);
			const existing = await env.DB.prepare(
				`SELECT id, row_count, column_count, header_row, is_synthetic, analysis_version
				 FROM history_datasets WHERE project_id = ?1 AND content_sha256 = ?2`,
			)
				.bind(projectId, source.sha256)
				.first<Record<string, unknown>>();
			if (existing) return json({ ...existing, duplicate_import: true });

			const container = getContainer(env.SOURCING_CONTAINER, `import:${projectId}:${source.sha256}`);
			const response = await container.fetch(
				new Request("http://container/internal/import-history", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						project_id: projectId,
						source_id: source.id,
						filename: source.filename,
						sha256: source.sha256,
						gateway_url: env.CONTAINER_GATEWAY_URL,
						token: env.INTERNAL_GATEWAY_TOKEN,
					}),
				}),
			);
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				return json({ error: "history_import_failed", detail: detail.slice(0, 500) }, response.status);
			}
			const imported = (await response.json()) as {
				dataset_id: string;
				row_count: number;
				column_count: number;
				header_row: number;
				is_synthetic: boolean;
				supplier_namespace: string;
				schema_mapping_version: string;
				duplicate_import: boolean;
				warnings: string[];
				sha256: string;
				transactions: unknown[];
			};
			const normalizedKey = `workspaces/default/projects/${projectId}/history/${imported.dataset_id}/normalized.json`;
			await env.BUCKET.put(normalizedKey, JSON.stringify(imported), {
				httpMetadata: { contentType: "application/json; charset=utf-8" },
			});
			const analysisVersion = await env.DB.prepare(
				`UPDATE projects SET analysis_version = analysis_version + 1, history_availability = 'IMPORTED'
				 WHERE id = ?1 RETURNING analysis_version`,
			)
				.bind(projectId)
				.first<{ analysis_version: number }>();
			const importedAt = new Date().toISOString();
			await env.DB.prepare(
				`INSERT INTO history_datasets
				 (id, project_id, source_input_id, content_sha256, row_count, column_count, header_row,
				  is_synthetic, supplier_namespace, schema_mapping_version, normalized_r2_key, analysis_version, imported_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'history-map-m1-0.1.0', ?10, ?11, ?12)`,
			)
				.bind(
					imported.dataset_id, projectId, source.id, imported.sha256,
					imported.row_count, imported.column_count, imported.header_row,
					imported.is_synthetic ? 1 : 0, imported.supplier_namespace,
					normalizedKey, analysisVersion?.analysis_version ?? 1, importedAt,
				)
				.run();
			const { transactions: _privateRows, ...summary } = imported;
			return json({ ...summary, normalized_r2_key: normalizedKey, analysis_version: analysisVersion?.analysis_version });
		}

		const runsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
		if (runsMatch && request.method === "POST") {
			const projectId = runsMatch[1];
			const body = (await request.json().catch(() => ({}))) as {
				duration_seconds?: number;
				idempotency_key?: string;
			};
			const durationSeconds = body.duration_seconds ?? 150;
			const project = await env.DB.prepare(
				`SELECT id, demand_revision FROM projects WHERE id = ?1`,
			)
				.bind(projectId)
				.first<{ id: string; demand_revision: number }>();
			if (!project) return json({ error: "not_found" }, 404);
			const compiled = await env.DB.prepare(
				`SELECT compilation_json FROM demand_compilations WHERE project_id = ?1 AND demand_revision = ?2`,
			)
				.bind(projectId, project.demand_revision)
				.first<{ compilation_json: string }>();
			if (!compiled) return json({ error: "demand_not_compiled" }, 422);
			const demandData = JSON.parse(compiled.compilation_json) as {
				requirements?: unknown[];
				unstructured_requirements?: unknown[];
			};
			if (!demandData.requirements?.length && !demandData.unstructured_requirements?.length) {
				return json({ error: "no_recognizable_demand" }, 422);
			}

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
