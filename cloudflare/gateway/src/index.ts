import { Container, getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { authorizeGuest } from "./guest_session";
import { retryContainerNotRunning } from "./container_startup";
import { readPipelineDemand, reservePipeline, storePipelineSnapshot } from "./pipeline_store";
import { ProcurementPipelineWorkflow, type PipelineRequest } from "./pipeline_workflow";
import { startPipelineReport } from "./pipeline_report";
import { shapePipelineAnalysis } from "./pipeline_analysis";
import { listProjectPipelines } from "./pipeline_discovery";
import { evidenceDisplayExcerpt } from "./evidence_excerpt";
import { guestEvent, guestRun, guestRunSummary, guestStage, guestStopReason } from "./guest_public";
import { guestAdmissionPolicy, releaseGuestAdmission, reserveGuestTask } from "./guest_admission";
export { ProcurementPipelineWorkflow };
import {
	checkInternalAuth,
	checkPublicAuth,
	compileStatusSql,
	guestProjectsListSql,
	jobStatusSql,
	projectRunsSql,
	projectsListSql,
	reportAssessmentsSql,
	reportCandidatesSql,
	reportStatusSql,
	reportsListSql,
	requirementTextSql,
	shapeJobStatus,
	shapeProject,
	shapeReport,
	shapeRun,
} from "./gateway_contracts";

export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	SOURCING_CONTAINER: DurableObjectNamespace<Container<Env>>;
	INTERNAL_GATEWAY_TOKEN: string;
	DEMO_ACCESS_TOKEN: string;
	GUEST_SESSION_ENABLED?: string;
	GUEST_SESSION_SECRET?: string;
	GUEST_PUBLIC_ORIGIN?: string;
	GUEST_SESSION_GLOBAL_PER_HOUR?: string;
	GUEST_SESSION_IP_PER_HOUR?: string;
	GUEST_GLOBAL_REQUESTS_PER_MINUTE?: string;
	GUEST_SESSION_REQUESTS_PER_MINUTE?: string;
	GUEST_TASK_GLOBAL_CONCURRENT?: string;
	GUEST_TASK_SESSION_CONCURRENT?: string;
	GUEST_TASK_GLOBAL_DAILY_UNITS?: string;
	GUEST_TASK_SESSION_DAILY_UNITS?: string;
	GUEST_TASK_SESSION_DAILY_STARTS?: string;
	PIPELINE_ENABLED?: string;
	CONTAINER_GATEWAY_URL: string;
	CONTAINER_INSTANCE_NAME: string;
	ACCEPTANCE_CONTAINER_NAME: string;
	GENESIS_BASE_URL: string;
	GENESIS_ACCESS_TOKEN: string;
	GENESIS_MODEL_ID: string;
	TAVILY_API_KEY: string;
	LANGSMITH_API_KEY?: string;
	LANGSMITH_TRACING?: string;
	LANGSMITH_PROJECT?: string;
	WORKFLOW: Workflow<RunRequest>;
	COMPILE_WORKFLOW: Workflow<CompileRequest>;
	SPEC_WORKFLOW: Workflow<SpecRequest>;
	DECISION_WORKFLOW: Workflow<DecisionRequest>;
	REPORT_WORKFLOW: Workflow<ReportRequest>;
	ACCEPTANCE_WORKFLOW: Workflow<AcceptanceRequest>;
	PIPELINE_WORKFLOW: Workflow<PipelineRequest>;
}

// The container receives the internal token from the Worker at request time so
// that no secret value is baked into the image or the container configuration.

// The name of the container instance inside the Durable Object comes from the
// configuration. A running container keeps the image it was started with, so a
// new image needs a new name; the name is bumped in wrangler.jsonc.

interface ResearchBudgetConfig {
	max_search_calls: number;
	max_fetches: number;
	max_tasks: number;
	max_rounds: number;
	max_model_calls: number;
}

export interface RunRequest {
	runId: string;
	projectId: string;
	durationSeconds: number;
	mode: "SPIKE" | "SOURCING";
	pipelineId?: string;
	researchBudget?: ResearchBudgetConfig;
}

interface RunRow {
	id: string;
	project_id: string;
	status: string;
	current_stage: string;
	artifact_key: string | null;
	last_error: string | null;
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

interface M2EvidencePayload {
	evidence_id: string;
	workspace_id: string;
	source_type: string;
	source_url: string;
	normalized_url: string;
	title: string;
	publisher: string | null;
	retrieved_at: string;
	locator: string;
	excerpt: string;
	content_sha256: string;
	content_date_hints: string[];
	snapshot_text: string;
	trust_notes: string;
}

interface M2BundlePayload {
	workspace_id: string;
	project_id: string;
	run_id: string;
	status: "COMPLETED" | "PARTIAL" | "FAILED";
	stop_reason_code: string | null;
	plan: Record<string, unknown>;
	plan_history: Record<string, unknown>[];
	tasks: Record<string, unknown>[];
	suppliers: Record<string, unknown>[];
	products: Record<string, unknown>[];
	offerings: Record<string, unknown>[];
	claims: Record<string, unknown>[];
	evidence: M2EvidencePayload[];
	candidates: Record<string, unknown>[];
	actions: Record<string, unknown>[];
	search_calls: number;
	fetch_calls: number;
	model_calls: number;
	prompt_tokens: number;
	completion_tokens: number;
	token_usage_observed: boolean;
	model_call_details: Record<string, unknown>[];
	trace_run_ids: Record<string, string>;
	langsmith_tracing_enabled: boolean;
	reused_intelligence_ids: string[];
	refreshed_intelligence_ids: string[];
	ignored_intelligence_ids: string[];
	warnings: string[];
	completed_at: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

// Budget units are a coarse proxy for provider cost, not money: one unit is a
// demand compilation, four units are a full sourcing and decision pipeline.
const COMPILE_UNITS = 1;
const PIPELINE_UNITS = 4;

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

async function batchD1(env: Env, statements: D1PreparedStatement[]): Promise<void> {
	for (let offset = 0; offset < statements.length; offset += 50) {
		const batch = statements.slice(offset, offset + 50);
		if (batch.length) await env.DB.batch(batch);
	}
}

function stringField(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : "";
}

function optionalStringField(row: Record<string, unknown>, key: string): string | null {
	const value = row[key];
	return typeof value === "string" && value.length ? value : null;
}

function stringArrayField(row: Record<string, unknown>, key: string): string[] {
	const value = row[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeEvidenceUrl(value: string): string {
	const parsed = new URL(value);
	const host = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
	const path = parsed.pathname.replace(/\/{2,}/g, "/") || "/";
	return `${parsed.protocol}//${host}${path}${parsed.search}`;
}

function publicHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return false;
		const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "").replace(/^www\./, "");
		if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".invalid") || host.endsWith(".test") || host.endsWith(".example")) return false;
		if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
		if (parsed.port && !["80", "443"].includes(parsed.port)) return false;
		if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host === "::1") return false;
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
		return true;
	} catch {
		return false;
	}
}

async function existingM2Ids(
	env: Env,
	table: "intelligence_suppliers" | "intelligence_products" | "research_evidence",
	ids: string[],
): Promise<Set<string>> {
	const found = new Set<string>();
	for (let offset = 0; offset < ids.length; offset += 50) {
		const chunk = ids.slice(offset, offset + 50);
		if (!chunk.length) continue;
		const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
		const { results } = await env.DB.prepare(
			`SELECT id FROM ${table} WHERE workspace_id = 'default' AND id IN (${placeholders})`,
		).bind(...chunk).all<{ id: string }>();
		for (const row of results) found.add(row.id);
	}
	return found;
}

async function persistM2ResearchBundle(env: Env, bundle: M2BundlePayload): Promise<{ evidenceCount: number; candidateCount: number }> {
	if (bundle.workspace_id !== "default" || !bundle.project_id || !bundle.run_id || !bundle.plan) {
		throw new Error("invalid M2 bundle scope or plan");
	}
	if (stringField(bundle.plan, "project_id") !== bundle.project_id || stringField(bundle.plan, "run_id") !== bundle.run_id) {
		throw new Error("SourcingPlan project/run scope does not match research bundle");
	}
	if (bundle.plan_history.some(plan => stringField(plan, "project_id") !== bundle.project_id || stringField(plan, "run_id") !== bundle.run_id)) {
		throw new Error("SourcingPlan history contains a mismatched project/run scope");
	}
	if (bundle.evidence.length > 50 || bundle.tasks.length > 3 || bundle.candidates.length > 300) {
		throw new Error("M2 bundle exceeds configured persistence limits");
	}
	const currentPlan = bundle.plan;
	const plans = [...bundle.plan_history, currentPlan];
	const seenRevisions = new Set<number>();
	for (const plan of plans) {
		const revision = typeof plan.plan_revision === "number" ? plan.plan_revision : 0;
		if (!revision || seenRevisions.has(revision)) throw new Error("invalid or duplicate SourcingPlan revision");
		seenRevisions.add(revision);
	}

	const evidenceById = new Map(bundle.evidence.map(evidence => [evidence.evidence_id, evidence]));
	const normalizeQuotedText = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
	for (const evidence of bundle.evidence) {
		if (!/^ev_[a-f0-9]{24}$/.test(evidence.evidence_id) || !evidence.snapshot_text || evidence.snapshot_text.length > 100_000) {
			throw new Error("invalid evidence ID or oversized/empty source snapshot");
		}
		if (!publicHttpUrl(evidence.source_url) || !publicHttpUrl(evidence.normalized_url)) {
			throw new Error("evidence must reference a public http(s) URL");
		}
		if (normalizeEvidenceUrl(evidence.source_url) !== evidence.normalized_url) {
			throw new Error("normalized evidence URL does not match its source URL");
		}
		const snapshotHash = await sha256Hex(new TextEncoder().encode(evidence.snapshot_text));
		if (snapshotHash !== evidence.content_sha256) throw new Error("source snapshot hash mismatch");
		const identity = `default\x1f${evidence.normalized_url}\x1f${evidence.content_sha256}`;
		const evidenceIdHash = await sha256Hex(new TextEncoder().encode(identity));
		if (evidence.evidence_id !== `ev_${evidenceIdHash.slice(0, 24)}`) {
			throw new Error("evidence ID is not bound to normalized URL and content hash");
		}
	}
	const supplierIds = new Set(bundle.suppliers.map(supplier => stringField(supplier, "supplier_id")));
	const productIds = new Set(bundle.products.map(product => stringField(product, "product_id")));
	for (const supplier of bundle.suppliers) {
		for (const evidenceId of stringArrayField(supplier, "evidence_ids")) {
			if (!evidenceById.has(evidenceId)) throw new Error("supplier evidence link references an uncaptured snapshot");
		}
	}
	for (const product of bundle.products) {
		for (const evidenceId of stringArrayField(product, "evidence_ids")) {
			if (!evidenceById.has(evidenceId)) throw new Error("product evidence link references an uncaptured snapshot");
		}
	}
	for (const offering of bundle.offerings) {
		if (!supplierIds.has(stringField(offering, "supplier_id")) || !productIds.has(stringField(offering, "product_id"))) {
			throw new Error("offering references an unknown supplier or product");
		}
		for (const evidenceId of stringArrayField(offering, "evidence_ids")) {
			if (!evidenceById.has(evidenceId)) throw new Error("offering evidence link references an uncaptured snapshot");
		}
	}
	for (const claim of bundle.claims) {
		const evidenceId = stringField(claim, "evidence_id");
		const evidence = evidenceById.get(evidenceId);
		if (!evidence || stringField(claim, "status") !== "SUPPORTED_BY_SOURCE") {
			throw new Error("claim must reference a captured source and remain source-attributed");
		}
		const subjectType = stringField(claim, "subject_type");
		const subjectId = stringField(claim, "subject_ref");
		if (!(subjectType === "SUPPLIER" ? supplierIds.has(subjectId) : subjectType === "PRODUCT_MODEL" && productIds.has(subjectId))) {
			throw new Error("claim subject reference does not resolve to a Supplier or Product");
		}
		if (!normalizeQuotedText(evidence.snapshot_text).includes(normalizeQuotedText(stringField(claim, "source_quote")))) {
			throw new Error("claim quote is not present in its R2-bound source snapshot");
		}
	}
	for (const task of bundle.tasks) {
		const findings = task.findings;
		if (!findings || typeof findings !== "object") continue;
		const finding = findings as Record<string, unknown>;
		for (const evidenceId of stringArrayField(finding, "evidence_ids")) {
			if (!evidenceById.has(evidenceId)) throw new Error("task finding references a snapshot not captured in this run");
		}
		const proposals = Array.isArray(finding.candidate_claims) ? finding.candidate_claims : [];
		for (const proposalValue of proposals) {
			if (!proposalValue || typeof proposalValue !== "object") throw new Error("invalid candidate claim payload");
			const proposal = proposalValue as Record<string, unknown>;
			const supplierEvidence = evidenceById.get(stringField(proposal, "supplier_evidence_id"));
			const productEvidence = evidenceById.get(stringField(proposal, "product_evidence_id"));
			const supplierName = stringField(proposal, "supplier_name");
			const supplierQuote = stringField(proposal, "supplier_name_quote");
			const productQuote = stringField(proposal, "product_name_quote");
			if (
				!supplierEvidence || !productEvidence || !supplierName || !supplierQuote || !productQuote ||
				!normalizeQuotedText(supplierEvidence.snapshot_text).includes(normalizeQuotedText(supplierQuote)) ||
				!normalizeQuotedText(supplierQuote).includes(normalizeQuotedText(supplierName)) ||
				!normalizeQuotedText(productEvidence.snapshot_text).includes(normalizeQuotedText(productQuote))
			) throw new Error("candidate identity quote is not grounded in its cited snapshot");
			const websiteDomain = optionalStringField(proposal, "supplier_website_domain");
			if (websiteDomain && new URL(supplierEvidence.source_url).hostname.toLowerCase().replace(/^www\./, "") !== websiteDomain) {
				throw new Error("supplier website domain does not match the cited source URL");
			}
			const brand = optionalStringField(proposal, "brand");
			const brandQuote = optionalStringField(proposal, "brand_quote");
			if (brand && (!brandQuote || !normalizeQuotedText(productEvidence.snapshot_text).includes(normalizeQuotedText(brandQuote)) || !normalizeQuotedText(brandQuote).includes(normalizeQuotedText(brand)))) {
				throw new Error("brand quote is not grounded in its product snapshot");
			}
			const model = optionalStringField(proposal, "model");
			const modelQuote = optionalStringField(proposal, "model_quote");
			if (model && (!modelQuote || !normalizeQuotedText(productEvidence.snapshot_text).includes(normalizeQuotedText(modelQuote)) || !normalizeQuotedText(modelQuote).includes(normalizeQuotedText(model)))) {
				throw new Error("model quote is not grounded in its product snapshot");
			}
			for (const claimKey of ["supplier_claims", "product_claims"]) {
				const claimProposals = Array.isArray(proposal[claimKey]) ? proposal[claimKey] as Record<string, unknown>[] : [];
				for (const claimProposal of claimProposals) {
					const evidence = evidenceById.get(stringField(claimProposal, "evidence_id"));
					const quote = stringField(claimProposal, "source_quote");
					if (!evidence || !quote || !normalizeQuotedText(evidence.snapshot_text).includes(normalizeQuotedText(quote))) {
						throw new Error("ResearchFinding claim quote is not grounded in its cited snapshot");
					}
				}
			}
		}
	}
	const reusedSupplierRefs = [...new Set(bundle.candidates.map(candidate => stringField(candidate, "supplier_id")).filter(id => id && !supplierIds.has(id)))];
	const reusedProductRefs = [...new Set(bundle.candidates.map(candidate => optionalStringField(candidate, "product_id")).filter((id): id is string => Boolean(id && !productIds.has(id))))];
	const reusedEvidenceRefs = [...new Set(bundle.candidates.flatMap(candidate => stringArrayField(candidate, "evidence_ids")).filter(id => !evidenceById.has(id)))];
	const [knownSupplierRefs, knownProductRefs, knownEvidenceRefs] = await Promise.all([
		existingM2Ids(env, "intelligence_suppliers", reusedSupplierRefs),
		existingM2Ids(env, "intelligence_products", reusedProductRefs),
		existingM2Ids(env, "research_evidence", reusedEvidenceRefs),
	]);
	if (reusedSupplierRefs.some(id => !knownSupplierRefs.has(id)) || reusedProductRefs.some(id => !knownProductRefs.has(id))) {
		throw new Error("ProjectCandidate references unknown Supplier/Product intelligence");
	}
	if (reusedEvidenceRefs.some(id => !knownEvidenceRefs.has(id))) throw new Error("ProjectCandidate references unknown Evidence");

	const evidenceKeys = new Map<string, string>();
	await Promise.all(bundle.evidence.map(async evidence => {
		const key = `workspaces/default/intelligence/evidence/${evidence.evidence_id}/${evidence.content_sha256}.txt`;
		evidenceKeys.set(evidence.evidence_id, key);
		await env.BUCKET.put(key, evidence.snapshot_text, {
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
		});
	}));

	const now = bundle.completed_at;
	const statements: D1PreparedStatement[] = [];
	for (const plan of plans) {
		statements.push(env.DB.prepare(
			`INSERT INTO sourcing_plans (id, workspace_id, project_id, run_id, plan_revision, plan_json, created_at)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6)
			 ON CONFLICT(workspace_id, run_id, plan_revision) DO UPDATE SET plan_json = excluded.plan_json`,
		).bind(
			stringField(plan, "plan_id"), bundle.project_id, bundle.run_id,
			typeof plan.plan_revision === "number" ? plan.plan_revision : 1,
			JSON.stringify(plan), stringField(plan, "created_at") || now,
		));
	}
	for (const task of bundle.tasks) {
		const findings = task.findings;
		statements.push(env.DB.prepare(
			`INSERT INTO research_tasks (workspace_id, project_id, run_id, id, research_question, channel, status, findings_json, created_at)
			 VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
			 ON CONFLICT(workspace_id, run_id, id) DO UPDATE SET status = excluded.status, findings_json = excluded.findings_json`,
		).bind(
			bundle.project_id, bundle.run_id, stringField(task, "task_id"),
			stringField(task, "research_question"), stringField(task, "channel"),
			stringField(task, "status"), findings ? JSON.stringify(findings) : null, now,
		));
	}
	for (const supplier of bundle.suppliers) {
		statements.push(env.DB.prepare(
			`INSERT INTO intelligence_suppliers (id, workspace_id, display_name, website_domain, identity_status, role, first_observed_at, last_observed_at)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7)
			 ON CONFLICT(id) DO UPDATE SET
			 display_name = excluded.display_name,
			 website_domain = COALESCE(intelligence_suppliers.website_domain, excluded.website_domain),
			 role = COALESCE(excluded.role, intelligence_suppliers.role),
			 last_observed_at = MAX(intelligence_suppliers.last_observed_at, excluded.last_observed_at)`,
		).bind(
			stringField(supplier, "supplier_id"), stringField(supplier, "display_name"),
			optionalStringField(supplier, "website_domain"), stringField(supplier, "identity_status"),
			optionalStringField(supplier, "role"), stringField(supplier, "first_observed_at"),
			stringField(supplier, "last_observed_at"),
		));
	}
	for (const product of bundle.products) {
		statements.push(env.DB.prepare(
			`INSERT INTO intelligence_products (id, workspace_id, product_name, brand, model, product_category, first_observed_at, last_observed_at)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7)
			 ON CONFLICT(id) DO UPDATE SET
			 product_name = excluded.product_name,
			 brand = COALESCE(intelligence_products.brand, excluded.brand),
			 model = COALESCE(intelligence_products.model, excluded.model),
			 product_category = COALESCE(intelligence_products.product_category, excluded.product_category),
			 last_observed_at = MAX(intelligence_products.last_observed_at, excluded.last_observed_at)`,
		).bind(
			stringField(product, "product_id"), stringField(product, "product_name"),
			optionalStringField(product, "brand"), optionalStringField(product, "model"),
			optionalStringField(product, "product_category"), stringField(product, "first_observed_at"),
			stringField(product, "last_observed_at"),
		));
	}
	for (const offering of bundle.offerings) {
		statements.push(env.DB.prepare(
			`INSERT INTO supplier_product_offerings (id, workspace_id, supplier_id, product_id, relationship_status, first_observed_at, last_observed_at)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6)
			 ON CONFLICT(id) DO UPDATE SET last_observed_at = MAX(supplier_product_offerings.last_observed_at, excluded.last_observed_at)`,
		).bind(
			stringField(offering, "offering_id"), stringField(offering, "supplier_id"),
			stringField(offering, "product_id"), stringField(offering, "relationship_status"),
			now, now,
		));
	}
	for (const evidence of bundle.evidence) {
		const key = evidenceKeys.get(evidence.evidence_id);
		if (!key) throw new Error("snapshot key missing for evidence");
		statements.push(env.DB.prepare(
			`INSERT INTO research_evidence
			 (id, workspace_id, source_type, source_url, normalized_url, title, publisher, retrieved_at, locator, excerpt, content_sha256, content_date_hints_json, snapshot_r2_key, trust_notes, first_run_id, last_run_id)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
			 ON CONFLICT(id) DO UPDATE SET last_run_id = excluded.last_run_id`,
		).bind(
			evidence.evidence_id, evidence.source_type, evidence.source_url, evidence.normalized_url,
			evidence.title.slice(0, 500), evidence.publisher, evidence.retrieved_at, evidence.locator,
			evidence.excerpt.slice(0, 4000), evidence.content_sha256,
			JSON.stringify(evidence.content_date_hints ?? []), key, evidence.trust_notes, bundle.run_id,
		));
	}
	for (const claim of bundle.claims) {
		statements.push(env.DB.prepare(
			`INSERT INTO research_claims
			 (id, workspace_id, subject_type, subject_id, attribute, value, unit, status, evaluation_method, first_observed_at, last_observed_at)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
			 ON CONFLICT(id) DO UPDATE SET last_observed_at = MAX(research_claims.last_observed_at, excluded.last_observed_at)`,
		).bind(
			stringField(claim, "claim_id"), stringField(claim, "subject_type"),
			stringField(claim, "subject_ref"), stringField(claim, "attribute"),
			stringField(claim, "value"), optionalStringField(claim, "unit"),
			stringField(claim, "status"), stringField(claim, "evaluation_method"), now,
		));
		statements.push(env.DB.prepare(
			`INSERT INTO claim_evidence_links (workspace_id, claim_id, evidence_id, source_quote)
			 VALUES ('default', ?1, ?2, ?3) ON CONFLICT DO NOTHING`,
		).bind(stringField(claim, "claim_id"), stringField(claim, "evidence_id"), stringField(claim, "source_quote")));
	}
	for (const supplier of bundle.suppliers) {
		for (const evidenceId of stringArrayField(supplier, "evidence_ids")) {
			statements.push(env.DB.prepare(
				`INSERT INTO intelligence_entity_evidence VALUES ('default', 'SUPPLIER', ?1, ?2, ?3, ?3) ON CONFLICT DO NOTHING`,
			).bind(stringField(supplier, "supplier_id"), evidenceId, now));
		}
	}
	for (const product of bundle.products) {
		for (const evidenceId of stringArrayField(product, "evidence_ids")) {
			statements.push(env.DB.prepare(
				`INSERT INTO intelligence_entity_evidence VALUES ('default', 'PRODUCT', ?1, ?2, ?3, ?3) ON CONFLICT DO NOTHING`,
			).bind(stringField(product, "product_id"), evidenceId, now));
		}
	}
	for (const offering of bundle.offerings) {
		for (const evidenceId of stringArrayField(offering, "evidence_ids")) {
			statements.push(env.DB.prepare(
				`INSERT INTO intelligence_entity_evidence VALUES ('default', 'OFFERING', ?1, ?2, ?3, ?3) ON CONFLICT DO NOTHING`,
			).bind(stringField(offering, "offering_id"), evidenceId, now));
		}
	}
	for (const task of bundle.tasks) {
		const findings = task.findings;
		if (!findings || typeof findings !== "object") continue;
		for (const evidenceId of stringArrayField(findings as Record<string, unknown>, "evidence_ids")) {
			statements.push(env.DB.prepare(
				`INSERT INTO research_evidence_tasks VALUES ('default', ?1, ?2, ?3) ON CONFLICT DO NOTHING`,
			).bind(bundle.run_id, stringField(task, "task_id"), evidenceId));
		}
	}
	for (const candidate of bundle.candidates) {
		statements.push(env.DB.prepare(
			`INSERT INTO project_candidates
			 (id, workspace_id, project_id, requirement_id, supplier_id, product_id, stage, rationale, open_questions_json, first_seen_run_id, last_seen_run_id, updated_at)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
			 ON CONFLICT(id) DO UPDATE SET stage = CASE
				 WHEN project_candidates.stage IN ('NEEDS_VERIFICATION', 'RFQ_SHORTLIST', 'EXCLUDED')
				 THEN project_candidates.stage ELSE excluded.stage END,
			 rationale = excluded.rationale,
			 open_questions_json = excluded.open_questions_json, last_seen_run_id = excluded.last_seen_run_id, updated_at = excluded.updated_at`,
		).bind(
			stringField(candidate, "candidate_id"), bundle.project_id,
			stringField(candidate, "requirement_id"), stringField(candidate, "supplier_id"),
			optionalStringField(candidate, "product_id"), stringField(candidate, "stage"),
			stringField(candidate, "rationale"), JSON.stringify(candidate.open_questions ?? []),
			bundle.run_id, now,
		));
		for (const evidenceId of stringArrayField(candidate, "evidence_ids")) {
			statements.push(env.DB.prepare(
				`INSERT INTO project_candidate_evidence VALUES ('default', ?1, ?2) ON CONFLICT DO NOTHING`,
			).bind(stringField(candidate, "candidate_id"), evidenceId));
		}
	}
	for (const action of bundle.actions) {
		statements.push(env.DB.prepare(
			`INSERT INTO research_actions
			 (id, workspace_id, project_id, run_id, task_id, research_question, channel, tool_name, query, result_refs_json, remaining_gaps_json, decision, cost_search_calls, cost_fetch_calls, occurred_at)
			 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
			 ON CONFLICT(id) DO NOTHING`,
		).bind(
			stringField(action, "action_id"), bundle.project_id, bundle.run_id,
			stringField(action, "task_id"), stringField(action, "research_question"),
			stringField(action, "channel"), stringField(action, "tool_name"),
			optionalStringField(action, "query"), JSON.stringify(action.result_refs ?? []),
			JSON.stringify(action.remaining_gaps ?? []), stringField(action, "decision"),
			typeof action.cost_search_calls === "number" ? action.cost_search_calls : 0,
			typeof action.cost_fetch_calls === "number" ? action.cost_fetch_calls : 0,
			stringField(action, "occurred_at"),
		));
	}
	statements.push(env.DB.prepare(
		`INSERT INTO research_run_costs
		 (workspace_id, project_id, run_id, status, stop_reason_code, search_calls, fetch_calls, model_calls,
		  prompt_tokens, completion_tokens, token_usage_observed, model_call_details_json, trace_run_ids_json,
		  langsmith_tracing_enabled, candidate_count, evidence_count, reused_intelligence_count,
		  refreshed_intelligence_count, ignored_intelligence_count, warnings_json, updated_at)
		 VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
		 ON CONFLICT(workspace_id, run_id) DO UPDATE SET
		  status = excluded.status, stop_reason_code = excluded.stop_reason_code,
		  search_calls = excluded.search_calls, fetch_calls = excluded.fetch_calls, model_calls = excluded.model_calls,
		  prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
		  token_usage_observed = excluded.token_usage_observed, model_call_details_json = excluded.model_call_details_json,
		  trace_run_ids_json = excluded.trace_run_ids_json, langsmith_tracing_enabled = excluded.langsmith_tracing_enabled,
		  candidate_count = excluded.candidate_count, evidence_count = excluded.evidence_count,
		  reused_intelligence_count = excluded.reused_intelligence_count,
		  refreshed_intelligence_count = excluded.refreshed_intelligence_count,
		  ignored_intelligence_count = excluded.ignored_intelligence_count, warnings_json = excluded.warnings_json,
		  updated_at = excluded.updated_at`,
	).bind(
		bundle.project_id, bundle.run_id, bundle.status, bundle.stop_reason_code,
		bundle.search_calls, bundle.fetch_calls, bundle.model_calls, bundle.prompt_tokens,
		bundle.completion_tokens, bundle.token_usage_observed ? 1 : 0, JSON.stringify(bundle.model_call_details),
		JSON.stringify(bundle.trace_run_ids), bundle.langsmith_tracing_enabled ? 1 : 0,
		bundle.candidates.length, bundle.evidence.length, bundle.reused_intelligence_ids.length,
		bundle.refreshed_intelligence_ids.length, bundle.ignored_intelligence_ids.length,
		JSON.stringify(bundle.warnings), bundle.completed_at,
	));
	await batchD1(env, statements);
	return { evidenceCount: bundle.evidence.length, candidateCount: bundle.candidates.length };
}

