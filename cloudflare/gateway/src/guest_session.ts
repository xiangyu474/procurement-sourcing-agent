// Guest access is opt-in until quotas and integration acceptance are complete.
// This module never accepts the demo or internal bearer token as a guest identity.
export interface GuestEnv {
	DB: D1Database;
	GUEST_SESSION_SECRET?: string;
	GUEST_PUBLIC_ORIGIN?: string;
	GUEST_SESSION_GLOBAL_PER_HOUR?: string;
	GUEST_SESSION_IP_PER_HOUR?: string;
	GUEST_GLOBAL_REQUESTS_PER_MINUTE?: string;
	GUEST_SESSION_REQUESTS_PER_MINUTE?: string;
}

const COOKIE = "__Host-ps_session";
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const error = (code: string, status: number, retryAfter?: number) => Response.json({ error: code }, {
	status, headers: { "cache-control": "no-store", ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }) },
});

function originAllowed(request: Request, env: GuestEnv): boolean {
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	try {
		const expected = new URL(env.GUEST_PUBLIC_ORIGIN ?? request.url);
		return expected.protocol === "https:" && origin === expected.origin;
	} catch {
		return false;
	}
}

function cookieValue(request: Request): string | null {
	const cookies = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim());
	const matches = cookies.filter(part => part.startsWith(`${COOKIE}=`));
	// Ambiguous duplicate cookies are rejected, not interpreted differently by different layers.
	return matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : null;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function key(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(id: string, secret: string): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(id))));
}

async function verifiedId(request: Request, secret: string): Promise<string | null> {
	const token = cookieValue(request);
	const match = token?.match(/^([0-9a-f]{64})\.([0-9a-f]{64})$/);
	if (!match) return null;
	const signature = new Uint8Array(match[2].match(/../g)!.map(byte => parseInt(byte, 16)));
	return await crypto.subtle.verify("HMAC", await key(secret), signature, encoder.encode(match[1])) ? match[1] : null;
}

function configuredLimit(value: string | undefined): number | null {
	if (!value || !/^[1-9]\d{0,5}$/.test(value)) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number <= 100_000 ? number : null;
}

/** A single conditional UPSERT atomically consumes one fixed-window slot. */
async function consumeSlot(db: D1Database, table: "guest_session_creation_windows" | "guest_request_windows", scope: string, window: number, limit: number): Promise<number | null> {
	const row = await db.prepare(`INSERT INTO ${table} (scope, window_start, request_count)
		VALUES (?1, ?2, 1) ON CONFLICT(scope, window_start) DO UPDATE SET request_count = request_count + 1
		WHERE request_count < ?3 RETURNING request_count`).bind(scope, window, limit).first<{ request_count: number }>();
	return row?.request_count ?? null;
}

async function creationRateLimit(request: Request, env: GuestEnv): Promise<Response | null> {
	const globalLimit = configuredLimit(env.GUEST_SESSION_GLOBAL_PER_HOUR);
	const ipLimit = configuredLimit(env.GUEST_SESSION_IP_PER_HOUR);
	if (globalLimit === null || ipLimit === null) return error("session_rate_limit_not_configured", 503);
	// CF-Connecting-IP is supplied by Cloudflare for direct edge traffic. It can
	// be modified by same-zone Worker subrequests, so it is only an abuse signal;
	// the separate global counter remains mandatory even when the IP changes.
	const ip = request.headers.get("cf-connecting-ip")?.trim();
	if (!ip || ip.length > 45 || !/^[a-fA-F0-9:.]+$/.test(ip)) return error("client_address_unavailable", 503);
	const scopeHash = toHex(new Uint8Array(await crypto.subtle.sign(
		"HMAC", await key(env.GUEST_SESSION_SECRET!), encoder.encode(`guest-session-ip-v1:${ip}`),
	)));
	const now = Date.now();
	const window = Math.floor(now / 3_600_000);
	const retryAfter = Math.max(1, Math.ceil(((window + 1) * 3_600_000 - now) / 1000));
	try {
		// A denied IP must not drain the global window. If the global check or
		// session insert later fails, the already-consumed IP slot is not refunded.
		if (await consumeSlot(env.DB, "guest_session_creation_windows", `ip:${scopeHash}`, window, ipLimit) === null) return error("rate_limited", 429, retryAfter);
		const globalCount = await consumeSlot(env.DB, "guest_session_creation_windows", "global", window, globalLimit);
		if (globalCount === null) return error("rate_limited", 429, retryAfter);
		// Bound retention without relying on process-local state or a timer. The
		// first creation in a new hour removes hashed counters older than a day.
		if (globalCount === 1) await env.DB.prepare("DELETE FROM guest_session_creation_windows WHERE window_start < ?1").bind(window - 24).run();
		return null;
	} catch (cause) {
		console.error("guest session creation limiter unavailable", cause instanceof Error ? cause.name : "unknown");
		return error("session_unavailable", 503);
	}
}

