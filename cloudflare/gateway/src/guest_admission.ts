// Local B3 admission primitive. It is intentionally not wired to public tasks:
// reserved units are not a real provider-call or monetary cap until every
// billable call is independently enforced. Guest work must remain disabled.
export interface GuestAdmissionPolicy {
	globalConcurrent: number;
	sessionConcurrent: number;
	globalDailyUnits: number;
	sessionDailyUnits: number;
	sessionDailyStarts: number;
}
export interface GuestTaskRequest {
	sessionId: string;
	projectId: string;
	operationId: string;
	kind: "COMPILE" | "PIPELINE" | "REPORT";
	requestHash: string;
	units: number;
}
export type GuestAdmissionResult = { kind: "CREATED" | "REUSED" | "CONFLICT" | "DENIED" };
interface AdmissionRow { session_id: string; project_id: string; operation_kind: string; request_hash: string; reserved_units: number }

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= 100_000;
}

/**
 * A single conditional INSERT checks all counters in the same SQLite write.
 * Daily units are never refunded, including on failure or released concurrency.
 */
export async function reserveGuestTask(
	db: D1Database, request: GuestTaskRequest, policy: GuestAdmissionPolicy,
): Promise<GuestAdmissionResult> {
	if (![policy.globalConcurrent, policy.sessionConcurrent, policy.globalDailyUnits, policy.sessionDailyUnits, policy.sessionDailyStarts, request.units].every(positiveInteger) ||
		!request.sessionId || !request.projectId || !/^[\x21-\x7e]{1,160}$/.test(request.operationId) ||
		!/^[\x21-\x7e]{1,128}$/.test(request.requestHash) || !["COMPILE", "PIPELINE", "REPORT"].includes(request.kind)) {
		throw new Error("invalid_guest_admission");
	}
	const now = new Date();
	const day = Math.floor(now.getTime() / 86_400_000);
	const instant = now.toISOString();
	const inserted = await db.prepare(`INSERT INTO guest_task_admissions
		(operation_id, session_id, project_id, operation_kind, request_hash, day_window, reserved_units, state, created_at)
		SELECT ?1, s.id, p.id, ?4, ?5, ?6, ?7, 'HELD', ?8
		FROM projects p JOIN guest_sessions s ON s.id = p.session_id
		WHERE p.id = ?3 AND s.id = ?2 AND s.expires_at > ?8
		AND (SELECT count(*) FROM guest_task_admissions WHERE state = 'HELD') < ?9
		AND (SELECT count(*) FROM guest_task_admissions WHERE state = 'HELD' AND session_id = ?2) < ?10
		AND COALESCE((SELECT sum(reserved_units) FROM guest_task_admissions WHERE day_window = ?6), 0) + ?7 <= ?11
		AND COALESCE((SELECT sum(reserved_units) FROM guest_task_admissions WHERE day_window = ?6 AND session_id = ?2), 0) + ?7 <= ?12
		AND (SELECT count(*) FROM guest_task_admissions WHERE day_window = ?6 AND session_id = ?2) < ?13
		ON CONFLICT DO NOTHING RETURNING operation_id`)
		.bind(request.operationId, request.sessionId, request.projectId, request.kind, request.requestHash, day, request.units, instant,
			policy.globalConcurrent, policy.sessionConcurrent, policy.globalDailyUnits, policy.sessionDailyUnits, policy.sessionDailyStarts)
		.first<{ operation_id: string }>();
	if (inserted) return { kind: "CREATED" };
	// Reuse a reservation even when limits are now full, but only for the same
	// still-valid session, owner and exact operation; never expose another owner.
	const existing = await db.prepare(`SELECT a.session_id, a.project_id, a.operation_kind, a.request_hash, a.reserved_units
		FROM guest_task_admissions a JOIN projects p ON p.id = a.project_id
		JOIN guest_sessions s ON s.id = p.session_id
		WHERE a.operation_id = ?1 AND a.session_id = ?2 AND a.project_id = ?3 AND s.id = ?2 AND s.expires_at > ?4`)
		.bind(request.operationId, request.sessionId, request.projectId, instant).first<AdmissionRow>();
	if (!existing) return { kind: "DENIED" };
	if (existing.operation_kind !== request.kind || existing.request_hash !== request.requestHash || existing.reserved_units !== request.units) {
		return { kind: "CONFLICT" };
	}
	return { kind: "REUSED" };
}

/**
 * Free the concurrency slot of a task that reached a terminal state. The
 * reserved units stay consumed: the model and search calls of a failed task
 * were still paid for. Do not expose this as a client endpoint.
 */
export async function releaseGuestAdmission(db: D1Database, operationId: string, kind: "COMPILE" | "PIPELINE" | "REPORT"): Promise<boolean> {
	const terminal = kind === "COMPILE"
		? `EXISTS (SELECT 1 FROM project_jobs j WHERE j.id = ?1 AND j.status IN ('COMPLETED','FAILED'))`
		: kind === "REPORT"
			? `EXISTS (SELECT 1 FROM project_reports r WHERE r.id = ?1 AND r.status IN ('COMPLETED','FAILED'))`
			: `EXISTS (SELECT 1 FROM project_pipelines p WHERE p.id = ?1 AND p.status IN ('COMPLETED','PARTIAL','FAILED'))`;
	// A report admission is held per attempt: "<report id>#<attempt>".
	const match = kind === "REPORT"
		? "operation_id LIKE ?1 || '#%' AND operation_kind = ?3"
		: "operation_id = ?1 AND operation_kind = ?3";
	const result = await db.prepare(`UPDATE guest_task_admissions SET state = 'RELEASED', released_at = ?2
		WHERE ${match} AND state = 'HELD' AND ${terminal}`)
		.bind(operationId, new Date().toISOString(), kind).run();
	return result.meta.changes === 1;
}

/** Read the policy a visitor is subject to, refusing to guess a default. */
export function guestAdmissionPolicy(env: {
	GUEST_TASK_GLOBAL_CONCURRENT?: string; GUEST_TASK_SESSION_CONCURRENT?: string;
	GUEST_TASK_GLOBAL_DAILY_UNITS?: string; GUEST_TASK_SESSION_DAILY_UNITS?: string;
	GUEST_TASK_SESSION_DAILY_STARTS?: string;
}): GuestAdmissionPolicy | null {
	const values = [env.GUEST_TASK_GLOBAL_CONCURRENT, env.GUEST_TASK_SESSION_CONCURRENT,
		env.GUEST_TASK_GLOBAL_DAILY_UNITS, env.GUEST_TASK_SESSION_DAILY_UNITS, env.GUEST_TASK_SESSION_DAILY_STARTS];
	if (values.some(value => !value || !/^[1-9]\d{0,5}$/.test(value))) return null;
	const [globalConcurrent, sessionConcurrent, globalDailyUnits, sessionDailyUnits, sessionDailyStarts] = values.map(Number);
	return { globalConcurrent: globalConcurrent!, sessionConcurrent: sessionConcurrent!, globalDailyUnits: globalDailyUnits!, sessionDailyUnits: sessionDailyUnits!, sessionDailyStarts: sessionDailyStarts! };
}