export class SourcingContainer extends Container {
	defaultPort = 8000;
	// A sourcing run can hold one request open for many minutes. Keep the
	// instance alive long enough for the run to finish instead of stopping it
	// under the request.
	sleepAfter = "20m";
	// Probe the application's own health route so readiness reflects the
	// Python process, not just an open TCP port.
	pingEndpoint = "localhost/health";

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		// The Python process reads its tracing configuration once, at import
		// time, and the reader caches that lookup. Passing the values when the
		// instance starts is the only way they are seen.
		this.envVars = {
			...(env.LANGSMITH_TRACING ? { LANGSMITH_TRACING: env.LANGSMITH_TRACING } : {}),
			...(env.LANGSMITH_PROJECT ? { LANGSMITH_PROJECT: env.LANGSMITH_PROJECT } : {}),
			...(env.LANGSMITH_API_KEY ? { LANGSMITH_API_KEY: env.LANGSMITH_API_KEY } : {}),
		};
	}
}

interface CompileRequest {
	projectId: string;
	analysisVersion: number;
	demandRevision: number;
	textSources: { source_id: string; revision: number; text: string }[];
	pptxSources: { source_id: string; filename: string; revision: number }[];
	sourceIds: string[];
	jobId: string;
}

export class SourcingCompileWorkflow extends WorkflowEntrypoint<Env, CompileRequest> {
	async run(event: WorkflowEvent<CompileRequest>, step: WorkflowStep) {
		const { projectId, analysisVersion, demandRevision, textSources, pptxSources, sourceIds, jobId } =
			event.payload;
		try {
			const result = await step.do(
				"compile-demand",
				{ retries: { limit: 0, delay: "10 seconds", backoff: "exponential" }, timeout: "20 minutes" },
				async () => {
					const container = getContainer(this.env.SOURCING_CONTAINER, this.env.CONTAINER_INSTANCE_NAME);
					// The instance sleeps when it is idle, so it has to be
					// started before it can answer.
					const response = await retryContainerNotRunning(async () => {
						await container.start();
						await waitForContainer(container);
						return container.fetch(
						new Request("http://container/internal/compile-demand", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								project_id: projectId,
								analysis_version: analysisVersion,
								gateway_url: this.env.CONTAINER_GATEWAY_URL,
								token: this.env.INTERNAL_GATEWAY_TOKEN,
								runtime_config: {
									GENESIS_BASE_URL: this.env.GENESIS_BASE_URL,
									GENESIS_ACCESS_TOKEN: this.env.GENESIS_ACCESS_TOKEN,
									GENESIS_MODEL_ID: this.env.GENESIS_MODEL_ID,
								},
								text_sources: textSources,
								pptx_sources: pptxSources,
							}),
						}),
						);
					}, () => new Promise(resolve => setTimeout(resolve, 3000)));
					if (!response.ok) {
						const body = await response.text().catch(() => "");
						throw new Error(`compile failed with status ${response.status}: ${body.slice(0, 400)}`);
					}
					const compilation = (await response.json()) as {
						requirements?: unknown[];
						conflicts?: unknown[];
					};
					// The step output stays small. The compilation itself is stored
					// in D1, not in the workflow state.
					await this.env.DB.prepare(
						`INSERT INTO demand_compilations (id, project_id, demand_revision, analysis_version, compiler_version, compilation_json, source_refs_json, created_at)
						 VALUES (?1, ?2, ?3, ?4, 'm1-0.1.0', ?5, ?6, ?7)
						 ON CONFLICT(project_id, demand_revision) DO UPDATE SET
							 compilation_json = excluded.compilation_json,
							 source_refs_json = excluded.source_refs_json,
							 created_at = excluded.created_at`,
					)
						.bind(
							crypto.randomUUID(),
							projectId,
							demandRevision,
							analysisVersion,
							JSON.stringify(compilation),
							JSON.stringify(sourceIds),
							new Date().toISOString(),
						)
						.run();
					return {
						requirements: Array.isArray(compilation.requirements) ? compilation.requirements.length : 0,
						conflicts: Array.isArray(compilation.conflicts) ? compilation.conflicts.length : 0,
					};
				},
			);
			await this.env.DB.prepare(
				`UPDATE project_jobs SET status = 'COMPLETED', updated_at = ?2
				 WHERE workspace_id = 'default' AND id = ?1`,
			)
				.bind(jobId, new Date().toISOString())
				.run();
			await releaseGuestAdmission(this.env.DB, jobId, "COMPILE");
			return { status: "COMPLETED", ...result };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			await this.env.DB.prepare(
				`UPDATE project_jobs SET status = 'FAILED', error = ?2, updated_at = ?3
				 WHERE workspace_id = 'default' AND id = ?1`,
			)
				.bind(jobId, detail.slice(0, 500), new Date().toISOString())
				.run();
			await this.env.DB.prepare(
				`INSERT INTO demand_compilations (id, project_id, demand_revision, analysis_version, compiler_version, compilation_json, source_refs_json, created_at)
				 VALUES (?1, ?2, ?3, ?4, 'm1-0.1.0', ?5, ?6, ?7)
				 ON CONFLICT(project_id, demand_revision) DO UPDATE SET
					 compilation_json = excluded.compilation_json,
					 source_refs_json = excluded.source_refs_json,
					 created_at = excluded.created_at`,
			)
				.bind(
					crypto.randomUUID(),
					projectId,
					demandRevision,
					analysisVersion,
					JSON.stringify({ project_id: projectId, analysis_version: analysisVersion, issues: [detail.slice(0, 500)] }),
					JSON.stringify(sourceIds),
					new Date().toISOString(),
				)
				.run();
			await releaseGuestAdmission(this.env.DB, jobId, "COMPILE");
			return { status: "FAILED", error: detail.slice(0, 500) };
		}
	}
}

interface SpecRequest {
	projectId: string;
	requirementIds: string[];
	candidateIds: string[];
	reviewReason: string;
	jobId: string;
}

export interface ReportRequest {
	projectId: string;
	runId: string | null;
	reportId: string;
	pipelineId?: string;
	decisionVersion?: string;
	workflowId?: string;
}

interface DecisionRequest {
	projectId: string;
	requirementIds: string[];
	jobId: string;
}

interface AcceptanceRequest {
	title: string;
	pipeline?: boolean;
}

// The end-to-end acceptance runs on the side of the network that can reach the
// gateway. It is started through the Cloudflare API, so a client whose own
// network cannot resolve the gateway can still run it.
// The stage details travel as one JSON string, because a workflow step output
// has to be serializable.
function _parseStages(value: string | undefined): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Ask the container for something, starting it first.
 *
 * The instance sleeps when it is idle, and a request that arrives while it
 * is waking up can find the port closed. The call is therefore repeated a
 * few times with a short wait in between, which is cheaper than a failed
 * acceptance round.
 */
/** A container that is still waking up refuses connections. Wait for it. */
async function waitForContainer(
	container: { fetch: (request: Request) => Promise<Response> },
	attempts = 40,
): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await container.fetch(new Request("http://container/health"));
			if (response.status < 500) {
				await response.arrayBuffer().catch(() => undefined);
				return true;
			}
		} catch {
			// The container is not accepting connections yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	return false;
}

