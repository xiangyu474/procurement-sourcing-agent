const KEYS = "psi.pipelineKey.v1";
const IDS = "psi.pipelineId.v1";

function readMap(storageKey: string): Record<string, string> {
	try {
		const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const map: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string" && value.length > 0) map[key] = value;
		}
		return map;
	} catch {
		return {};
	}
}

function writeMap(storageKey: string, map: Record<string, string>): void {
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(map));
	} catch {
		/* Losing the key only risks a second task after the tab storage is blocked. */
	}
}

export function pipelineKeySlot(projectId: string, revision: number): string {
	return `${projectId}:${revision}`;
}

export function newIdempotencyKey(): string {
	return crypto.randomUUID();
}

/** The key for one project revision, kept until the 202 so a retry reuses the task. */
export function readPipelineKey(projectId: string, revision: number): string | null {
	return readMap(KEYS)[pipelineKeySlot(projectId, revision)] ?? null;
}

export function writePipelineKey(projectId: string, revision: number, key: string | null): void {
	const map = readMap(KEYS);
	const slot = pipelineKeySlot(projectId, revision);
	if (key) map[slot] = key;
	else delete map[slot];
	writeMap(KEYS, map);
}

/** Last pipeline id for a project. UI state only: B1 has no list of active pipelines. */
export function readPipelineId(projectId: string): string | null {
	return readMap(IDS)[projectId] ?? null;
}

export function writePipelineId(projectId: string, pipelineId: string | null): void {
	const map = readMap(IDS);
	if (pipelineId) map[projectId] = pipelineId;
	else delete map[projectId];
	writeMap(IDS, map);
}
