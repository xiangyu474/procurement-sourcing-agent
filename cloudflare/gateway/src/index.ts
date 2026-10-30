import { Container, getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	SOURCING_CONTAINER: DurableObjectNamespace<Container<Env>>;
	INTERNAL_GATEWAY_TOKEN: string;
	DEMO_ACCESS_TOKEN: string;
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
	ACCEPTANCE_WORKFLOW: Workflow<AcceptanceRequest>;
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
			 ON CONFLICT(id) DO UPDATE SET stage = excluded.stage, rationale = excluded.rationale,
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
}

export class SourcingCompileWorkflow extends WorkflowEntrypoint<Env, CompileRequest> {
	async run(event: WorkflowEvent<CompileRequest>, step: WorkflowStep) {
		const { projectId, analysisVersion, demandRevision, textSources, pptxSources, sourceIds } = event.payload;
		try {
			const result = await step.do(
				"compile-demand",
				{ retries: { limit: 0, delay: "10 seconds", backoff: "exponential" }, timeout: "20 minutes" },
				async () => {
					const container = getContainer(this.env.SOURCING_CONTAINER, this.env.CONTAINER_INSTANCE_NAME);
					// The instance sleeps when it is idle, so it has to be
					// started before it can answer.
					await container.start();
					const response = await container.fetch(
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
			return { status: "COMPLETED", ...result };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
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
			return { status: "FAILED", error: detail.slice(0, 500) };
		}
	}
}

interface SpecRequest {
	projectId: string;
	requirementIds: string[];
	candidateIds: string[];
}

interface DecisionRequest {
	projectId: string;
	requirementIds: string[];
}

interface AcceptanceRequest {
	title: string;
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
		const { projectId, requirementIds } = event.payload;
		try {
			const result = await step.do(
				"write-decisions",
				{ retries: { limit: 1, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" },
				async () => {
					const container = getContainer(this.env.SOURCING_CONTAINER, this.env.CONTAINER_INSTANCE_NAME);
					// The instance sleeps when it is idle, so it has to be
					// started before it can answer.
					await container.start();
					const response = await container.fetch(
						new Request("http://container/internal/decide", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
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
							}),
						}),
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
			return {
				status: outcome.status ?? "COMPLETED",
				decisions: outcome.decisions ?? 0,
				accepted: outcome.accepted ?? 0,
				rejected: outcome.rejected ?? 0,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
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
		const { projectId, requirementIds, candidateIds } = event.payload;
		try {
			const result = await step.do(
				"evaluate-spec",
				{ retries: { limit: 1, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" },
				async () => {
					const container = getContainer(this.env.SOURCING_CONTAINER, this.env.CONTAINER_INSTANCE_NAME);
					// The instance sleeps when it is idle, so it has to be
					// started before it can answer.
					await container.start();
					const response = await container.fetch(
						new Request("http://container/internal/evaluate-spec", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
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
							}),
						}),
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
			return {
				status: outcome.status ?? "COMPLETED",
				assessments: outcome.assessments ?? 0,
				by_overall: outcome.by_overall ?? {},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { status: "FAILED", error: message.slice(0, 400) };
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
					retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
					timeout: "20 minutes",
				},
				async () => {
					const container = getContainer(this.env.SOURCING_CONTAINER, this.env.CONTAINER_INSTANCE_NAME);
					// The instance sleeps when it is idle, so it has to be
					// started before it can answer.
					await container.start();
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
									gateway_url: this.env.CONTAINER_GATEWAY_URL,
									token: this.env.INTERNAL_GATEWAY_TOKEN,
									runtime_config: runtimeConfig,
									research_budget: event.payload.researchBudget ?? { max_search_calls: 4, max_fetches: 4, max_tasks: 2, max_rounds: 2, max_model_calls: 15 },
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
				const compilationRow = await env.DB.prepare(
					`SELECT compilation_json FROM demand_compilations WHERE project_id = ?1 ORDER BY demand_revision DESC LIMIT 1`,
				).bind(projectId).first<{ compilation_json: string }>();
				if (!compilationRow) return json({ error: "demand_not_compiled" }, 404);
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

			const specContextMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/spec-context$/);
			if (specContextMatch && request.method === "GET") {
				const projectId = decodeURIComponent(specContextMatch[1]);
				const wantedRequirements = (url.searchParams.get("requirement_ids") ?? "").split(",").filter(Boolean);
				const wantedCandidates = (url.searchParams.get("candidate_ids") ?? "").split(",").filter(Boolean);
				const compilationRow = await env.DB.prepare(
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

				const { results: candidateRows } = await env.DB.prepare(
					`SELECT c.id AS candidate_id, c.requirement_id, c.supplier_id, c.product_id, c.stage, c.rationale,
					        c.open_questions_json, p.model AS product_model
					 FROM project_candidates c
					 LEFT JOIN intelligence_products p ON p.workspace_id = c.workspace_id AND p.id = c.product_id
					 WHERE c.workspace_id = 'default' AND c.project_id = ?1
					 ORDER BY c.updated_at DESC LIMIT 600`,
				).bind(projectId).all<{
					candidate_id: string; requirement_id: string; supplier_id: string; product_id: string | null;
					stage: string; rationale: string; open_questions_json: string; product_model: string | null;
				}>();
				const candidates = candidateRows
					.filter((row) => wantedCandidates.length === 0 || wantedCandidates.includes(row.candidate_id))
					.map((row) => ({
						candidate_id: row.candidate_id,
						requirement_id: row.requirement_id,
						supplier_id: row.supplier_id,
						product_id: row.product_id,
						stage: row.stage,
						rationale: row.rationale,
						evidence_ids: [] as string[],
						open_questions: JSON.parse(row.open_questions_json ?? "[]") as string[],
					}));

				const { results: claimRows } = await env.DB.prepare(
					`SELECT cc.id AS claim_id, cc.subject_type, cc.subject_id, cc.attribute, cc.value, cc.unit,
					        cc.status, cc.evaluation_method, ce.evidence_id, ce.source_quote
					 FROM research_claims cc
					 JOIN claim_evidence_links ce ON ce.workspace_id = cc.workspace_id AND ce.claim_id = cc.id
					 WHERE cc.workspace_id = 'default' AND cc.subject_type = 'PRODUCT_MODEL'
					   AND cc.subject_id IN (SELECT DISTINCT product_id FROM project_candidates
					        WHERE workspace_id = 'default' AND project_id = ?1)
					 LIMIT 2000`,
				).bind(projectId).all<{
					claim_id: string; subject_type: string; subject_id: string; attribute: string; value: string;
					unit: string | null; status: string; evaluation_method: string; evidence_id: string; source_quote: string;
				}>();
				const seenClaims = new Set<string>();
				const claims = claimRows
					.filter((row) => {
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
				for (const row of candidateRows) {
					if (row.product_id && row.product_model) modelByProduct[row.product_id] = row.product_model;
				}
				return json({
					project_id: projectId,
					demand_revision: compilationRow.demand_revision,
					requirements,
					unstructured_requirements: compilation.unstructured_requirements ?? [],
					candidates,
					claims,
					model_by_product: modelByProduct,
				});
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
				}
				if (statements.length > 0) await env.DB.batch(statements);
				return json({ stored: statements.length });
			}

			const specResultsMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/spec-results$/);
			if (specResultsMatch && request.method === "POST") {
				const projectId = decodeURIComponent(specResultsMatch[1]);
				const body = (await request.json()) as {
					demand_revision?: number;
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
						assessment?: unknown;
					}[];
				};
				const revision = Number(body.demand_revision ?? 1);
				const now = new Date().toISOString();
				const statements = [];
				for (const item of body.assessments ?? []) {
					const requirementId = String(item.requirement_id ?? "");
					const candidateId = String(item.product_candidate_id ?? "");
					if (!requirementId || !candidateId) continue;
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
							calculator_version, dsl_schema_version, assessment_json, evidence_ids_json, evaluated_at, created_at)
						 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
						 ON CONFLICT(workspace_id, project_id, requirement_id, product_candidate_id, demand_revision) DO UPDATE SET
							product_model_ref = excluded.product_model_ref,
							hard_spec_overall = excluded.hard_spec_overall,
							overall_reason_codes_json = excluded.overall_reason_codes_json,
							hard_constraint_count = excluded.hard_constraint_count,
							calculator_version = excluded.calculator_version,
							dsl_schema_version = excluded.dsl_schema_version,
							assessment_json = excluded.assessment_json,
							evidence_ids_json = excluded.evidence_ids_json,
							evaluated_at = excluded.evaluated_at,
							created_at = excluded.created_at`,
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
			const instance = await env.COMPILE_WORKFLOW.create({
				params: {
					projectId,
					analysisVersion: project.analysis_version,
					demandRevision: project.demand_revision,
					textSources,
					pptxSources,
					sourceIds: results.map(s => s.id),
				},
			});
			return json({
				project_id: projectId,
				status: "QUEUED",
				compile_id: instance.id,
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
				const instance = await env.DECISION_WORKFLOW.create({
					params: {
						projectId,
						requirementIds: body.requirement_ids ?? [],
					},
				});
				return json({
					project_id: projectId,
					status: "QUEUED",
					decision_id: instance.id,
				}, 202);
			}
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
				};
				// The typing and the alignment hold one model call open for
				// minutes, so the evaluation runs as a workflow and the client
				// polls the result.
				const instance = await env.SPEC_WORKFLOW.create({
					params: {
						projectId,
						requirementIds: body.requirement_ids ?? [],
						candidateIds: body.candidate_ids ?? [],
					},
				});
				return json({
					project_id: projectId,
					status: "QUEUED",
					assessment_id: instance.id,
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
					item.evidence.push({
						evidence_id: row.evidence_id, source_url: row.source_url,
						title: row.evidence_title, retrieved_at: row.retrieved_at, excerpt: row.excerpt,
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
			).bind(supplierId).all();
			return json({ supplier, products, evidence });
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
			return json(run);
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
			return json({
				evidence: {
					...evidence,
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