async function fetchContainer(
	env: Env,
	instanceName: string,
	path: string,
	body: unknown,
): Promise<Response> {
	const container = getContainer(env.SOURCING_CONTAINER, instanceName);
	let lastError = "the container did not answer";
	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			await container.start();
			if (!await waitForContainer(container)) {
				lastError = "the container did not become ready";
				await new Promise((resolve) => setTimeout(resolve, 3000));
				continue;
			}
			const response = await container.fetch(
				new Request(`http://container${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
			if (response.status >= 500) {
				lastError = `the container answered with ${response.status}`;
				await new Promise((resolve) => setTimeout(resolve, 3000));
				continue;
			}
			return response;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
	}
	throw new Error(lastError.slice(0, 300));
}

export class SourcingAcceptanceWorkflow extends WorkflowEntrypoint<Env, AcceptanceRequest> {
	async run(event: WorkflowEvent<AcceptanceRequest>, step: WorkflowStep) {
		const runtimeConfig = {
			GENESIS_BASE_URL: this.env.GENESIS_BASE_URL,
			GENESIS_ACCESS_TOKEN: this.env.GENESIS_ACCESS_TOKEN,
			GENESIS_MODEL_ID: this.env.GENESIS_MODEL_ID,
			TAVILY_API_KEY: this.env.TAVILY_API_KEY,
			...(this.env.LANGSMITH_API_KEY ? { LANGSMITH_API_KEY: this.env.LANGSMITH_API_KEY } : {}),
			...(this.env.LANGSMITH_TRACING ? { LANGSMITH_TRACING: this.env.LANGSMITH_TRACING } : {}),
			...(this.env.LANGSMITH_PROJECT ? { LANGSMITH_PROJECT: this.env.LANGSMITH_PROJECT } : {}),
		};
		const failures: string[] = [];
		const stages: Record<string, unknown> = {};

		const runStage = async (stage: string, projectId: string, runId: string) => {
			const container = getContainer(this.env.SOURCING_CONTAINER, this.env.ACCEPTANCE_CONTAINER_NAME);
			// The instance sleeps when it is idle, so it has to be started
			// before it can answer.
			await container.start();
			const response = await container.fetch(
				new Request("http://container/internal/acceptance", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						gateway_url: this.env.CONTAINER_GATEWAY_URL,
						token: this.env.INTERNAL_GATEWAY_TOKEN,
						demo_token: this.env.DEMO_ACCESS_TOKEN,
						runtime_config: runtimeConfig,
						stage,
						project_id: projectId,
						run_id: runId,
					}),
				}),
			);
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(`the acceptance stage ${stage} failed with status ${response.status}: ${body.slice(0, 300)}`);
			}
			return (await response.json()) as {
				status?: string;
				failures?: string[];
				state?: string;
				done?: boolean;
			};
		};

		// Every container request does one short thing. The waiting is done by
		// asking again, because a container request that waits is a request
		// that can be disconnected.
		try {
			const prepared = await step.do(
				"acceptance-prepare",
				{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
				async () => runStage("prepare", "", ""),
			);
			const projectId = String(_parseStages(prepared.state).project_id ?? "");
			failures.push(...(prepared.failures ?? []));

			let compiled: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 60; attempt += 1) {
				const polled = await step.do(
					`acceptance-compile-${attempt}`,
					{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
					async () => runStage("compile", projectId, ""),
				);
				failures.push(...(polled.failures ?? []));
				Object.assign(stages, _parseStages(polled.state));
				if (polled.done) {
					compiled = _parseStages(polled.state);
					break;
				}
				await step.sleep(`acceptance-compile-wait-${attempt}`, "20 seconds");
			}
			if (!compiled) failures.push("the demand did not compile in time");

			if (event.payload.pipeline) {
				if (!compiled || failures.length) return { status: "FAIL", failures, stages: JSON.stringify(stages) };
				const startedPipeline = await step.do("acceptance-pipeline-start",
					{ retries: { limit: 0, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" },
					async () => runStage("pipeline-start", projectId, ""));
				failures.push(...(startedPipeline.failures ?? []));
				Object.assign(stages, _parseStages(startedPipeline.state));
				const pipelineId = String(_parseStages(startedPipeline.state).pipeline_id ?? "");
				if (!pipelineId) return { status: "FAIL", failures: [...failures, "pipeline did not start"], stages: JSON.stringify(stages) };
				let done = false;
				for (let attempt = 0; attempt < 120; attempt += 1) {
					const result = await step.do(`acceptance-pipeline-${attempt}`,
						{ retries: { limit: 0, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" },
						async () => runStage("pipeline", projectId, pipelineId));
					failures.push(...(result.failures ?? []));
					Object.assign(stages, _parseStages(result.state));
					if (result.done) { done = true; break; }
					await step.sleep(`acceptance-pipeline-wait-${attempt}`, "30 seconds");
				}
				if (!done) failures.push("pipeline did not finish in time");
				return { status: failures.length ? "FAIL" : "PASS", failures: [...new Set(failures)], stages: JSON.stringify(stages) };
			}

			const started = await step.do(
				"acceptance-research-start",
				{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
				async () => runStage("research-start", projectId, ""),
			);
			failures.push(...(started.failures ?? []));
			const runId = String(_parseStages(started.state).run_id ?? "");
			if (!runId) {
				throw new Error("the research run did not start, so the chain cannot continue");
			}

			let researched: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 60; attempt += 1) {
				const polled = await step.do(
					`acceptance-research-${attempt}`,
					{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
					async () => runStage("research", projectId, runId),
				);
				failures.push(...(polled.failures ?? []));
				Object.assign(stages, _parseStages(polled.state));
				if (polled.done) {
					researched = _parseStages(polled.state);
					break;
				}
				await step.sleep(`acceptance-research-wait-${attempt}`, "30 seconds");
			}
			if (!researched) failures.push("the research run did not finish in time");

			await step.do(
				"acceptance-spec-start",
				{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
				async () => runStage("spec-start", projectId, ""),
			);
			let judged: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 60; attempt += 1) {
				const polled = await step.do(
					`acceptance-spec-${attempt}`,
					{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
					async () => runStage("spec", projectId, ""),
				);
				failures.push(...(polled.failures ?? []));
				Object.assign(stages, _parseStages(polled.state));
				if (polled.done) {
					judged = _parseStages(polled.state);
					break;
				}
				await step.sleep(`acceptance-spec-wait-${attempt}`, "30 seconds");
			}
			if (!judged) failures.push("the technical check produced no assessment in time");

			await step.do(
				"acceptance-decide-start",
				{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
				async () => runStage("decide-start", projectId, ""),
			);
			let decided: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 60; attempt += 1) {
				const polled = await step.do(
					`acceptance-decide-${attempt}`,
					{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
					async () => runStage("decision", projectId, ""),
				);
				failures.push(...(polled.failures ?? []));
				Object.assign(stages, _parseStages(polled.state));
				if (polled.done) {
					decided = _parseStages(polled.state);
					break;
				}
				await step.sleep(`acceptance-decide-wait-${attempt}`, "30 seconds");
			}
			if (!decided) failures.push("the decision produced no result in time");

			await step.do(
				"acceptance-report-start",
				{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
				async () => runStage("report-start", projectId, runId),
			);
			let reported: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 30; attempt += 1) {
				const polled = await step.do(
					`acceptance-report-${attempt}`,
					{ retries: { limit: 0, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
					async () => runStage("report", projectId, runId),
				);
				failures.push(...(polled.failures ?? []));
				Object.assign(stages, _parseStages(polled.state));
				if (polled.done) {
					reported = _parseStages(polled.state);
					break;
				}
				await step.sleep(`acceptance-report-wait-${attempt}`, "10 seconds");
			}
			if (!reported) failures.push("the report was not produced in time");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push(message.slice(0, 400));
		}
		const uniqueFailures = [...new Set(failures)];
		return {
			status: uniqueFailures.length === 0 ? "PASS" : "FAIL",
			failures: uniqueFailures,
			// The step output has to be serializable, so the stage details
			// travel as one JSON string.
			stages: JSON.stringify(stages),
		};
	}
}

export class SourcingDecisionWorkflow extends WorkflowEntrypoint<Env, DecisionRequest> {
	async run(event: WorkflowEvent<DecisionRequest>, step: WorkflowStep) {
		const { projectId, requirementIds, jobId } = event.payload;
		try {
			const result = await step.do(
				"write-decisions",
				{ retries: { limit: 1, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" },
				async () => {
					const response = await fetchContainer(
						this.env,
						this.env.CONTAINER_INSTANCE_NAME,
						"/internal/decide",
						{
							project_id: projectId,
							gateway_url: this.env.CONTAINER_GATEWAY_URL,
							token: this.env.INTERNAL_GATEWAY_TOKEN,
							runtime_config: {
								GENESIS_BASE_URL: this.env.GENESIS_BASE_URL,
								GENESIS_ACCESS_TOKEN: this.env.GENESIS_ACCESS_TOKEN,
								GENESIS_MODEL_ID: this.env.GENESIS_MODEL_ID,
								...(this.env.LANGSMITH_API_KEY ? { LANGSMITH_API_KEY: this.env.LANGSMITH_API_KEY } : {}),
								...(this.env.LANGSMITH_TRACING ? { LANGSMITH_TRACING: this.env.LANGSMITH_TRACING } : {}),
								...(this.env.LANGSMITH_PROJECT ? { LANGSMITH_PROJECT: this.env.LANGSMITH_PROJECT } : {}),
							},
							requirement_ids: requirementIds,
						},
					);
					if (!response.ok) {
						const body = await response.text().catch(() => "");
						throw new Error(`decision failed with status ${response.status}: ${body.slice(0, 400)}`);
					}
					// The step output stays small. The decisions themselves are
					// stored in D1 by the container.
					const payload = (await response.json()) as {
						status?: string;
						decisions?: number;
						accepted?: number;
						rejected?: number;
					};
					return {
						status: payload.status ?? "COMPLETED",
						decisions: payload.decisions ?? 0,
						accepted: payload.accepted ?? 0,
						rejected: payload.rejected ?? 0,
					};
				},
			);
			const outcome = result as unknown as {
				status?: string;
				decisions?: number;
				accepted?: number;
				rejected?: number;
			};
			await this.env.DB.prepare(
				`UPDATE project_jobs SET status = 'COMPLETED', detail_json = ?2, updated_at = ?3
				 WHERE workspace_id = 'default' AND id = ?1`,
			)
				.bind(
					jobId,
					JSON.stringify({
						decisions: outcome.decisions ?? 0,
						accepted: outcome.accepted ?? 0,
						rejected: outcome.rejected ?? 0,
					}),
					new Date().toISOString(),
				)
				.run();
			return {
				status: outcome.status ?? "COMPLETED",
				decisions: outcome.decisions ?? 0,
				accepted: outcome.accepted ?? 0,
				rejected: outcome.rejected ?? 0,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.env.DB.prepare(
				`UPDATE project_jobs SET status = 'FAILED', error = ?2, updated_at = ?3
				 WHERE workspace_id = 'default' AND id = ?1`,
			)
				.bind(jobId, message.slice(0, 500), new Date().toISOString())
				.run();
			return { status: "FAILED", error: message.slice(0, 400) };
		}
	}
}

// A stable id for one technical check, so that re-evaluating the same demand
// revision replaces the row instead of adding a second one.
async function stableSpecId(projectId: string, requirementId: string, candidateId: string, revision: number): Promise<string> {
	const payload = [projectId, requirementId, candidateId, String(revision)].join("\u001f");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
	const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `spc_${hex.slice(0, 24)}`;
}

export class SourcingSpecWorkflow extends WorkflowEntrypoint<Env, SpecRequest> {
	async run(event: WorkflowEvent<SpecRequest>, step: WorkflowStep) {
		const { projectId, requirementIds, candidateIds, reviewReason, jobId } = event.payload;
		try {
			const result = await step.do(
				"evaluate-spec",
				{ retries: { limit: 1, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" },
				async () => {
					const response = await fetchContainer(
						this.env,
						this.env.CONTAINER_INSTANCE_NAME,
						"/internal/evaluate-spec",
						{
							project_id: projectId,
							gateway_url: this.env.CONTAINER_GATEWAY_URL,
							token: this.env.INTERNAL_GATEWAY_TOKEN,
							runtime_config: {
								GENESIS_BASE_URL: this.env.GENESIS_BASE_URL,
								GENESIS_ACCESS_TOKEN: this.env.GENESIS_ACCESS_TOKEN,
								GENESIS_MODEL_ID: this.env.GENESIS_MODEL_ID,
								...(this.env.LANGSMITH_API_KEY ? { LANGSMITH_API_KEY: this.env.LANGSMITH_API_KEY } : {}),
								...(this.env.LANGSMITH_TRACING ? { LANGSMITH_TRACING: this.env.LANGSMITH_TRACING } : {}),
								...(this.env.LANGSMITH_PROJECT ? { LANGSMITH_PROJECT: this.env.LANGSMITH_PROJECT } : {}),
							},
							requirement_ids: requirementIds,
							candidate_ids: candidateIds,
							review_reason: reviewReason,
						},
					);
					if (!response.ok) {
						const body = await response.text().catch(() => "");
						throw new Error(`spec evaluation failed with status ${response.status}: ${body.slice(0, 400)}`);
					}
					// The step output stays small. The assessments themselves are
					// stored in D1 by the container.
					const payload = (await response.json()) as {
						status?: string;
						assessments?: number;
						by_overall?: Record<string, number>;
					};
					return {
						status: payload.status ?? "COMPLETED",
						assessments: payload.assessments ?? 0,
						by_overall: payload.by_overall ?? {},
					};
				},
			);
			const outcome = result as unknown as { status?: string; assessments?: number; by_overall?: Record<string, number> };
			await this.env.DB.prepare(
				`UPDATE project_jobs SET status = 'COMPLETED', detail_json = ?2, updated_at = ?3
				 WHERE workspace_id = 'default' AND id = ?1`,
			)
				.bind(
					jobId,
					JSON.stringify({ assessments: outcome.assessments ?? 0, by_overall: outcome.by_overall ?? {} }),
					new Date().toISOString(),
				)
				.run();
			return {
				status: outcome.status ?? "COMPLETED",
				assessments: outcome.assessments ?? 0,
				by_overall: outcome.by_overall ?? {},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.env.DB.prepare(
				`UPDATE project_jobs SET status = 'FAILED', error = ?2, updated_at = ?3
				 WHERE workspace_id = 'default' AND id = ?1`,
			)
				.bind(jobId, message.slice(0, 500), new Date().toISOString())
				.run();
			return { status: "FAILED", error: message.slice(0, 400) };
		}
	}
}

export class SourcingReportWorkflow extends WorkflowEntrypoint<Env, ReportRequest> {
	async run(event: WorkflowEvent<ReportRequest>, step: WorkflowStep) {
		const { projectId, runId, reportId, pipelineId, decisionVersion, workflowId } = event.payload;
		try {
			if (pipelineId) {
				const current = await step.do("mark-report-running", async () => {
					const row = await this.env.DB.prepare("SELECT status, workflow_id FROM project_reports WHERE id = ?1 AND pipeline_id = ?2 AND project_id = ?3")
						.bind(reportId, pipelineId, projectId).first<{ status: string; workflow_id: string }>();
					if (!row || row.workflow_id !== workflowId) return "STALE";
					if (row.status === "COMPLETED") return "COMPLETED";
					if (!["QUEUED", "RUNNING"].includes(row.status)) return "STALE";
					await this.env.DB.batch([
						this.env.DB.prepare("UPDATE project_reports SET status = 'RUNNING', updated_at = ?3 WHERE id = ?1 AND workflow_id = ?2").bind(reportId, workflowId, new Date().toISOString()),
						this.env.DB.prepare("UPDATE project_pipelines SET report_status = 'RUNNING', updated_at = ?2 WHERE id = ?1 AND report_id = ?3 AND EXISTS (SELECT 1 FROM project_reports WHERE id = ?3 AND workflow_id = ?4 AND status = 'RUNNING')").bind(pipelineId, new Date().toISOString(), reportId, workflowId),
					]);
					return "RUNNING";
				});
				if (current !== "RUNNING") return { status: current, report_id: reportId };
			}
			const result = await step.do(
				"build-report",
				{ retries: { limit: 1, delay: "10 seconds", backoff: "exponential" }, timeout: "15 minutes" },
				async () => {
					const response = await fetchContainer(
						this.env,
						this.env.CONTAINER_INSTANCE_NAME,
						`/internal/projects/${projectId}/report`,
						{
							project_id: projectId,
							run_id: runId,
							pipeline_id: pipelineId ?? null,
							decision_version: decisionVersion ?? null,
							gateway_url: this.env.CONTAINER_GATEWAY_URL,
							token: this.env.INTERNAL_GATEWAY_TOKEN,
							runtime_config: {
								GENESIS_BASE_URL: this.env.GENESIS_BASE_URL,
								GENESIS_ACCESS_TOKEN: this.env.GENESIS_ACCESS_TOKEN,
								GENESIS_MODEL_ID: this.env.GENESIS_MODEL_ID,
							},
						},
					);
					if (!response.ok) {
						const body = await response.text().catch(() => "");
						throw new Error(`report generation failed with status ${response.status}: ${body.slice(0, 400)}`);
					}
					return (await response.json()) as {
						status?: string;
						bytes?: number;
						sha256?: string;
						r2_key?: string;
						decision_version?: string;
					};
				},
			);
			const outcome = result as unknown as {
				status?: string;
				bytes?: number;
				sha256?: string;
				r2_key?: string;
				decision_version?: string;
			};
			if (pipelineId && (!outcome.r2_key || !outcome.sha256 || outcome.decision_version !== decisionVersion)) throw new Error("REPORT_VERSION_MISMATCH");
			await this.env.DB.prepare(
				`UPDATE project_reports SET status = 'COMPLETED', r2_key = ?2, sha256 = ?3, byte_size = ?4,
				 decision_version = COALESCE(?5, decision_version), updated_at = ?6
				 WHERE workspace_id = 'default' AND id = ?1 AND (?7 IS NULL OR workflow_id = ?7)`,
			)
				.bind(
					reportId,
					String(outcome.r2_key ?? ""),
					String(outcome.sha256 ?? ""),
					Number(outcome.bytes ?? 0),
					outcome.decision_version ?? null,
					new Date().toISOString(),
					workflowId ?? null,
				)
				.run();
			if (pipelineId) await this.env.DB.prepare(`UPDATE project_pipelines SET report_status = 'COMPLETED', report_error_code = NULL, updated_at = ?2
				WHERE id = ?1 AND report_id = ?3 AND EXISTS (SELECT 1 FROM project_reports WHERE id = ?3 AND workflow_id = ?4 AND status = 'COMPLETED')`)
				.bind(pipelineId, new Date().toISOString(), reportId, workflowId).run();
			return { status: "COMPLETED", report_id: reportId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("report generation failed", reportId, message);
			await this.env.DB.prepare(
				`UPDATE project_reports SET status = 'FAILED', error = ?2, updated_at = ?3
				 WHERE workspace_id = 'default' AND id = ?1 AND (?4 IS NULL OR workflow_id = ?4)`,
			)
				.bind(reportId, pipelineId ? "REPORT_GENERATION_FAILED" : message.slice(0, 500), new Date().toISOString(), workflowId ?? null)
				.run();
			if (pipelineId) await this.env.DB.prepare(`UPDATE project_pipelines SET report_status = 'FAILED', report_error_code = 'REPORT_GENERATION_FAILED', updated_at = ?2
				WHERE id = ?1 AND report_id = ?3 AND EXISTS (SELECT 1 FROM project_reports WHERE id = ?3 AND workflow_id = ?4 AND status = 'FAILED')`)
				.bind(pipelineId, new Date().toISOString(), reportId, workflowId).run();
			return { status: "FAILED", error: pipelineId ? "REPORT_GENERATION_FAILED" : message.slice(0, 400) };
		}
	}
}

export class SourcingWorkflow extends WorkflowEntrypoint<Env, RunRequest> {
	async run(event: WorkflowEvent<RunRequest>, step: WorkflowStep) {
		const { runId, projectId, durationSeconds, mode } = event.payload;

		try {
			// Public research has billable in-memory budgets. Do not silently replay
			// a sourcing task and reset its search/model counters after a container
			// failure; M0 spike execution keeps its existing bounded retries.
			const result = await step.do(
				"execute-container-task",
				{
					// A research run that finishes never throws, so a retry only
					// happens when the container itself failed. The research
					// budget lives in the container's memory, so a crashed
					// instance has nothing to reset.
					retries: { limit: mode === "SOURCING" && event.payload.pipelineId ? 0 : 2, delay: "10 seconds", backoff: "exponential" },
					timeout: "20 minutes",
				},
				async () => {
					const container = getContainer(this.env.SOURCING_CONTAINER, this.env.CONTAINER_INSTANCE_NAME);
					// The instance sleeps when it is idle, so it has to be
					// started and ready before a long request is sent.
					await container.start();
					await waitForContainer(container);
					const runtimeConfig = {
						GENESIS_BASE_URL: this.env.GENESIS_BASE_URL,
						GENESIS_ACCESS_TOKEN: this.env.GENESIS_ACCESS_TOKEN,
						GENESIS_MODEL_ID: this.env.GENESIS_MODEL_ID,
						TAVILY_API_KEY: this.env.TAVILY_API_KEY,
						...(this.env.LANGSMITH_API_KEY ? { LANGSMITH_API_KEY: this.env.LANGSMITH_API_KEY } : {}),
						...(this.env.LANGSMITH_TRACING ? { LANGSMITH_TRACING: this.env.LANGSMITH_TRACING } : {}),
						...(this.env.LANGSMITH_PROJECT ? { LANGSMITH_PROJECT: this.env.LANGSMITH_PROJECT } : {}),
					};
					const isSourcing = mode === "SOURCING";
					const response = await container.fetch(
						new Request(`http://container/internal/${isSourcing ? "research" : "execute"}`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(isSourcing
								? {
									project_id: projectId,
									run_id: runId,
									pipeline_id: event.payload.pipelineId ?? null,
									gateway_url: this.env.CONTAINER_GATEWAY_URL,
									token: this.env.INTERNAL_GATEWAY_TOKEN,
									runtime_config: runtimeConfig,
									research_budget: event.payload.researchBudget ?? { max_search_calls: 4, max_fetches: 4, max_tasks: 2, max_rounds: 1, max_model_calls: 12 },
								}
								: {
									run_id: runId,
									gateway_url: this.env.CONTAINER_GATEWAY_URL,
									token: this.env.INTERNAL_GATEWAY_TOKEN,
									duration_seconds: durationSeconds,
									runtime_config: runtimeConfig,
								}),
						}),
					);
					if (!response.ok) {
						const body = await response.text().catch(() => "");
						throw new Error(
							`container task failed with status ${response.status}: ${body.slice(0, 500)}`,
						);
					}
					// The container answers with the whole research bundle, including
					// every page snapshot. A step output that large breaks the
					// Workflows step output limit, so only the few fields the
					// workflow needs are kept.
					const payload = (await response.json()) as {
						artifact?: { key?: string };
						status?: string;
						stop_reason_code?: string | null;
					};
					return {
						artifact: payload.artifact,
						status: payload.status,
						stop_reason_code: payload.stop_reason_code ?? null,
					};
				},
			);

			const artifactKey = result.artifact?.key ?? null;
			const finalStatus = result.status === "FAILED" ? "FAILED" : result.status === "PARTIAL" ? "PARTIAL" : "COMPLETED";
			const finalStage = finalStatus === "FAILED" ? "FAILED" : finalStatus === "PARTIAL" ? "PARTIAL" : mode === "SOURCING" ? "WEB_RESEARCH" : "REPORTING";
			await step.do("finalize-run", async () => {
				await updateRun(this.env, runId, finalStatus, finalStage, artifactKey);
				if (finalStatus === "FAILED") {
					const reason = result.stop_reason_code ?? "RESEARCH_FAILED";
					await this.env.DB.prepare(`UPDATE runs SET last_error = ?2 WHERE id = ?1`)
						.bind(runId, reason)
						.run();
					await appendEvent(this.env, runId, "FAILED", reason);
				}
			});

			return { status: finalStatus, artifactKey };
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