async function requestRateLimit(env: GuestEnv, sessionId: string): Promise<Response | null> {
	const globalLimit = configuredLimit(env.GUEST_GLOBAL_REQUESTS_PER_MINUTE);
	const sessionLimit = configuredLimit(env.GUEST_SESSION_REQUESTS_PER_MINUTE);
	if (globalLimit === null || sessionLimit === null) return error("request_rate_limit_not_configured", 503);
	const scopeHash = toHex(new Uint8Array(await crypto.subtle.sign(
		"HMAC", await key(env.GUEST_SESSION_SECRET!), encoder.encode(`guest-request-session-v1:${sessionId}`),
	)));
	const now = Date.now();
	const window = Math.floor(now / 60_000);
	const retryAfter = Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000));
	try {
		if (await consumeSlot(env.DB, "guest_request_windows", `session:${scopeHash}`, window, sessionLimit) === null) return error("rate_limited", 429, retryAfter);
		const globalCount = await consumeSlot(env.DB, "guest_request_windows", "global", window, globalLimit);
		if (globalCount === null) return error("rate_limited", 429, retryAfter);
		if (globalCount === 1) await env.DB.prepare("DELETE FROM guest_request_windows WHERE window_start < ?1").bind(window - 1440).run();
		return null;
	} catch (cause) {
		console.error("guest request limiter unavailable", cause instanceof Error ? cause.name : "unknown");
		return error("session_unavailable", 503);
	}
}

interface SessionRow { id: string; expires_at: string }
async function lookup(request: Request, env: GuestEnv): Promise<SessionRow | null> {
	const id = await verifiedId(request, env.GUEST_SESSION_SECRET!);
	if (!id) return null;
	return env.DB.prepare("SELECT id, expires_at FROM guest_sessions WHERE id = ?1 AND expires_at > ?2")
		.bind(id, new Date().toISOString()).first<SessionRow>();
}

export type GuestResult = { response: Response } | { sessionId: string };

/** Called before public routes. Unknown resources fail closed; no implicit sessions. */
export async function authorizeGuest(request: Request, env: GuestEnv): Promise<GuestResult> {
	if (!env.GUEST_SESSION_SECRET || encoder.encode(env.GUEST_SESSION_SECRET).length < 32) {
		return { response: error("session_not_configured", 503) };
	}
	const url = new URL(request.url);
	const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
	if (unsafe && !originAllowed(request, env)) return { response: error("origin_mismatch", 403) };

	if (url.pathname === "/api/session") {
		if (request.method !== "GET" && request.method !== "POST") return { response: error("not_found", 404) };
		const existing = await lookup(request, env);
		if (existing) {
			const limited = await requestRateLimit(env, existing.id);
			if (limited) return { response: limited };
			return { response: Response.json({ expires_at: existing.expires_at }, { headers: { "cache-control": "no-store" } }) };
		}
		if (request.method === "GET") return { response: error(cookieValue(request) ? "session_expired" : "session_required", 401) };
		const limited = await creationRateLimit(request, env);
		if (limited) return { response: limited };
		const id = toHex(crypto.getRandomValues(new Uint8Array(32)));
		const now = new Date();
		const expires = new Date(now.getTime() + LIFETIME_MS).toISOString();
		await env.DB.prepare("INSERT INTO guest_sessions (id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?2)")
			.bind(id, now.toISOString(), expires).run();
		const signature = await sign(id, env.GUEST_SESSION_SECRET);
		return { response: Response.json({ expires_at: expires }, { status: 201, headers: {
			"cache-control": "no-store",
			"set-cookie": `${COOKIE}=${id}.${signature}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
		} }) };
	}
	const session = await lookup(request, env);
	if (!session) return { response: error(cookieValue(request) ? "session_expired" : "session_required", 401) };
	const limited = await requestRateLimit(env, session.id);
	if (limited) return { response: limited };

	const project = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/|$)/);
	const run = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/|$)/);
	const evidence = url.pathname.match(/^\/api\/evidence\/([^/]+)$/);
	let owned: { id: string } | null = null;
	try {
		if (project) {
			owned = await env.DB.prepare("SELECT id FROM projects WHERE id = ?1 AND session_id = ?2")
				.bind(decodeURIComponent(project[1]), session.id).first<{ id: string }>();
		} else if (run) {
			owned = await env.DB.prepare("SELECT r.id FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?1 AND p.session_id = ?2")
				.bind(decodeURIComponent(run[1]), session.id).first<{ id: string }>();
		} else if (evidence) {
			owned = await env.DB.prepare(`SELECT e.id FROM research_evidence e WHERE e.id = ?1 AND (
				EXISTS (SELECT 1 FROM research_evidence_tasks t JOIN runs r ON r.id = t.run_id JOIN projects p ON p.id = r.project_id WHERE t.workspace_id = e.workspace_id AND t.evidence_id = e.id AND p.session_id = ?2)
				OR EXISTS (SELECT 1 FROM project_candidate_evidence ce JOIN project_candidates c ON c.id = ce.candidate_id AND c.workspace_id = ce.workspace_id JOIN projects p ON p.id = c.project_id WHERE ce.workspace_id = e.workspace_id AND ce.evidence_id = e.id AND p.session_id = ?2))`)
				.bind(decodeURIComponent(evidence[1]), session.id).first<{ id: string }>();
		} else if (url.pathname !== "/api/projects") {
			return { response: error("not_found", 404) };
		}
	} catch (err) {
		if (err instanceof URIError) return { response: error("not_found", 404) };
		throw err;
	}
	if ((project || run || evidence) && !owned) return { response: error("not_found", 404) };
	// Strict application-wide cost control is not implemented yet. Do not expose
	// model-consuming entrypoints (or newly added writes) to guest traffic.
	if (unsafe && !(url.pathname === "/api/projects" && request.method === "POST") &&
		!(project && request.method === "POST" && /\/(requirement-text|upload-sessions)$/.test(url.pathname))) {
		return { response: error("operation_unavailable", 503) };
	}
	return { sessionId: session.id };
}