async function handleFetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/api/health") {
			return json({ status: "ok", service: "procurement-sourcing-gateway" });
		}

		let guestSessionId: string | null = null;
		let operatorAccess = false;
		if (url.pathname.startsWith("/api/")) {
			if (env.GUEST_SESSION_ENABLED === "true") {
				// The operator token is a server-side secret used by the acceptance
				// workflow and the development proxy. It is never the public demo
				// identity: a browser build for production must not carry it.
				operatorAccess = Boolean(env.DEMO_ACCESS_TOKEN)
					&& request.headers.get("authorization") === `Bearer ${env.DEMO_ACCESS_TOKEN}`;
				if (!operatorAccess) {
					const access = await authorizeGuest(request, env);
					if ("response" in access) return access.response;
					guestSessionId = access.sessionId;
				}
			} else {
				const unauthorized = await requireDemoAccess(request, env);
				if (unauthorized) return unauthorized;
			}
		}

		if (url.pathname.startsWith("/internal/")) {
			const unauthorized = await requireInternal(request, env);
			if (unauthorized) return unauthorized;

			const sourcingContextMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/sourcing-context$/);
			if (sourcingContextMatch && request.method === "GET") {
				const projectId = decodeURIComponent(sourcingContextMatch[1]);
				const runId = url.searchParams.get("run_id");
				const project = await env.DB.prepare(
					`SELECT id, history_availability FROM projects WHERE id = ?1`,
				).bind(projectId).first<{ id: string; history_availability: string }>();
				if (!project || !runId) return json({ error: "project_or_run_not_found" }, 404);
				const run = await env.DB.prepare(
					`SELECT id FROM runs WHERE id = ?1 AND project_id = ?2`,
				).bind(runId, projectId).first<{ id: string }>();
				if (!run) return json({ error: "run_not_found" }, 404);
				const pipelineId = url.searchParams.get("pipeline_id");
				const compilationRow = pipelineId
					? await readPipelineDemand(env.DB, pipelineId, projectId, runId)
					: await env.DB.prepare(
						`SELECT compilation_json FROM demand_compilations WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`,
					).bind(projectId).first<{ compilation_json: string }>();
				if (!compilationRow) return json({ error: pipelineId ? "pipeline_input_not_found" : "demand_not_compiled" }, 404);
				const compilation = JSON.parse(compilationRow.compilation_json) as { requirements?: unknown[] };
				if (!Array.isArray(compilation.requirements) || compilation.requirements.length === 0) {
					return json({ error: "structured_requirement_required_for_m2" }, 422);
				}

				const { results: intelligenceRows } = await env.DB.prepare(
					`SELECT p.id AS product_id, p.product_name, p.brand, p.model, p.product_category,
					        p.last_observed_at AS product_observed_at,
					        s.id AS supplier_id, s.display_name AS supplier_name, s.website_domain,
					        e.id AS evidence_id, e.source_url, e.retrieved_at, e.excerpt, e.content_date_hints_json,
					        o.relationship_status
					 FROM intelligence_products p
					 JOIN supplier_product_offerings o ON o.workspace_id = p.workspace_id AND o.product_id = p.id
					 JOIN intelligence_suppliers s ON s.workspace_id = o.workspace_id AND s.id = o.supplier_id
					 LEFT JOIN intelligence_entity_evidence ie ON ie.workspace_id = p.workspace_id
					      AND ie.entity_type = 'PRODUCT' AND ie.entity_id = p.id
					 LEFT JOIN research_evidence e ON e.workspace_id = ie.workspace_id AND e.id = ie.evidence_id
				 WHERE p.workspace_id = 'default'
				 ORDER BY p.last_observed_at DESC LIMIT 300`,
				).all<{
					product_id: string; product_name: string; brand: string | null; model: string | null;
					product_category: string | null; product_observed_at: string; supplier_id: string;
					supplier_name: string; website_domain: string | null; evidence_id: string | null;
					source_url: string | null; retrieved_at: string | null; excerpt: string | null;
					content_date_hints_json: string | null; relationship_status: string;
				}>();
				const grouped = new Map<string, {
					type: string; intelligence_id: string; product_id: string; product_name: string;
					brand: string | null; model: string | null; product_category: string | null;
					last_observed_at: string; supplier_ids: string[]; supplier_names: string[];
					website_domains: string[]; evidence_ids: string[];
					evidence: { evidence_id: string; source_url: string; retrieved_at: string; excerpt: string; content_date_hints: string[] }[];
					date_hints: string[]; freshness: string;
				}>();
				for (const row of intelligenceRows) {
					let item = grouped.get(row.product_id);
					if (!item) {
						item = {
							type: "PRODUCT", intelligence_id: row.product_id, product_id: row.product_id,
							product_name: row.product_name, brand: row.brand, model: row.model,
							product_category: row.product_category, last_observed_at: row.product_observed_at,
							supplier_ids: [], supplier_names: [], website_domains: [], evidence_ids: [], evidence: [], date_hints: [], freshness: "UNKNOWN",
						};
						grouped.set(row.product_id, item);
					}
					if (!item.supplier_ids.includes(row.supplier_id)) item.supplier_ids.push(row.supplier_id);
					if (!item.supplier_names.includes(row.supplier_name)) item.supplier_names.push(row.supplier_name);
					if (row.website_domain && !item.website_domains.includes(row.website_domain)) item.website_domains.push(row.website_domain);
					if (row.evidence_id && row.source_url && row.retrieved_at && !item.evidence_ids.includes(row.evidence_id)) {
						item.evidence_ids.push(row.evidence_id);
						const dateHints = JSON.parse(row.content_date_hints_json ?? "[]") as string[];
						item.date_hints.push(...dateHints.filter(hint => !item.date_hints.includes(hint)));
						item.evidence.push({ evidence_id: row.evidence_id, source_url: row.source_url, retrieved_at: row.retrieved_at, excerpt: (row.excerpt ?? "").slice(0, 1200), content_date_hints: dateHints });
					}
				}
				const requirementTerms = compilation.requirements.map(value => {
					const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
					return [row.product_name, row.product_category].filter((part): part is string => typeof part === "string").join(" ").toLowerCase();
				});
				const priorIntelligence = [...grouped.values()].map(item => {
					const productText = `${item.product_name} ${item.product_category ?? ""} ${item.model ?? ""}`.toLowerCase();
					const score = requirementTerms.reduce((best, term) => {
						const normalizedTerm = term.replace(/[\s\p{P}\p{S}]/gu, "");
						const normalizedProduct = productText.replace(/[\s\p{P}\p{S}]/gu, "");
						return Math.max(best, normalizedTerm.length > 2 && normalizedProduct.includes(normalizedTerm) ? 3 : 0,
							normalizedTerm.length > 2 && normalizedTerm.includes(normalizedProduct) ? 2 : 0);
					}, 0);
					const observed = Date.parse(item.last_observed_at);
					const hasOldDateMention = item.date_hints.some(hint => {
						const year = hint.match(/(?:19|20)\d{2}/)?.[0];
						return year !== undefined && Number(year) <= new Date().getUTCFullYear() - 5;
					});
					item.freshness = hasOldDateMention
						? "OLD_DATE_MENTION"
						: Number.isFinite(observed) && Date.now() - observed <= 180 * 24 * 60 * 60 * 1000 ? "RECENT_LEAD" : "STALE_LEAD";
					return { ...item, score };
				}).sort((a, b) => b.score - a.score || b.last_observed_at.localeCompare(a.last_observed_at)).slice(0, 20)
					.map(({ score: _score, ...item }) => item);
				return json({
					project_id: projectId,
					run_id: runId,
					history_availability: project.history_availability,
					compilation,
					existing_intelligence: priorIntelligence,
				});
			}

			const pipelineSnapshotMatch = url.pathname.match(/^\/internal\/pipelines\/([^/]+)\/snapshots\/(SPEC_CONTEXT|SPEC_RESULTS|DECISION_CONTEXT|DECISION_RESULTS|PRICE_CONTEXT|FINAL_CONTEXT)$/);
			if (pipelineSnapshotMatch && (request.method === "GET" || request.method === "POST")) {
				const pipelineId = decodeURIComponent(pipelineSnapshotMatch[1]);
				const snapshotType = pipelineSnapshotMatch[2];
				const projectId = url.searchParams.get("project_id");
				const pipeline = await env.DB.prepare("SELECT id FROM project_pipelines WHERE id = ?1 AND project_id = ?2")
					.bind(pipelineId, projectId).first<{ id: string }>();
				if (!pipeline) return json({ error: "not_found" }, 404);
				if (request.method === "POST") {
					const body = await request.text();
					const outcome = await storePipelineSnapshot(env.DB, pipelineId, snapshotType, body);
					return outcome === "CONFLICT" ? json({ error: "snapshot_conflict" }, 409) : json({ status: outcome }, outcome === "CREATED" ? 201 : 200);
				}
				const snapshot = await env.DB.prepare("SELECT payload_json, sha256 FROM pipeline_snapshots WHERE pipeline_id = ?1 AND snapshot_type = ?2")
					.bind(pipelineId, snapshotType).first<{ payload_json: string; sha256: string }>();
				if (!snapshot) return json({ error: "snapshot_not_found" }, 404);
				if (await sha256Hex(new TextEncoder().encode(snapshot.payload_json)) !== snapshot.sha256) return json({ error: "snapshot_integrity_error" }, 500);
				return new Response(snapshot.payload_json, { headers: { ...JSON_HEADERS, "x-snapshot-sha256": snapshot.sha256, "cache-control": "no-store" } });
			}

			const cacheLookupMatch = url.pathname.match(/^\/internal\/judgment-cache\/lookup$/);
			if (cacheLookupMatch && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					layer?: string;
					digests?: string[];
				};
				const layer = String(body.layer ?? "");
				const digests = (body.digests ?? []).map((item) => String(item)).slice(0, 2000);
				if (!digests.length) return json({ payloads: {} });
				const { results } = await env.DB.prepare(
					`SELECT input_digest, payload_json FROM judgment_cache
					 WHERE workspace_id = 'default' AND layer = ?1 AND input_digest IN (${digests.map((_, index) => `?${index + 2}`).join(",")})`,
				).bind(layer, ...digests).all<{ input_digest: string; payload_json: string }>();
				const payloads: Record<string, unknown> = {};
				for (const row of results) {
					try {
						payloads[row.input_digest] = JSON.parse(row.payload_json) as unknown;
					} catch {
						// A row that cannot be read is a row that is treated as
						// absent, so the judgement is made again.
					}
				}
				return json({ payloads });
			}

			const cacheStoreMatch = url.pathname.match(/^\/internal\/judgment-cache\/store$/);
			if (cacheStoreMatch && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					entries?: {
						layer?: string;
						input_digest?: string;
						payload?: unknown;
						versions?: Record<string, string>;
						model_config?: Record<string, unknown>;
						evidence_hashes?: string[];
						source_run_id?: string;
						source_project_id?: string;
						verdict?: string;
						reason_codes?: string[];
					}[];
				};
				const now = new Date().toISOString();
				const inserts: D1PreparedStatement[] = [];
				const conflicts: D1PreparedStatement[] = [];
				for (const entry of body.entries ?? []) {
					const layer = String(entry.layer ?? "");
					const digest = String(entry.input_digest ?? "");
					if (!layer || !digest) continue;
					const payloadJson = JSON.stringify(entry.payload ?? {});
					inserts.push(env.DB.prepare(
						`INSERT INTO judgment_cache (
							id, workspace_id, layer, input_digest, payload_json, versions_json, model_config_json,
							evidence_hashes_json, source_run_id, source_project_id, verdict, reason_codes_json, created_at, updated_at)
						 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
						 ON CONFLICT(workspace_id, layer, input_digest) DO NOTHING`,
					)
						.bind(
							`jc_${layer.toLowerCase()}_${digest.slice(0, 32)}`,
							layer,
							digest,
							payloadJson,
							JSON.stringify(entry.versions ?? {}),
							JSON.stringify(entry.model_config ?? {}),
							JSON.stringify(entry.evidence_hashes ?? []),
							entry.source_run_id ?? null,
							entry.source_project_id ?? null,
							entry.verdict ?? null,
							JSON.stringify(entry.reason_codes ?? []),
							now,
						));
					// A second answer for the same content is a conflict, and it
					// is kept instead of being hidden by the first answer.
					conflicts.push(env.DB.prepare(
						`INSERT INTO judgment_cache_conflicts (
							id, workspace_id, layer, input_digest, payload_json, model_config_json, reason_codes_json,
							source_run_id, source_project_id, created_at)
						 SELECT ?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
						 WHERE EXISTS (
							SELECT 1 FROM judgment_cache
							 WHERE workspace_id = 'default' AND layer = ?2 AND input_digest = ?3
						   AND payload_json <> ?4)
						 ON CONFLICT DO NOTHING`,
					)
						.bind(
							`jcc_${layer.toLowerCase()}_${digest.slice(0, 32)}_${now.replace(/[^0-9]/g, "")}`,
							layer,
							digest,
							payloadJson,
							JSON.stringify(entry.model_config ?? {}),
							JSON.stringify(entry.reason_codes ?? []),
							entry.source_run_id ?? null,
							entry.source_project_id ?? null,
							now,
						));
				}
				if (inserts.length) await env.DB.batch(inserts);
				if (conflicts.length) await env.DB.batch(conflicts);
				const counted = await env.DB.prepare(
					`SELECT COUNT(*) AS count FROM judgment_cache WHERE workspace_id = 'default'`,
				).first<{ count: number }>();
				const countedConflicts = await env.DB.prepare(
					`SELECT COUNT(*) AS count FROM judgment_cache_conflicts WHERE workspace_id = 'default'`,
				).first<{ count: number }>();
				return json({
					stored: inserts.length,
					conflicts: countedConflicts?.count ?? 0,
					entries: counted?.count ?? 0,
				});
			}

			const specContextMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/spec-context$/);
			if (specContextMatch && request.method === "GET") {
				const projectId = decodeURIComponent(specContextMatch[1]);
				const wantedRequirements = (url.searchParams.get("requirement_ids") ?? "").split(",").filter(Boolean);
				const wantedCandidates = (url.searchParams.get("candidate_ids") ?? "").split(",").filter(Boolean);
				const pipelineId = url.searchParams.get("pipeline_id");
				const sourcingRunId = url.searchParams.get("run_id");
				if (pipelineId && (!sourcingRunId || wantedCandidates.length === 0)) return json({ error: "pipeline_input_required" }, 422);
				const compilationRow = pipelineId && sourcingRunId
					? await readPipelineDemand(env.DB, pipelineId, projectId, sourcingRunId)
					: await env.DB.prepare(
						`SELECT demand_revision, compilation_json FROM demand_compilations WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`,
					).bind(projectId).first<{ demand_revision: number; compilation_json: string }>();
				if (!compilationRow) return json({ error: "demand_not_compiled" }, 404);
				const compilation = JSON.parse(compilationRow.compilation_json) as {
					requirements?: unknown[];
					unstructured_requirements?: unknown[];
				};
				const requirements = (compilation.requirements ?? []).filter((item) => {
					if (wantedRequirements.length === 0) return true;
					const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
					return wantedRequirements.includes(String(row.requirement_id ?? ""));
				});

				// The run that produced the candidates is part of the audit
				// trail of every judgement that is cached.
				const latestRun = pipelineId && sourcingRunId ? { id: sourcingRunId } : await env.DB.prepare(
					`SELECT id FROM runs WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1`,
				).bind(projectId).first<{ id: string }>();

				const { results: candidateRows } = await env.DB.prepare(
					`SELECT c.id AS candidate_id, c.requirement_id, c.supplier_id, c.product_id, c.stage, c.rationale,
					        c.last_seen_run_id, c.open_questions_json, p.model AS product_model,
					        p.product_name, s.display_name AS supplier_name,
					        (SELECT group_concat(e.evidence_id) FROM project_candidate_evidence e
					          WHERE e.workspace_id = c.workspace_id AND e.candidate_id = c.id) AS evidence_ids
					 FROM project_candidates c
					 LEFT JOIN intelligence_products p ON p.workspace_id = c.workspace_id AND p.id = c.product_id
					 LEFT JOIN intelligence_suppliers s ON s.workspace_id = c.workspace_id AND s.id = c.supplier_id
					 WHERE c.workspace_id = 'default' AND c.project_id = ?1
					 ORDER BY c.updated_at DESC LIMIT 600`,
				).bind(projectId).all<{
					candidate_id: string; requirement_id: string; supplier_id: string; product_id: string | null;
					stage: string; rationale: string; last_seen_run_id: string; open_questions_json: string; product_model: string | null;
					product_name: string | null; supplier_name: string | null; evidence_ids: string | null;
				}>();
				const selectedRows = candidateRows.filter((row) =>
					(wantedCandidates.length === 0 || wantedCandidates.includes(row.candidate_id)) &&
					(!pipelineId || row.last_seen_run_id === sourcingRunId));
				if (pipelineId && selectedRows.length !== new Set(wantedCandidates).size) return json({ error: "pipeline_candidates_changed" }, 409);
				const candidates = selectedRows
					.map((row) => ({
						candidate_id: row.candidate_id,
						requirement_id: row.requirement_id,
						supplier_id: row.supplier_id,
						product_id: row.product_id,
						stage: row.stage,
						rationale: row.rationale,
						evidence_ids: (row.evidence_ids ?? "").split(",").filter((item) => item.length > 0),
						open_questions: JSON.parse(row.open_questions_json ?? "[]") as string[],
					}));

				const selectedProductIds = [...new Set(selectedRows.map(row => row.product_id).filter((value): value is string => Boolean(value)))];
				const productConstraint = pipelineId ? " AND cc.subject_id IN (SELECT value FROM json_each(?2))" : "";
				const { results: claimRows } = await env.DB.prepare(
					`SELECT cc.id AS claim_id, cc.subject_type, cc.subject_id, cc.attribute, cc.value, cc.unit,
					        cc.status, cc.evaluation_method, ce.evidence_id, ce.source_quote
					 FROM research_claims cc
					 JOIN claim_evidence_links ce ON ce.workspace_id = cc.workspace_id AND ce.claim_id = cc.id
					 WHERE cc.workspace_id = 'default' AND cc.subject_type = 'PRODUCT_MODEL'
					   AND cc.subject_id IN (SELECT DISTINCT product_id FROM project_candidates
					        WHERE workspace_id = 'default' AND project_id = ?1)
					 ${productConstraint} LIMIT ${pipelineId ? 2001 : 2000}`,
				).bind(projectId, ...(pipelineId ? [JSON.stringify(selectedProductIds)] : [])).all<{
					claim_id: string; subject_type: string; subject_id: string; attribute: string; value: string;
					unit: string | null; status: string; evaluation_method: string; evidence_id: string; source_quote: string;
				}>();
				if (pipelineId && claimRows.length > 2000) return json({ error: "pipeline_claim_limit_exceeded" }, 422);
				const seenClaims = new Set<string>();
				const selectedProducts = new Set(selectedProductIds);
				const selectedEvidence = new Set(candidates.flatMap(candidate => candidate.evidence_ids));
				const claims = claimRows
					.filter((row) => {
						if (pipelineId && (!selectedProducts.has(row.subject_id) || !selectedEvidence.has(row.evidence_id))) return false;
						if (seenClaims.has(row.claim_id)) return false;
						seenClaims.add(row.claim_id);
						return true;
					})
					.map((row) => ({
						claim_id: row.claim_id,
						subject_type: row.subject_type,
						subject_ref: row.subject_id,
						attribute: row.attribute,
						value: row.value,
						unit: row.unit,
						evidence_id: row.evidence_id,
						source_quote: row.source_quote,
						status: row.status,
						evaluation_method: row.evaluation_method,
					}));

				const modelByProduct: Record<string, string> = {};
				for (const row of (pipelineId ? selectedRows : candidateRows)) {
					if (row.product_id && row.product_model) modelByProduct[row.product_id] = row.product_model;
				}

				// The hash of the snapshot a claim rests on belongs in the
				// cache key, so a claim whose evidence changed is judged again.
				const evidenceIds = [...new Set([
					...claims.map((claim) => claim.evidence_id),
					...(pipelineId ? candidates.flatMap(candidate => candidate.evidence_ids) : []),
				])].filter(Boolean);
				const evidenceHashes: Record<string, string> = {};
				let frozenEvidence: { evidence_id: string; title: string; url: string; quote: string | null; quote_status: string; content_sha256: string }[] = [];
				if (evidenceIds.length > 0) {
					const { results: evidenceRows } = await env.DB.prepare(
						`SELECT id, content_sha256, title, source_url, excerpt FROM research_evidence WHERE workspace_id = 'default' AND id IN (SELECT value FROM json_each(?1))`,
					).bind(JSON.stringify(evidenceIds)).all<{ id: string; content_sha256: string; title: string; source_url: string; excerpt: string }>();
					for (const row of evidenceRows) evidenceHashes[row.id] = row.content_sha256;
					if (pipelineId && evidenceIds.some(id => !evidenceHashes[id])) return json({ error: "pipeline_evidence_missing" }, 409);
					frozenEvidence = evidenceRows.map(row => {
						const excerpt = evidenceDisplayExcerpt(row.excerpt);
						return { evidence_id: row.id, title: row.title, url: row.source_url, quote: excerpt.text, quote_status: excerpt.status, content_sha256: row.content_sha256 };
					});
				}
				return json({
					project_id: projectId,
					run_id: latestRun?.id ?? null,
					demand_revision: compilationRow.demand_revision,
					requirements,
					unstructured_requirements: compilation.unstructured_requirements ?? [],
					candidates,
					claims,
					model_by_product: modelByProduct,
					evidence_hashes: evidenceHashes,
					...(pipelineId ? {
						report_candidates: selectedRows.map(row => ({
							candidate_id: row.candidate_id, requirement_id: row.requirement_id, supplier_id: row.supplier_id,
							product_id: row.product_id, supplier_name: row.supplier_name, product_model: row.product_model,
							product_name: row.product_name, stage: row.stage, rationale: row.rationale,
							evidence_ids: (row.evidence_ids ?? "").split(",").filter(Boolean),
							open_questions: JSON.parse(row.open_questions_json ?? "[]") as string[],
						})),
						report_evidence: frozenEvidence,
					} : {}),
				});
			}

			// The data the formal report is built from. Everything the report
			// writes is read here, so the report cannot contain a number that
			// is not in the database.
			const reportContextMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/report-context$/);
			if (reportContextMatch && request.method === "GET") {
				const projectId = decodeURIComponent(reportContextMatch[1]);
				const project = await env.DB.prepare(
					`SELECT id, title, demand_revision, created_at FROM projects
					 WHERE id = ?1`,
				)
					.bind(projectId)
					.first<{ id: string; title: string; demand_revision: number; created_at: string }>();
				if (!project) return json({ error: "project_not_found" }, 404);
				const compilationRow = await env.DB.prepare(
					`SELECT demand_revision, compilation_json FROM demand_compilations
					 WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`,
				)
					.bind(projectId)
					.first<{ demand_revision: number; compilation_json: string }>();
				if (!compilationRow) return json({ error: "demand_not_compiled" }, 404);
				const compilation = JSON.parse(compilationRow.compilation_json) as {
					requirements?: unknown[];
					issues?: unknown[];
				};
				const requirements = (compilation.requirements ?? []) as Record<string, unknown>[];

				const { results: candidateRows } = await env.DB.prepare(reportCandidatesSql)
					.bind(projectId)
					.all<{
						candidate_id: string;
						requirement_id: string;
						stage: string;
						rationale: string;
						open_questions_json: string;
						supplier_name: string | null;
						product_model: string | null;
						product_name: string | null;
						evidence_ids: string | null;
					}>();
				const candidates = candidateRows.map((row) => ({
					candidate_id: row.candidate_id,
					requirement_id: row.requirement_id,
					stage: row.stage,
					rationale: row.rationale,
					open_questions: JSON.parse(row.open_questions_json ?? "[]") as string[],
					supplier_name: row.supplier_name,
					product_model: row.product_model,
					product_name: row.product_name,
					evidence_ids: (row.evidence_ids ?? "").split(",").filter((item) => item.length > 0),
				}));

				// The newest judgement of every requirement and candidate.
				const { results: assessmentRows } = await env.DB.prepare(reportAssessmentsSql)
					.bind(projectId)
					.all<{
						requirement_id: string;
						product_candidate_id: string;
						product_model_ref: string | null;
						hard_spec_overall: string;
						overall_reason_codes_json: string;
						assessment_json: string;
						judgment_version: number;
						evaluated_at: string;
					}>();
				const assessments = assessmentRows.map((row) => {
					const detail = JSON.parse(row.assessment_json) as Record<string, unknown>;
					return {
						requirement_id: row.requirement_id,
						product_candidate_id: row.product_candidate_id,
						product_model_ref: row.product_model_ref,
						hard_spec_overall: row.hard_spec_overall,
						overall_reason_codes: JSON.parse(row.overall_reason_codes_json ?? "[]") as string[],
						checks: (detail.checks ?? []) as unknown[],
						judgment_version: row.judgment_version,
						evaluated_at: row.evaluated_at,
					};
				});

				const { results: decisionRows } = await env.DB.prepare(
					`SELECT d.requirement_id, d.product_candidate_id, d.product_model_ref, d.recommendation,
					        d.technical_verdict, d.hard_spec_overall, d.accepted, d.rationale, d.gaps_json,
					        d.next_actions_json, d.evidence_ids_json, d.priority_rank, d.decision_json,
					        d.violations_json, d.decided_at
					 FROM sourcing_decisions d
					 WHERE d.workspace_id = 'default' AND d.project_id = ?1
					 ORDER BY d.requirement_id, d.product_candidate_id`,
				)
					.bind(projectId)
					.all<{
						requirement_id: string;
						product_candidate_id: string;
						product_model_ref: string | null;
						recommendation: string;
						technical_verdict: string;
						hard_spec_overall: string;
						accepted: number;
						rationale: string;
						gaps_json: string;
						next_actions_json: string;
						evidence_ids_json: string;
						priority_rank: number | null;
						decision_json: string;
						violations_json: string;
						decided_at: string;
					}>();
				const decisions = decisionRows.map((row) => {
					const detail = JSON.parse(row.decision_json ?? "{}") as Record<string, unknown>;
					return {
						requirement_id: row.requirement_id,
						product_candidate_id: row.product_candidate_id,
						product_model_ref: row.product_model_ref,
						recommendation: row.recommendation,
						technical_verdict: row.technical_verdict,
						hard_spec_overall: row.hard_spec_overall,
						accepted: row.accepted === 1,
						rationale: row.rationale,
						gaps: JSON.parse(row.gaps_json ?? "[]") as string[],
						next_actions: JSON.parse(row.next_actions_json ?? "[]") as string[],
						evidence_ids: JSON.parse(row.evidence_ids_json ?? "[]") as string[],
						priority_rank: row.priority_rank,
						price_conclusion: detail.price_conclusion ?? null,
						violations: JSON.parse(row.violations_json ?? "[]") as unknown[],
						decided_at: row.decided_at,
					};
				});

				// The normalized history lives in R2. It is optional: a project
				// without one simply has no history prices.
				let historyRows: unknown[] = [];
				const { results: historyDatasetRows } = await env.DB.prepare(
					`SELECT normalized_r2_key FROM history_datasets WHERE project_id = ?1 ORDER BY imported_at DESC LIMIT 1`,
				)
					.bind(projectId)
					.all<{ normalized_r2_key: string }>();
				if (historyDatasetRows.length > 0) {
					const stored = await env.BUCKET.get(historyDatasetRows[0].normalized_r2_key);
					if (stored) {
						const normalized = JSON.parse(await stored.text()) as { transactions?: unknown[] };
						historyRows = normalized.transactions ?? [];
					}
				}

				// The evidence the candidates rest on.
				const evidenceIds = [
					...new Set(candidates.flatMap((candidate) => candidate.evidence_ids as string[])),
				];
				let evidence: Record<string, unknown>[] = [];
				if (evidenceIds.length > 0) {
					const { results: evidenceRows } = await env.DB.prepare(
						`SELECT id, title, source_url, excerpt, content_sha256 FROM research_evidence
						 WHERE workspace_id = 'default' AND id IN (${evidenceIds
							.map((_, index) => `?${index + 1}`)
							.join(",")})`,
					)
						.bind(...evidenceIds)
						.all<{
							id: string;
							title: string;
							source_url: string;
							excerpt: string;
							content_sha256: string;
						}>();
					evidence = evidenceRows.map((row) => ({
						evidence_id: row.id,
						title: row.title,
						url: row.source_url,
						quote: row.excerpt,
						content_sha256: row.content_sha256,
					}));
				}

				const latestRun = await env.DB.prepare(
					`SELECT id FROM runs WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1`,
				)
					.bind(projectId)
					.first<{ id: string }>();

				return json({
					project_id: project.id,
					project_title: project.title,
					run_id: latestRun?.id ?? null,
					demand_revision: compilationRow.demand_revision,
					requirements,
					candidates,
					assessments,
					decisions,
					history_transactions: historyRows,
					history_price_unit: null,
					equivalences: [],
					evidence,
					open_questions: [
						...((compilation.issues ?? []) as unknown[]).map((issue) =>
							typeof issue === "string" ? issue : JSON.stringify(issue),
						),
						...requirements.flatMap((requirement) =>
							((requirement.open_questions ?? []) as unknown[]).map((question) =>
								typeof question === "string" ? question : JSON.stringify(question),
							),
						),
					],
				});
			}

			// The finished document, stored in private R2.
			const reportArtifactMatch = url.pathname.match(
				/^\/internal\/projects\/([^/]+)\/report-artifact$/,
			);
			if (reportArtifactMatch && request.method === "POST") {
				const projectId = decodeURIComponent(reportArtifactMatch[1]);
				const body = await request.arrayBuffer();
				const suppliedSha = url.searchParams.get("sha256") ?? "";
				const pipelineId = url.searchParams.get("pipeline_id");
				if (pipelineId) {
					const version = url.searchParams.get("decision_version") ?? "";
					if (!/^[a-f0-9]{64}$/.test(version) || body.byteLength > 20 * 1024 * 1024 || await sha256Hex(body) !== suppliedSha) return json({ error: "invalid_report_artifact" }, 422);
					const pipeline = await env.DB.prepare("SELECT id FROM project_pipelines WHERE id = ?1 AND project_id = ?2 AND decision_version = ?3")
						.bind(pipelineId, projectId, version).first<{ id: string }>();
					if (!pipeline) return json({ error: "not_found" }, 404);
					const key = `workspaces/default/projects/${projectId}/pipeline-reports/${pipelineId}/${version}.docx`;
					const created = await env.BUCKET.put(key, body, {
						onlyIf: new Headers({ "if-none-match": "*" }),
						customMetadata: { sha256: suppliedSha, decision_version: version },
						httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
					});
					const object = created ?? await env.BUCKET.head(key);
					if (!object || object.customMetadata?.decision_version !== version || !object.customMetadata?.sha256) return json({ error: "report_artifact_unavailable" }, 500);
					return json({ ok: true, key, sha256: object.customMetadata.sha256, bytes: object.size, reused: !created });
				}
				const key = `workspaces/default/projects/${projectId}/reports/report-${Date.now()}.docx`;
				await env.BUCKET.put(key, body, {
					httpMetadata: {
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					},
				});
				return json({ ok: true, key, sha256: suppliedSha, bytes: body.byteLength });
			}

			const decisionContextMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/decision-context$/);
			if (decisionContextMatch && request.method === "GET") {
				const projectId = decodeURIComponent(decisionContextMatch[1]);
				const wantedRequirements = (url.searchParams.get("requirement_ids") ?? "").split(",").filter(Boolean);
				const compilationRow = await env.DB.prepare(
					`SELECT demand_revision, compilation_json FROM demand_compilations WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`,
				).bind(projectId).first<{ demand_revision: number; compilation_json: string }>();
				if (!compilationRow) return json({ error: "demand_not_compiled" }, 404);
				const compilation = JSON.parse(compilationRow.compilation_json) as { requirements?: unknown[] };
				const requirements = (compilation.requirements ?? []).filter((item) => {
					if (wantedRequirements.length === 0) return true;
					const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
					return wantedRequirements.includes(String(row.requirement_id ?? ""));
				});

				const { results: assessmentRows } = await env.DB.prepare(
					`SELECT requirement_id, product_candidate_id, product_model_ref, hard_spec_overall,
					        assessment_json, evidence_ids_json, evaluated_at
					 FROM spec_assessments
					 WHERE workspace_id = 'default' AND project_id = ?1
					 ORDER BY requirement_id, product_candidate_id LIMIT 2000`,
				).bind(projectId).all<{
					requirement_id: string; product_candidate_id: string; product_model_ref: string | null;
					hard_spec_overall: string; assessment_json: string; evidence_ids_json: string; evaluated_at: string;
				}>();
				const assessments = assessmentRows.map((row) => JSON.parse(row.assessment_json) as unknown);
				const evidenceIds = new Set<string>();
				for (const row of assessmentRows) {
					for (const evidenceId of JSON.parse(row.evidence_ids_json ?? "[]") as string[]) {
						evidenceIds.add(evidenceId);
					}
				}

				// The normalized history lives in R2. It is optional: a project
				// without one simply has no history prices.
				let historyTransactions: unknown[] = [];
				const { results: historyRows } = await env.DB.prepare(
					`SELECT normalized_r2_key FROM history_datasets WHERE project_id = ?1 ORDER BY imported_at DESC LIMIT 1`,
				).bind(projectId).all<{ normalized_r2_key: string }>();
				if (historyRows.length > 0) {
					const stored = await env.BUCKET.get(historyRows[0].normalized_r2_key);
					if (stored) {
						const normalized = JSON.parse(await stored.text()) as { transactions?: unknown[] };
						historyTransactions = normalized.transactions ?? [];
					}
				}
				return json({
					project_id: projectId,
					demand_revision: compilationRow.demand_revision,
					requirements,
					assessments,
					evidence_ids: [...evidenceIds],
					history_transactions: historyTransactions,
					history_price_unit: null,
				});
			}

			const decisionResultsMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/decision-results$/);
			if (decisionResultsMatch && request.method === "POST") {
				const projectId = decodeURIComponent(decisionResultsMatch[1]);
				const body = (await request.json()) as { decisions?: Record<string, unknown>[] };
				const now = new Date().toISOString();
				const statements = [];
				for (const decision of body.decisions ?? []) {
					const requirementId = String(decision.requirement_id ?? "");
					const candidateId = String(decision.product_candidate_id ?? "");
					if (!requirementId || !candidateId) continue;
					const violations = (decision.violations ?? []) as unknown[];
					statements.push(env.DB.prepare(
						`INSERT INTO sourcing_decisions (
							id, workspace_id, project_id, requirement_id, product_candidate_id, product_model_ref,
							recommendation, technical_verdict, hard_spec_overall, accepted, priority_rank, rationale,
							evidence_ids_json, gaps_json, next_actions_json, violations_json, decision_json, decided_at, created_at)
						 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
						 ON CONFLICT(workspace_id, project_id, requirement_id, product_candidate_id) DO UPDATE SET
							product_model_ref = excluded.product_model_ref,
							recommendation = excluded.recommendation,
							technical_verdict = excluded.technical_verdict,
							hard_spec_overall = excluded.hard_spec_overall,
							accepted = excluded.accepted,
							priority_rank = excluded.priority_rank,
							rationale = excluded.rationale,
							evidence_ids_json = excluded.evidence_ids_json,
							gaps_json = excluded.gaps_json,
							next_actions_json = excluded.next_actions_json,
							violations_json = excluded.violations_json,
							decision_json = excluded.decision_json,
							decided_at = excluded.decided_at,
							created_at = excluded.created_at`,
					)
						.bind(
							`dec_${requirementId}_${candidateId}`.slice(0, 120),
							projectId,
							requirementId,
							candidateId,
							decision.product_model_ref ?? null,
							String(decision.recommendation ?? "INVESTIGATE"),
							String(decision.technical_verdict ?? "UNVERIFIED"),
							String(decision.hard_spec_overall ?? "UNKNOWN"),
							decision.accepted === true ? 1 : 0,
							decision.priority_rank ?? null,
							String(decision.rationale ?? ""),
							JSON.stringify(decision.evidence_ids ?? []),
							JSON.stringify(decision.gaps ?? []),
							JSON.stringify(decision.next_actions ?? []),
							JSON.stringify(violations),
							JSON.stringify(decision),
							String(decision.decided_at ?? now),
							now,
						));
					// An accepted decision moves the candidate. A verified pass
					// enters the RFQ shortlist, an exclusion leaves the longlist,
					// and a candidate that still needs evidence stays on it with
					// that state written down. A rejected decision changes
					// nothing.
					if (decision.accepted === true) {
						const recommendation = String(decision.recommendation ?? "INVESTIGATE");
						const verdict = String(decision.technical_verdict ?? "UNVERIFIED");
						const stage =
							recommendation === "SHORTLIST" && verdict === "VERIFIED_PASS"
								? "RFQ_SHORTLIST"
								: recommendation === "EXCLUDE"
									? "EXCLUDED"
									: recommendation === "INVESTIGATE"
										? "NEEDS_VERIFICATION"
										: null;
						if (stage) {
							statements.push(env.DB.prepare(
								`UPDATE project_candidates SET stage = ?2, updated_at = ?3
								 WHERE workspace_id = 'default' AND project_id = ?4 AND id = ?1`,
							).bind(candidateId, stage, now, projectId));
						}
					}
				}
				if (statements.length > 0) await env.DB.batch(statements);
				return json({ stored: statements.length });
			}

			const specResultsMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/spec-results$/);
			if (specResultsMatch && request.method === "POST") {
				const projectId = decodeURIComponent(specResultsMatch[1]);
				const body = (await request.json()) as {
					demand_revision?: number;
					review_reason?: string;
					assessments?: {
						requirement_id?: string;
						product_candidate_id?: string;
						product_model_ref?: string | null;
						hard_spec_overall?: string;
						overall_reason_codes?: string[];
						hard_constraint_count?: number;
						calculator_version?: string;
						dsl_schema_version?: string;
						evaluated_at?: string;
						input_digest?: string;
						model_config?: Record<string, unknown>;
						prompt_versions?: Record<string, string>;
						assessment?: unknown;
					}[];
				};
				const revision = Number(body.demand_revision ?? 1);
				const now = new Date().toISOString();
				const statements = [];
				const reviewReason = String(body.review_reason ?? "").trim();
				for (const item of body.assessments ?? []) {
					const requirementId = String(item.requirement_id ?? "");
					const candidateId = String(item.product_candidate_id ?? "");
					if (!requirementId || !candidateId) continue;
					// A judgement is versioned. A re-run of the same content keeps its
					// version; an explicit review creates a new one and leaves the old
					// judgement in place.
					const existingRows = await env.DB.prepare(
						`SELECT judgment_version, input_digest FROM spec_assessments
						 WHERE workspace_id = 'default' AND project_id = ?1 AND requirement_id = ?2
						   AND product_candidate_id = ?3 AND demand_revision = ?4
						 ORDER BY judgment_version DESC`,
					).bind(projectId, requirementId, candidateId, revision).all<{
						judgment_version: number; input_digest: string | null;
					}>();
					const existing = existingRows.results;
					const sameContent = existing.find((row) => row.input_digest === (item.input_digest ?? null));
					let judgmentVersion = sameContent?.judgment_version ?? 1;
					if (!sameContent && existing.length > 0) {
						judgmentVersion = Math.max(...existing.map((row) => row.judgment_version ?? 1)) + 1;
					}
					if (reviewReason && sameContent) {
						judgmentVersion = Math.max(...existing.map((row) => row.judgment_version ?? 1)) + 1;
					}
					const assessment = item.assessment ?? {};
					const evidenceIds = new Set<string>();
					const checks = (assessment as { checks?: { evidence_ids?: string[] }[] }).checks ?? [];
					for (const check of checks) {
						for (const evidenceId of check.evidence_ids ?? []) evidenceIds.add(evidenceId);
					}
					statements.push(env.DB.prepare(
						`INSERT INTO spec_assessments (
							id, workspace_id, project_id, requirement_id, product_candidate_id, product_model_ref,
							demand_revision, hard_spec_overall, overall_reason_codes_json, hard_constraint_count,
							calculator_version, dsl_schema_version, assessment_json, evidence_ids_json, evaluated_at, created_at,
						 judgment_version, review_reason, input_digest, model_config_json, prompt_versions_json)
						 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
						 ON CONFLICT(workspace_id, project_id, requirement_id, product_candidate_id, demand_revision, judgment_version) DO UPDATE SET
							product_model_ref = excluded.product_model_ref,
							hard_spec_overall = excluded.hard_spec_overall,
							overall_reason_codes_json = excluded.overall_reason_codes_json,
							hard_constraint_count = excluded.hard_constraint_count,
							calculator_version = excluded.calculator_version,
							dsl_schema_version = excluded.dsl_schema_version,
							assessment_json = excluded.assessment_json,
							evidence_ids_json = excluded.evidence_ids_json,
							evaluated_at = excluded.evaluated_at,
							created_at = excluded.created_at,
							review_reason = excluded.review_reason,
							input_digest = excluded.input_digest,
							model_config_json = excluded.model_config_json,
							prompt_versions_json = excluded.prompt_versions_json`,
					)
						.bind(
							await stableSpecId(projectId, requirementId, candidateId, revision),
							projectId,
							requirementId,
							candidateId,
							item.product_model_ref ?? null,
							revision,
							String(item.hard_spec_overall ?? "UNKNOWN"),
							JSON.stringify(item.overall_reason_codes ?? []),
							Number(item.hard_constraint_count ?? 0),
							String(item.calculator_version ?? "0.1.0"),
							String(item.dsl_schema_version ?? "1.0"),
							JSON.stringify(assessment),
							JSON.stringify([...evidenceIds]),
							String(item.evaluated_at ?? now),
							now,
							judgmentVersion,
							reviewReason || null,
							item.input_digest ?? null,
							JSON.stringify(item.model_config ?? {}),
							JSON.stringify(item.prompt_versions ?? {}),
						));
				}
				if (statements.length > 0) await env.DB.batch(statements);
				return json({ stored: statements.length });
			}

			const researchResultsMatch = url.pathname.match(/^\/internal\/runs\/([^/]+)\/research-results$/);
			if (researchResultsMatch && request.method === "POST") {
				const contentLength = Number(request.headers.get("content-length") ?? 0);
				if (contentLength > 5 * 1024 * 1024) return json({ error: "research_bundle_too_large" }, 413);
				const raw = await request.json().catch(() => null);
				if (!raw || typeof raw !== "object") return json({ error: "invalid_research_bundle" }, 422);
				const bundle = raw as M2BundlePayload;
				const runId = decodeURIComponent(researchResultsMatch[1]);
				if (bundle.run_id !== runId || !bundle.project_id || !Array.isArray(bundle.evidence) || !Array.isArray(bundle.candidates)) {
					return json({ error: "invalid_research_bundle_scope" }, 422);
				}
				const run = await env.DB.prepare(
					`SELECT id FROM runs WHERE id = ?1 AND project_id = ?2`,
				).bind(runId, bundle.project_id).first<{ id: string }>();
				if (!run) return json({ error: "run_not_found" }, 404);
				const compilationRow = await env.DB.prepare(
					`SELECT compilation_json FROM demand_compilations WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`,
				).bind(bundle.project_id).first<{ compilation_json: string }>();
				if (!compilationRow) return json({ error: "demand_not_compiled" }, 422);
				const compiled = JSON.parse(compilationRow.compilation_json) as { requirements?: unknown[] };
				const requirementIds = new Set((compiled.requirements ?? []).flatMap(item => {
					if (!item || typeof item !== "object") return [];
					const id = (item as Record<string, unknown>).requirement_id;
					return typeof id === "string" ? [id] : [];
				}));
				if (bundle.candidates.some(candidate => !requirementIds.has(stringField(candidate, "requirement_id")))) {
					return json({ error: "candidate_requirement_out_of_scope" }, 422);
				}
				try {
					const saved = await persistM2ResearchBundle(env, bundle);
					return json({ ok: true, ...saved }, 201);
				} catch (error) {
					const detail = error instanceof Error ? error.message : "research persistence failed";
					console.error(JSON.stringify({ message: "M2 research persistence failed", run_id: runId, detail }));
					return json({ error: "research_persistence_failed", detail: detail.slice(0, 300) }, 422);
				}
			}

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

		// The list of the projects of the workspace, with the run that is
		// still going on or that finished last.
		if (request.method === "GET" && url.pathname === "/api/projects") {
			const requested = Number(url.searchParams.get("limit") ?? 50);
			const limit = Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.floor(requested))) : 50;
			const listSql = guestSessionId ? guestProjectsListSql : projectsListSql;
			const statement = env.DB.prepare(listSql);
			const { results } = await (guestSessionId ? statement.bind(limit, guestSessionId) : statement.bind(limit))
				.all<Record<string, unknown>>();
			return json({ projects: results.map((row) => {
				const project = shapeProject(row);
				if (guestSessionId && project.latest_run && typeof project.latest_run === "object") {
					const run = project.latest_run as Record<string, unknown>;
					project.latest_run = { ...run, current_stage: guestStage(run.current_stage, run.status) };
				}
				return project;
			}) });
		}

		// The runs of one project, so that a project can be opened from a
		// browser that never saw it before.
		const projectRunsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
		if (projectRunsMatch && request.method === "GET") {
			const projectId = decodeURIComponent(projectRunsMatch[1]);
			const { results } = await env.DB.prepare(projectRunsSql)
				.bind(projectId)
				.all<Record<string, unknown>>();
			return json({ runs: results.map((row) => {
				const run = shapeRun(row);
				return guestSessionId ? guestRunSummary(run) : run;
			}) });
		}

		// The text of the latest demand revision, so that the input can be
		// filled in again after a reload.
		const requirementTextMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirement-text$/);
		if (requirementTextMatch && request.method === "GET") {
			const projectId = decodeURIComponent(requirementTextMatch[1]);
			const row = await env.DB.prepare(requirementTextSql)
				.bind(projectId)
				.first<{ id: string; revision: number; text_content: string | null }>();
			if (!row || !row.text_content) return json({ error: "not_found" }, 404);
			return json({ source_id: row.id, revision: row.revision, text: row.text_content });
		}

		// The state of one demand compilation.
		const compileStatusMatch = url.pathname.match(
			/^\/api\/projects\/([^/]+)\/requirement-compile\/([^/]+)$/,
		);
		if (compileStatusMatch && request.method === "GET") {
			const projectId = decodeURIComponent(compileStatusMatch[1]);
			const compileId = decodeURIComponent(compileStatusMatch[2]);
			const row = await env.DB.prepare(compileStatusSql)
				.bind(projectId, compileId)
				.first<Record<string, unknown>>();
			if (!row) return json({ error: "not_found" }, 404);
			const detail = JSON.parse(String(row.detail_json ?? "{}")) as Record<string, unknown>;
			return json({
				compile_id: row.id,
				project_id: projectId,
				status: row.status,
				analysis_version: detail.analysis_version ?? null,
				demand_revision: detail.demand_revision ?? null,
				error: guestSessionId && row.error ? "COMPILE_FAILED" : row.error,
			});
		}

		// The state of the technical check and of the decision.
		const jobStatusMatch = url.pathname.match(
			/^\/api\/projects\/([^/]+)\/(spec-assessments|decisions)\/status$/,
		);
		if (jobStatusMatch && request.method === "GET") {
			const projectId = decodeURIComponent(jobStatusMatch[1]);
			const jobType = jobStatusMatch[2] === "decisions" ? "DECISION" : "SPEC_ASSESSMENT";
			const row = await env.DB.prepare(jobStatusSql)
				.bind(projectId, jobType)
				.first<Record<string, unknown>>();
			const revision = await env.DB.prepare(
				`SELECT demand_revision FROM projects WHERE id = ?1`,
			)
				.bind(projectId)
				.first<{ demand_revision: number }>();
			const job = shapeJobStatus(row, revision?.demand_revision ?? null);
			return json(guestSessionId ? { ...job, error: job.error ? "JOB_FAILED" : null, detail: {} } : job);
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
			if (guestSessionId) {
				await env.DB.prepare(
					`INSERT INTO projects (id, title, created_at, analysis_version, demand_revision, history_availability, session_id)
					 VALUES (?1, ?2, ?3, ?4, ?5, 'NOT_PROVIDED', ?6)`,
				).bind(projectId, body.title ?? "未命名寻源项目", now, analysisVersion, text ? 1 : 0, guestSessionId).run();
			} else {
				await env.DB.prepare(
					`INSERT INTO projects (id, title, created_at, analysis_version, demand_revision, history_availability)
					 VALUES (?1, ?2, ?3, ?4, ?5, 'NOT_PROVIDED')`,
				).bind(projectId, body.title ?? "未命名寻源项目", now, analysisVersion, text ? 1 : 0).run();
			}
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

		const pipelinesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/pipelines$/);
		if (pipelinesMatch && request.method === "GET") {
			if (env.PIPELINE_ENABLED !== "true") return json({ error: "operation_unavailable" }, 503);
			return listProjectPipelines(request, env.DB, decodeURIComponent(pipelinesMatch[1]), guestSessionId);
		}

		const analysisMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/analysis$/);
		if (analysisMatch && request.method === "GET") {
			if (env.PIPELINE_ENABLED !== "true") return json({ error: "operation_unavailable" }, 503);
			const projectId = decodeURIComponent(analysisMatch[1]);
			const pipelineId = url.searchParams.get("pipeline_id");
			const runId = url.searchParams.get("run_id");
			if (Boolean(pipelineId) === Boolean(runId)) return json({ error: "one_version_selector_required" }, 400);
			const pipeline = await env.DB.prepare(`SELECT id, project_id, run_id, decision_version, report_id, report_status, report_error_code
				FROM project_pipelines WHERE project_id = ?1 AND ${pipelineId ? "id" : "run_id"} = ?2`)
				.bind(projectId, pipelineId ?? runId).first<Record<string, unknown>>();
			if (!pipeline) return json({ error: "not_found" }, 404);
			const saved = await env.DB.prepare("SELECT payload_json, sha256 FROM pipeline_snapshots WHERE pipeline_id = ?1 AND snapshot_type = 'FINAL_CONTEXT'")
				.bind(pipeline.id).first<{ payload_json: string; sha256: string }>();
			if (!saved || !pipeline.decision_version) return json({ error: "analysis_version_unavailable" }, 409);
			if (saved.sha256 !== pipeline.decision_version || await sha256Hex(new TextEncoder().encode(saved.payload_json)) !== saved.sha256) return json({ error: "analysis_snapshot_integrity_error" }, 500);
			const final = JSON.parse(saved.payload_json) as Record<string, unknown>;
			if (final.project_id !== projectId || final.pipeline_id !== pipeline.id || final.run_id !== pipeline.run_id) return json({ error: "analysis_snapshot_integrity_error" }, 500);
			const report = { report_id: pipeline.report_id, status: pipeline.report_status, error_code: pipeline.report_error_code,
				decision_version: saved.sha256, download_path: pipeline.report_status === "COMPLETED" && pipeline.report_id
					? `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(String(pipeline.report_id))}/download` : null };
			return json({ ...shapePipelineAnalysis(final, report), decision_version: saved.sha256 });
		}

		const pipelineReportMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/pipeline\/([^/]+)\/report$/);
		if (pipelineReportMatch && request.method === "POST") {
			if (env.PIPELINE_ENABLED !== "true" || guestSessionId) return json({ error: "operation_unavailable" }, 503);
			const result = await startPipelineReport(env, decodeURIComponent(pipelineReportMatch[1]), decodeURIComponent(pipelineReportMatch[2]));
			if (result.kind !== "OK") return json({ error: result.kind.toLowerCase() }, result.kind === "NOT_FOUND" ? 404 : result.kind === "DECISION_UNAVAILABLE" ? 409 : 503);
			return json({ report_id: result.reportId, status: result.status, decision_version: result.decisionVersion }, result.status === "COMPLETED" ? 200 : 202);
		}

		const pipelineMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/pipeline(?:\/([^/]+))?$/);
		if (pipelineMatch) {
			// Guest reads are ownership-checked by authorizeGuest; expensive writes
			// remain disabled until strict deployment-wide quotas are enforced.
			if (env.PIPELINE_ENABLED !== "true") return json({ error: "operation_unavailable" }, 503);
			const projectId = decodeURIComponent(pipelineMatch[1]);
			if (request.method === "GET" && pipelineMatch[2]) {
				const id = decodeURIComponent(pipelineMatch[2]);
				const row = await env.DB.prepare(`SELECT id, project_id, run_id, demand_revision, status, stage, error, created_at, updated_at,
					decision_version, report_id, report_status, report_error_code, candidates_found, models_found, evidence_found
					FROM project_pipelines WHERE id = ?1 AND project_id = ?2`).bind(id, projectId).first<Record<string, unknown>>();
				if (!row) return json({ error: "not_found" }, 404);
				const stages = await env.DB.prepare("SELECT stage, status, started_at, finished_at, error_code FROM pipeline_stages WHERE pipeline_id = ?1 ORDER BY started_at, stage")
					.bind(id).all<Record<string, unknown>>();
				return json({ pipeline_id: row.id, project_id: row.project_id, run_id: row.run_id,
					demand_revision: row.demand_revision, status: row.status, stage: row.stage, error: row.error,
					decision_version: row.decision_version, report_id: row.report_id, report_status: row.report_status,
					report_error_code: row.report_error_code,
					candidates_found: row.candidates_found ?? 0, models_found: row.models_found ?? 0, evidence_found: row.evidence_found ?? 0,
					download_path: row.report_status === "COMPLETED" && row.report_id ? `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(String(row.report_id))}/download` : null,
					stages: stages.results, created_at: row.created_at, updated_at: row.updated_at });
			}
			if (request.method === "POST" && !pipelineMatch[2]) {
				const key = request.headers.get("idempotency-key") ?? "";
				if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) return json({ error: "idempotency_key_required" }, 400);
				const body = await request.json().catch(() => ({})) as { demand_revision?: unknown; research_budget?: ResearchBudgetConfig };
				const revision = body.demand_revision;
				if (!Number.isSafeInteger(revision) || Number(revision) < 1) return json({ error: "demand_revision_required" }, 422);
				// A caller may ask for a shorter or a deeper search. The bounds
				// keep one task from spending more than the shared budget.
				const requestedBudget = body.research_budget;
				let researchBudget: ResearchBudgetConfig | undefined;
				if (requestedBudget !== undefined) {
					const b = requestedBudget;
					if (!Number.isInteger(b.max_search_calls) || b.max_search_calls < 1 || b.max_search_calls > 12 ||
						!Number.isInteger(b.max_fetches) || b.max_fetches < 1 || b.max_fetches > 24 ||
						!Number.isInteger(b.max_tasks) || b.max_tasks < 1 || b.max_tasks > 3 ||
						!Number.isInteger(b.max_rounds) || b.max_rounds < 1 || b.max_rounds > 3 ||
						!Number.isInteger(b.max_model_calls) || b.max_model_calls < 1 || b.max_model_calls > 30) {
						return json({ error: "research_budget_out_of_range" }, 422);
					}
					researchBudget = b;
				}
				const compilation = await env.DB.prepare("SELECT compilation_json FROM demand_compilations WHERE project_id = ?1 AND demand_revision = ?2")
					.bind(projectId, revision).first<{ compilation_json: string }>();
				if (!compilation) return json({ error: "demand_not_compiled" }, 404);
				const demand = JSON.parse(compilation.compilation_json) as { requirements?: unknown[] };
				if (!Array.isArray(demand.requirements) || demand.requirements.length === 0) return json({ error: "no_recognizable_demand" }, 422);
				const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify({ demand_revision: revision })));
				const existing = await env.DB.prepare(
					"SELECT id, run_id, demand_revision, status FROM project_pipelines WHERE workspace_id = 'default' AND project_id = ?1 AND idempotency_key = ?2",
				).bind(projectId, key).first<{ id: string; run_id: string; demand_revision: number; status: string }>();
				if (existing) {
					return json({ pipeline_id: existing.id, run_id: existing.run_id, demand_revision: existing.demand_revision, status: existing.status, reused: true }, 202);
				}
				const pipelineId = crypto.randomUUID();
				if (guestSessionId) {
					const policy = guestAdmissionPolicy(env);
					if (!policy) return json({ error: "task_budget_not_configured" }, 503);
					const admission = await reserveGuestTask(env.DB, { sessionId: guestSessionId, projectId,
						operationId: pipelineId, kind: "PIPELINE", requestHash: digest, units: PIPELINE_UNITS }, policy);
					if (admission.kind === "DENIED") return json({ error: "budget_exhausted" }, 429);
					if (admission.kind === "CONFLICT") return json({ error: "idempotency_conflict" }, 409);
				}
				const result = await reservePipeline(env.DB, { projectId, pipelineId, runId: crypto.randomUUID(),
					idempotencyKey: key, requestHash: digest, demandRevision: Number(revision), demandJson: compilation.compilation_json });
				if (!("pipeline" in result)) {
					if (guestSessionId) await releaseGuestAdmission(env.DB, pipelineId, "PIPELINE");
					return json({ error: result.kind === "INPUT_CHANGED" ? "demand_revision_changed" : "idempotency_conflict" }, 409);
				}
				const row = result.pipeline;
				if (row.status === "QUEUED") {
					try {
						await env.PIPELINE_WORKFLOW.create({ id: row.id, params: { pipelineId: row.id, projectId, runId: row.run_id, researchBudget } });
					} catch {
						try { await (await env.PIPELINE_WORKFLOW.get(row.id)).status(); }
						catch { return json({ error: "workflow_start_failed" }, 503); }
					}
				}
				return json({ pipeline_id: row.id, run_id: row.run_id, demand_revision: row.demand_revision, status: row.status, reused: result.kind === "REUSED" }, 202);
			}
			return json({ error: "not_found" }, 404);
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
			return json(guestSessionId
				? { source_id: sourceId, purpose, revision, sha256: digest }
				: { source_id: sourceId, purpose, revision, r2_key: key, sha256: digest }, 201);
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
				.map(s => ({ source_id: s.id, revision: s.revision, text: s.text_content as string }));
			const pptxSources = results
				.filter(s => s.source_type === "INTERNAL_PPTX")
				.map(s => ({ source_id: s.id, filename: s.filename ?? "requirement.pptx", revision: s.revision }));
			if (textSources.length === 0 && pptxSources.length === 0) {
				return json({ error: "at least one demand source (text or PPTX) is required" }, 422);
			}

			// The model reads the whole document, so a long document takes several
			// minutes. A Worker request cannot hold the connection that long, so
			// the compile runs as a workflow and the client polls the result.
			// The state of the job is kept next to the project, so that the
			// client can tell a running compile from a failed one. The job is
			// written first, so that the workflow can report its outcome.
			const jobId = crypto.randomUUID();
			const now = new Date().toISOString();
			if (guestSessionId) {
				const policy = guestAdmissionPolicy(env);
				if (!policy) return json({ error: "task_budget_not_configured" }, 503);
				const admission = await reserveGuestTask(env.DB, { sessionId: guestSessionId, projectId,
					operationId: jobId, kind: "COMPILE", requestHash: `${projectId}:${project.demand_revision}`, units: COMPILE_UNITS }, policy);
				if (admission.kind === "DENIED") return json({ error: "budget_exhausted" }, 429);
				if (admission.kind === "CONFLICT") return json({ error: "idempotency_conflict" }, 409);
			}
			await env.DB.prepare(
				`INSERT INTO project_jobs (id, workspace_id, project_id, job_type, status, detail_json, created_at, updated_at)
				 VALUES (?1, 'default', ?2, 'COMPILE', 'QUEUED', ?3, ?4, ?4)`,
			)
				.bind(
					jobId,
					projectId,
					JSON.stringify({
						analysis_version: project.analysis_version,
						demand_revision: project.demand_revision,
					}),
					now,
				)
				.run();
			const instance = await env.COMPILE_WORKFLOW.create({
				params: {
					projectId,
					analysisVersion: project.analysis_version,
					demandRevision: project.demand_revision,
					textSources,
					pptxSources,
					sourceIds: results.map(s => s.id),
					jobId,
				},
			});
			await env.DB.prepare(
				`UPDATE project_jobs SET detail_json = ?2, updated_at = ?3
				 WHERE workspace_id = 'default' AND id = ?1`,
			)
				.bind(
					jobId,
					JSON.stringify({
						workflow_id: instance.id,
						analysis_version: project.analysis_version,
						demand_revision: project.demand_revision,
					}),
					now,
				)
				.run();
			return json({
				project_id: projectId,
				status: "QUEUED",
				compile_id: jobId,
				workflow_id: instance.id,
				analysis_version: project.analysis_version,
			}, 202);
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
			const compilation = JSON.parse(row.compilation_json) as Record<string, unknown>;
			// Failed compile jobs store an internal exception in an issue-only
			// record. Do not expose that exception to a guest. Normal compiled
			// demand, conflicts and source-backed gaps stay intact.
			if (guestSessionId && !Array.isArray(compilation.requirements) && Array.isArray(compilation.issues)) {
				return json({ analysis_version: row.analysis_version, compilation: { ...compilation, issues: ["COMPILE_FAILED"] } });
			}
			return json({ analysis_version: row.analysis_version, compilation });
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
			if (existing) {
				return json({
					dataset_id: existing.id,
					row_count: existing.row_count,
					column_count: existing.column_count,
					header_row: existing.header_row,
					is_synthetic: Boolean(existing.is_synthetic),
					analysis_version: existing.analysis_version,
					duplicate_import: true,
				});
			}

			const container = getContainer(env.SOURCING_CONTAINER, "m1-intake");
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

		const sourcingPlanMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sourcing-plan$/);
		if (sourcingPlanMatch && request.method === "GET") {
			const projectId = decodeURIComponent(sourcingPlanMatch[1]);
			const runId = url.searchParams.get("run_id");
			const query = runId
				? `SELECT plan_json FROM sourcing_plans WHERE workspace_id = 'default' AND project_id = ?1 AND run_id = ?2 ORDER BY plan_revision DESC LIMIT 1`
				: `SELECT plan_json FROM sourcing_plans WHERE workspace_id = 'default' AND project_id = ?1 ORDER BY created_at DESC, plan_revision DESC LIMIT 1`;
			const statement = runId ? env.DB.prepare(query).bind(projectId, runId) : env.DB.prepare(query).bind(projectId);
			const row = await statement.first<{ plan_json: string }>();
			if (!row) return json({ error: "sourcing_plan_not_found" }, 404);
			return json({ plan: JSON.parse(row.plan_json) });
		}

		const decisionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/decisions$/);
		if (decisionsMatch) {
			const projectId = decodeURIComponent(decisionsMatch[1]);
			if (request.method === "GET") {
				const { results } = await env.DB.prepare(
					`SELECT id, requirement_id, product_candidate_id, product_model_ref, recommendation,
					        technical_verdict, hard_spec_overall, accepted, priority_rank, rationale,
					        evidence_ids_json, gaps_json, next_actions_json, violations_json, decided_at, created_at
					 FROM sourcing_decisions
					 WHERE workspace_id = 'default' AND project_id = ?1
					 ORDER BY accepted DESC, priority_rank IS NULL, priority_rank, requirement_id, product_candidate_id
					 LIMIT 2000`,
				).bind(projectId).all<Record<string, unknown>>();
				return json({
					project_id: projectId,
					decisions: results.map((row) => ({
						decision_id: row.id,
						requirement_id: row.requirement_id,
						product_candidate_id: row.product_candidate_id,
						product_model_ref: row.product_model_ref,
						recommendation: row.recommendation,
						technical_verdict: row.technical_verdict,
						hard_spec_overall: row.hard_spec_overall,
						accepted: row.accepted === 1,
						priority_rank: row.priority_rank,
						rationale: row.rationale,
						evidence_ids: JSON.parse(String(row.evidence_ids_json ?? "[]")) as string[],
						gaps: JSON.parse(String(row.gaps_json ?? "[]")) as string[],
						next_actions: JSON.parse(String(row.next_actions_json ?? "[]")) as string[],
						violations: JSON.parse(String(row.violations_json ?? "[]")) as unknown[],
						decided_at: row.decided_at,
						created_at: row.created_at,
					})),
				});
			}
			if (request.method === "POST") {
				const project = await env.DB.prepare(`SELECT id FROM projects WHERE id = ?1`).bind(projectId).first<{ id: string }>();
				if (!project) return json({ error: "not_found" }, 404);
				const counted = await env.DB.prepare(
					`SELECT COUNT(*) AS count FROM spec_assessments WHERE workspace_id = 'default' AND project_id = ?1`,
				).bind(projectId).first<{ count: number }>();
				if (!counted || !counted.count) return json({ error: "no_spec_assessment" }, 409);
				const body = (await request.json().catch(() => ({}))) as { requirement_ids?: string[] };
				// The decision holds one model call open for minutes, so it runs
				// as a workflow and the client polls the result.
				const jobId = crypto.randomUUID();
				const now = new Date().toISOString();
				await env.DB.prepare(
					`INSERT INTO project_jobs (id, workspace_id, project_id, job_type, status, detail_json, created_at, updated_at)
					 VALUES (?1, 'default', ?2, 'DECISION', 'QUEUED', '{}', ?3, ?3)`,
				)
					.bind(jobId, projectId, now)
					.run();
				const instance = await env.DECISION_WORKFLOW.create({
					params: {
						projectId,
						requirementIds: body.requirement_ids ?? [],
						jobId,
					},
				});
				await env.DB.prepare(
					`UPDATE project_jobs SET detail_json = ?2, updated_at = ?3
					 WHERE workspace_id = 'default' AND id = ?1`,
				)
					.bind(jobId, JSON.stringify({ workflow_id: instance.id }), now)
					.run();
				return json({
					project_id: projectId,
					status: "QUEUED",
					decision_id: instance.id,
					job_id: jobId,
				}, 202);
			}
		}

		const reportsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reports$/);
		if (reportsMatch) {
			const projectId = decodeURIComponent(reportsMatch[1]);
			if (request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { run_id?: string; pipeline_id?: string };
				if (Boolean(body.run_id) === Boolean(body.pipeline_id)) return json({ error: "one_version_selector_required" }, 400);
				const pipeline = await env.DB.prepare(`SELECT id, run_id FROM project_pipelines WHERE project_id = ?1 AND ${body.pipeline_id ? "id" : "run_id"} = ?2`)
					.bind(projectId, body.pipeline_id ?? body.run_id).first<{ id: string; run_id: string }>();
				if (!pipeline) return json({ error: "analysis_version_unavailable" }, 409);
				const result = await startPipelineReport(env, projectId, pipeline.id);
				if (result.kind !== "OK") return json({ error: result.kind.toLowerCase() }, result.kind === "NOT_FOUND" ? 404 : result.kind === "DECISION_UNAVAILABLE" ? 409 : 503);
				return json({ report_id: result.reportId, run_id: pipeline.run_id, pipeline_id: pipeline.id,
					decision_version: result.decisionVersion, status: result.status }, result.status === "COMPLETED" ? 200 : 202);
			}
			if (request.method === "GET") {
				const { results } = await env.DB.prepare(reportsListSql)
					.bind(projectId)
					.all<Record<string, unknown>>();
				return json({
					project_id: projectId,
					reports: results.map((row) => shapeReport(row, projectId)),
				});
			}
		}

		const reportMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reports\/([^/]+)$/);
		if (reportMatch && request.method === "GET") {
			const projectId = decodeURIComponent(reportMatch[1]);
			const reportId = decodeURIComponent(reportMatch[2]);
			const report = await env.DB.prepare(reportStatusSql)
				.bind(projectId, reportId)
				.first<Record<string, unknown>>();
			if (!report) return json({ error: "not_found" }, 404);
			return json(shapeReport(report, projectId));
		}

		const reportDownloadMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reports\/([^/]+)\/download$/);
		if (reportDownloadMatch && request.method === "GET") {
			const projectId = decodeURIComponent(reportDownloadMatch[1]);
			const reportId = decodeURIComponent(reportDownloadMatch[2]);
			const report = await env.DB.prepare(
				`SELECT status, r2_key, pipeline_id, decision_version, sha256 FROM project_reports
				 WHERE workspace_id = 'default' AND project_id = ?1 AND id = ?2`,
			)
				.bind(projectId, reportId)
				.first<{ status: string; r2_key: string | null; pipeline_id: string | null; decision_version: string | null; sha256: string | null }>();
			if (!report) return json({ error: "not_found" }, 404);
			if (report.status !== "COMPLETED" || !report.r2_key) {
				return json({ error: "report_not_ready", status: report.status }, 409);
			}
			const object = await env.BUCKET.get(report.r2_key);
			if (!object) return json({ error: "report_missing" }, 404);
			if (report.pipeline_id && (object.customMetadata?.decision_version !== report.decision_version || object.customMetadata?.sha256 !== report.sha256)) return json({ error: "report_integrity_error" }, 500);
			return new Response(object.body, {
				headers: {
					"content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"content-disposition": `attachment; filename="procurement-report-${reportId.slice(0, 8)}.docx"`,
				},
			});
		}

		// The price of every requirement, with the scope it was computed in.
		// The rules live in the container, so the container computes them and
		// the gateway passes the answer on unchanged: there is one price
		// contract, not two.
		const priceContextMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/price-context$/);
		if (priceContextMatch && request.method === "GET") {
			const projectId = decodeURIComponent(priceContextMatch[1]);
			const response = await fetchContainer(
				env,
				env.CONTAINER_INSTANCE_NAME,
				"/internal/projects/price-context",
				{
					project_id: projectId,
					gateway_url: env.CONTAINER_GATEWAY_URL,
					token: env.INTERNAL_GATEWAY_TOKEN,
				},
			);
			if (response.status === 404) return json({ error: "not_found" }, 404);
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return json({ error: "price_context_unavailable", detail: body.slice(0, 200) }, 502);
			}
			const payload = (await response.json()) as { price_contexts?: unknown[] };
			return json({ project_id: projectId, price_contexts: payload.price_contexts ?? [] });
		}

		const specAssessmentsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/spec-assessments$/);
		if (specAssessmentsMatch) {
			const projectId = decodeURIComponent(specAssessmentsMatch[1]);
			if (request.method === "GET") {
				const { results } = await env.DB.prepare(
					`SELECT id, requirement_id, product_candidate_id, product_model_ref, demand_revision,
					        hard_spec_overall, overall_reason_codes_json, hard_constraint_count, calculator_version,
					        dsl_schema_version, assessment_json, evidence_ids_json, evaluated_at, created_at
					 FROM spec_assessments
					 WHERE workspace_id = 'default' AND project_id = ?1
					 ORDER BY requirement_id, hard_spec_overall DESC, product_candidate_id
					 LIMIT 1000`,
				).bind(projectId).all<Record<string, unknown>>();
				return json({
					project_id: projectId,
					assessments: results.map((row) => ({
						assessment_id: row.id,
						requirement_id: row.requirement_id,
						product_candidate_id: row.product_candidate_id,
						product_model_ref: row.product_model_ref,
						demand_revision: row.demand_revision,
						hard_spec_overall: row.hard_spec_overall,
						overall_reason_codes: JSON.parse(String(row.overall_reason_codes_json ?? "[]")) as string[],
						hard_constraint_count: row.hard_constraint_count,
						calculator_version: row.calculator_version,
						dsl_schema_version: row.dsl_schema_version,
						assessment: JSON.parse(String(row.assessment_json ?? "{}")) as unknown,
						evidence_ids: JSON.parse(String(row.evidence_ids_json ?? "[]")) as string[],
						evaluated_at: row.evaluated_at,
						created_at: row.created_at,
					})),
				});
			}
			if (request.method === "POST") {
				const project = await env.DB.prepare(`SELECT id FROM projects WHERE id = ?1`).bind(projectId).first<{ id: string }>();
				if (!project) return json({ error: "not_found" }, 404);
				const compilation = await env.DB.prepare(
					`SELECT demand_revision FROM demand_compilations WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`,
				).bind(projectId).first<{ demand_revision: number }>();
				if (!compilation) return json({ error: "demand_not_compiled" }, 409);
				const body = (await request.json().catch(() => ({}))) as {
					requirement_ids?: string[];
					candidate_ids?: string[];
					review_reason?: string;
				};
				// The typing and the alignment hold one model call open for
				// minutes, so the evaluation runs as a workflow and the client
				// polls the result.
				const jobId = crypto.randomUUID();
				const now = new Date().toISOString();
				await env.DB.prepare(
					`INSERT INTO project_jobs (id, workspace_id, project_id, job_type, status, detail_json, created_at, updated_at)
					 VALUES (?1, 'default', ?2, 'SPEC_ASSESSMENT', 'QUEUED', '{}', ?3, ?3)`,
				)
					.bind(jobId, projectId, now)
					.run();
				const instance = await env.SPEC_WORKFLOW.create({
					params: {
						projectId,
						requirementIds: body.requirement_ids ?? [],
						candidateIds: body.candidate_ids ?? [],
						reviewReason: String(body.review_reason ?? "").slice(0, 500),
						jobId,
					},
				});
				await env.DB.prepare(
					`UPDATE project_jobs SET detail_json = ?2, updated_at = ?3
					 WHERE workspace_id = 'default' AND id = ?1`,
				)
					.bind(jobId, JSON.stringify({ workflow_id: instance.id }), now)
					.run();
				return json({
					project_id: projectId,
					status: "QUEUED",
					assessment_id: instance.id,
					job_id: jobId,
					demand_revision: compilation.demand_revision,
				}, 202);
			}
		}

		const candidateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/candidates$/);
		if (candidateMatch && request.method === "GET") {
			const projectId = decodeURIComponent(candidateMatch[1]);
			const stage = url.searchParams.get("stage");
			const runId = url.searchParams.get("run_id");
			const project = await env.DB.prepare(`SELECT id FROM projects WHERE id = ?1`).bind(projectId).first<{ id: string }>();
			if (!project) return json({ error: "not_found" }, 404);
			const { results } = await env.DB.prepare(
				`SELECT c.id AS candidate_id, c.requirement_id, c.stage, c.rationale, c.open_questions_json,
				        c.first_seen_run_id, c.last_seen_run_id, c.updated_at,
				        s.id AS supplier_id, s.display_name AS supplier_name, s.website_domain, s.identity_status, s.role,
				        p.id AS product_id, p.product_name, p.brand, p.model, p.product_category,
				        e.id AS evidence_id, e.source_url, e.title AS evidence_title, e.retrieved_at, e.excerpt, e.content_date_hints_json
				 FROM project_candidates c
				 JOIN intelligence_suppliers s ON s.workspace_id = c.workspace_id AND s.id = c.supplier_id
				 LEFT JOIN intelligence_products p ON p.workspace_id = c.workspace_id AND p.id = c.product_id
				 LEFT JOIN project_candidate_evidence ce ON ce.workspace_id = c.workspace_id AND ce.candidate_id = c.id
				 LEFT JOIN research_evidence e ON e.workspace_id = ce.workspace_id AND e.id = ce.evidence_id
				 WHERE c.workspace_id = 'default' AND c.project_id = ?1
				   AND (?2 IS NULL OR c.stage = ?2) AND (?3 IS NULL OR c.last_seen_run_id = ?3)
				 ORDER BY c.updated_at DESC LIMIT 600`,
			).bind(projectId, stage, runId).all<Record<string, unknown>>();
			const grouped = new Map<string, Record<string, unknown> & { evidence: Record<string, unknown>[] }>();
			for (const row of results) {
				const id = String(row.candidate_id);
				let item = grouped.get(id);
				if (!item) {
					item = {
						candidate_id: id,
						requirement_id: row.requirement_id,
						stage: row.stage,
						rationale: row.rationale,
						open_questions: JSON.parse(String(row.open_questions_json || "[]")),
						first_seen_run_id: row.first_seen_run_id,
						last_seen_run_id: row.last_seen_run_id,
						updated_at: row.updated_at,
						supplier: {
							supplier_id: row.supplier_id, display_name: row.supplier_name,
							website_domain: row.website_domain, identity_status: row.identity_status, role: row.role,
						},
						product: row.product_id ? {
							product_id: row.product_id, product_name: row.product_name,
							brand: row.brand, model: row.model, product_category: row.product_category,
						} : null,
						evidence: [],
					};
					grouped.set(id, item);
				}
				if (row.evidence_id && !item.evidence.some(evidence => evidence.evidence_id === row.evidence_id)) {
					const excerpt = evidenceDisplayExcerpt(typeof row.excerpt === "string" ? row.excerpt : null);
					item.evidence.push({
						evidence_id: row.evidence_id, source_url: row.source_url,
						title: row.evidence_title, retrieved_at: row.retrieved_at, excerpt: excerpt.text,
						excerpt_status: excerpt.status,
						content_date_hints: JSON.parse(String(row.content_date_hints_json ?? "[]")),
					});
				}
			}
			return json({ candidates: [...grouped.values()] });
		}

		const workspaceSuppliersMatch = url.pathname.match(/^\/api\/workspaces\/default\/suppliers$/);
		if (workspaceSuppliersMatch && request.method === "GET") {
			const search = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
			const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
			const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 50;
			const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
			const { results } = await env.DB.prepare(
				`SELECT s.id AS supplier_id, s.display_name, s.website_domain, s.identity_status, s.role,
				        s.first_observed_at, s.last_observed_at, COUNT(DISTINCT o.product_id) AS product_count
				 FROM intelligence_suppliers s
				 LEFT JOIN supplier_product_offerings o ON o.workspace_id = s.workspace_id AND o.supplier_id = s.id
				 WHERE s.workspace_id = 'default' AND (?1 = '%%' OR s.display_name LIKE ?1 ESCAPE '\\' OR s.website_domain LIKE ?1 ESCAPE '\\')
				 GROUP BY s.id ORDER BY s.last_observed_at DESC LIMIT ?2`,
			).bind(like, limit).all();
			return json({ suppliers: results });
		}

		const supplierDetailMatch = url.pathname.match(/^\/api\/workspaces\/default\/suppliers\/([^/]+)$/);
		if (supplierDetailMatch && request.method === "GET") {
			const supplierId = decodeURIComponent(supplierDetailMatch[1]);
			const supplier = await env.DB.prepare(
				`SELECT id AS supplier_id, display_name, website_domain, identity_status, role, first_observed_at, last_observed_at
				 FROM intelligence_suppliers WHERE workspace_id = 'default' AND id = ?1`,
			).bind(supplierId).first<Record<string, unknown>>();
			if (!supplier) return json({ error: "not_found" }, 404);
			const { results: products } = await env.DB.prepare(
				`SELECT p.id AS product_id, p.product_name, p.brand, p.model, p.product_category,
				        o.relationship_status, o.last_observed_at
				 FROM supplier_product_offerings o JOIN intelligence_products p
				   ON p.workspace_id = o.workspace_id AND p.id = o.product_id
				 WHERE o.workspace_id = 'default' AND o.supplier_id = ?1 ORDER BY o.last_observed_at DESC LIMIT 100`,
			).bind(supplierId).all();
			const { results: evidence } = await env.DB.prepare(
				`SELECT e.id AS evidence_id, e.source_url, e.title, e.retrieved_at, e.excerpt, e.content_date_hints_json
				 FROM intelligence_entity_evidence l JOIN research_evidence e
				   ON e.workspace_id = l.workspace_id AND e.id = l.evidence_id
				 WHERE l.workspace_id = 'default' AND l.entity_type = 'SUPPLIER' AND l.entity_id = ?1
				 ORDER BY e.retrieved_at DESC LIMIT 50`,
			).bind(supplierId).all<Record<string, unknown>>();
			return json({ supplier, products, evidence: evidence.map(row => {
				const excerpt = evidenceDisplayExcerpt(typeof row.excerpt === "string" ? row.excerpt : null);
				return { ...row, excerpt: excerpt.text, excerpt_status: excerpt.status };
			}) });
		}

		const runsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
		if (runsMatch && request.method === "POST") {
			const projectId = runsMatch[1];
			const body = (await request.json().catch(() => ({}))) as {
				duration_seconds?: number;
				idempotency_key?: string;
				mode?: "SPIKE" | "SOURCING";
				research_budget?: ResearchBudgetConfig;
			};
			const durationSeconds = body.duration_seconds ?? 150;
			const mode = body.mode ?? "SOURCING";
			const researchBudget = body.research_budget ?? { max_search_calls: 4, max_fetches: 4, max_tasks: 2, max_rounds: 2, max_model_calls: 15 };
			if (!["SPIKE", "SOURCING"].includes(mode)) return json({ error: "invalid_run_mode" }, 422);
			if (
				!Number.isInteger(researchBudget.max_search_calls) || researchBudget.max_search_calls < 1 || researchBudget.max_search_calls > 12 ||
				!Number.isInteger(researchBudget.max_fetches) || researchBudget.max_fetches < 1 || researchBudget.max_fetches > 24 ||
				!Number.isInteger(researchBudget.max_tasks) || researchBudget.max_tasks < 1 || researchBudget.max_tasks > 3 ||
				!Number.isInteger(researchBudget.max_rounds) || researchBudget.max_rounds < 1 || researchBudget.max_rounds > 3 ||
				!Number.isInteger(researchBudget.max_model_calls) || researchBudget.max_model_calls < 1 || researchBudget.max_model_calls > 30
			) return json({ error: "research_budget_out_of_range" }, 422);
			if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600) {
				return json({ error: "duration_seconds_out_of_range" }, 422);
			}
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
			if (mode === "SOURCING" && !demandData.requirements?.length) {
				return json({ error: "structured_requirement_required_for_m2" }, 422);
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
			await upsertRun(env, { runId, projectId, durationSeconds, mode, researchBudget }, body.idempotency_key);
			await env.WORKFLOW.create({ params: { runId, projectId, durationSeconds, mode, researchBudget } });
			return json({ run_id: runId, status: "QUEUED", mode, research_budget: researchBudget }, 202);
		}

		const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
		if (runMatch && request.method === "GET") {
			const run = await env.DB.prepare(
				`SELECT id, project_id, status, current_stage, artifact_key, last_error, created_at, updated_at
				 FROM runs WHERE id = ?1`,
			)
				.bind(runMatch[1])
				.first<RunRow>();
			if (!run) return json({ error: "not_found" }, 404);
			return json(guestSessionId ? guestRun(run) : run);
		}

		const researchRunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/research$/);
		if (researchRunMatch && request.method === "GET") {
			const runId = decodeURIComponent(researchRunMatch[1]);
			const run = await env.DB.prepare(`SELECT id, project_id, status, current_stage FROM runs WHERE id = ?1`)
				.bind(runId).first<{ id: string; project_id: string; status: string; current_stage: string }>();
			if (!run) return json({ error: "not_found" }, 404);
			const planRow = await env.DB.prepare(
				`SELECT plan_json FROM sourcing_plans WHERE workspace_id = 'default' AND run_id = ?1 ORDER BY plan_revision DESC LIMIT 1`,
			).bind(runId).first<{ plan_json: string }>();
			const { results: tasks } = await env.DB.prepare(
				`SELECT id AS task_id, research_question, channel, status, findings_json, created_at
				 FROM research_tasks WHERE workspace_id = 'default' AND run_id = ?1 ORDER BY created_at, id`,
			).bind(runId).all<Record<string, unknown>>();
			const { results: actions } = await env.DB.prepare(
				`SELECT id AS action_id, task_id, research_question, channel, tool_name, query,
				        result_refs_json, remaining_gaps_json, decision, cost_search_calls, cost_fetch_calls, occurred_at
				 FROM research_actions WHERE workspace_id = 'default' AND run_id = ?1 ORDER BY occurred_at, id`,
			).bind(runId).all<Record<string, unknown>>();
			const costs = await env.DB.prepare(
				`SELECT status, stop_reason_code, search_calls, fetch_calls, model_calls, prompt_tokens, completion_tokens,
				        token_usage_observed, model_call_details_json, trace_run_ids_json, langsmith_tracing_enabled, candidate_count, evidence_count, reused_intelligence_count,
				        refreshed_intelligence_count, ignored_intelligence_count, warnings_json
				 FROM research_run_costs WHERE workspace_id = 'default' AND run_id = ?1`,
			).bind(runId).first<{
				status: string; stop_reason_code: string | null; search_calls: number; fetch_calls: number;
				model_calls: number; prompt_tokens: number; completion_tokens: number;
				token_usage_observed: number; model_call_details_json: string; trace_run_ids_json: string;
				langsmith_tracing_enabled: number; candidate_count: number;
				evidence_count: number; reused_intelligence_count: number; refreshed_intelligence_count: number;
				ignored_intelligence_count: number; warnings_json: string;
			}>();
			if (guestSessionId) return json({
				run: { ...run, current_stage: guestStage(run.current_stage, run.status) },
				metrics: { status: costs?.status ?? run.status, stop_reason_code: guestStopReason(costs?.stop_reason_code),
					candidate_count: costs?.candidate_count ?? 0, evidence_count: costs?.evidence_count ?? 0 },
			});
			return json({
				run,
				plan: planRow ? JSON.parse(planRow.plan_json) : null,
				tasks: tasks.map(task => ({ ...task, findings: task.findings_json ? JSON.parse(String(task.findings_json)) : null })),
				actions: actions.map(action => ({
					...action,
					result_refs: JSON.parse(String(action.result_refs_json || "[]")),
					remaining_gaps: JSON.parse(String(action.remaining_gaps_json || "[]")),
				})),
				metrics: {
					status: costs?.status ?? run.status,
					stop_reason_code: costs?.stop_reason_code ?? null,
					search_calls: costs?.search_calls ?? actions.reduce((sum, action) => sum + Number(action.cost_search_calls ?? 0), 0),
					fetch_calls: costs?.fetch_calls ?? actions.reduce((sum, action) => sum + Number(action.cost_fetch_calls ?? 0), 0),
					model_calls: costs?.model_calls ?? 0,
					prompt_tokens: costs?.prompt_tokens ?? 0,
					completion_tokens: costs?.completion_tokens ?? 0,
					token_usage_observed: Boolean(costs?.token_usage_observed ?? 0),
					model_call_details: JSON.parse(costs?.model_call_details_json ?? "[]"),
					trace_run_ids: JSON.parse(costs?.trace_run_ids_json ?? "{}"),
					langsmith_tracing_enabled: Boolean(costs?.langsmith_tracing_enabled ?? 0),
					researcher_tasks: tasks.length,
					candidate_count: costs?.candidate_count ?? 0,
					evidence_count: costs?.evidence_count ?? 0,
					reused_intelligence_count: costs?.reused_intelligence_count ?? 0,
					refreshed_intelligence_count: costs?.refreshed_intelligence_count ?? 0,
					ignored_intelligence_count: costs?.ignored_intelligence_count ?? 0,
					warnings: JSON.parse(costs?.warnings_json ?? "[]"),
				},
			});
		}

		const evidenceMatch = url.pathname.match(/^\/api\/evidence\/([^/]+)$/);
		if (evidenceMatch && request.method === "GET") {
			const evidenceId = decodeURIComponent(evidenceMatch[1]);
			const evidence = await env.DB.prepare(
				`SELECT id AS evidence_id, source_type, source_url, normalized_url, title, publisher,
				        retrieved_at, locator, excerpt, content_sha256, content_date_hints_json,
				        snapshot_r2_key, trust_notes
				 FROM research_evidence WHERE workspace_id = 'default' AND id = ?1`,
			).bind(evidenceId).first<Record<string, unknown>>();
			if (!evidence) return json({ error: "not_found" }, 404);
			const snapshot = await env.BUCKET.get(String(evidence.snapshot_r2_key));
			if (!snapshot) return json({ error: "evidence_snapshot_missing" }, 404);
			const { snapshot_r2_key: _snapshotKey, locator: _internalLocator, ...publicEvidence } = evidence;
			const displayedExcerpt = evidenceDisplayExcerpt(typeof evidence.excerpt === "string" ? evidence.excerpt : null);
			return json({
				evidence: {
					...publicEvidence,
					excerpt: displayedExcerpt.text,
					excerpt_status: displayedExcerpt.status,
					content_date_hints: JSON.parse(String(evidence.content_date_hints_json ?? "[]")),
					snapshot_text: await snapshot.text(),
				},
			});
		}

		const eventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
		if (eventsMatch && request.method === "GET") {
			const { results } = await env.DB.prepare(
				`SELECT stage, detail, created_at FROM run_events WHERE run_id = ?1 ORDER BY created_at ASC`,
			)
				.bind(eventsMatch[1])
				.all();
			return json({ events: guestSessionId ? results.map(row => guestEvent(row as Record<string, unknown>)) : results });
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
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (env.GUEST_SESSION_ENABLED !== "true" || !new URL(request.url).pathname.startsWith("/api/")) {
			return handleFetch(request, env);
		}
		try {
			const response = await handleFetch(request, env);
			const headers = new Headers(response.headers);
			headers.set("cache-control", "private, no-store");
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
		} catch (error) {
			console.error("guest API request failed", error);
			return Response.json({ error: "internal_error" }, { status: 500, headers: { "cache-control": "private, no-store" } });
		}
	},
};
