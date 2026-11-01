const STORE_KEY = "psi.workspace.v1";
const DRAFT_PREFIX = "psi.draft.v1.";

export type LocalProject = {
	projectId: string;
	title: string;
	runId: string | null;
	pendingRunKey: string | null;
	demandRevisionAtCompile: number | null;
	compiledAnalysisVersion: number | null;
	historySynthetic: boolean | null;
	submittedText: string | null;
	lastStatusLabel: string;
	unknownRun: boolean;
	openedAt: string;
};

export type WorkspaceStore = {
	activeProjectId: string | null;
	projects: LocalProject[];
};

export const EMPTY_STORE: WorkspaceStore = { activeProjectId: null, projects: [] };

function isLocalProject(value: unknown): value is LocalProject {
	if (!value || typeof value !== "object") return false;
	const row = value as Partial<LocalProject>;
	return typeof row.projectId === "string" && typeof row.title === "string" && typeof row.lastStatusLabel === "string";
}

function normalize(value: LocalProject): LocalProject {
	return {
		projectId: value.projectId,
		title: value.title,
		runId: typeof value.runId === "string" ? value.runId : null,
		pendingRunKey: typeof value.pendingRunKey === "string" ? value.pendingRunKey : null,
		demandRevisionAtCompile: typeof value.demandRevisionAtCompile === "number" ? value.demandRevisionAtCompile : null,
		compiledAnalysisVersion: typeof value.compiledAnalysisVersion === "number" ? value.compiledAnalysisVersion : null,
		historySynthetic: typeof value.historySynthetic === "boolean" ? value.historySynthetic : null,
		submittedText: typeof value.submittedText === "string" ? value.submittedText : null,
		lastStatusLabel: value.lastStatusLabel || "未开始",
		unknownRun: Boolean(value.unknownRun),
		openedAt: typeof value.openedAt === "string" ? value.openedAt : new Date().toISOString(),
	};
}

export function loadStore(): WorkspaceStore {
	try {
		const raw = localStorage.getItem(STORE_KEY);
		if (!raw) return EMPTY_STORE;
		const parsed = JSON.parse(raw) as { activeProjectId?: unknown; projects?: unknown };
		if (!parsed || !Array.isArray(parsed.projects)) return EMPTY_STORE;
		return {
			activeProjectId: typeof parsed.activeProjectId === "string" ? parsed.activeProjectId : null,
			projects: parsed.projects.filter(isLocalProject).map(normalize).slice(0, 30),
		};
	} catch {
		return EMPTY_STORE;
	}
}

export function saveStore(store: WorkspaceStore): void {
	localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

export function upsertProject(store: WorkspaceStore, project: LocalProject): WorkspaceStore {
	const rest = store.projects.filter((item) => item.projectId !== project.projectId);
	return { activeProjectId: project.projectId, projects: [normalize(project), ...rest].slice(0, 30) };
}

export function patchProject(store: WorkspaceStore, projectId: string, patch: Partial<LocalProject>): WorkspaceStore {
	return {
		...store,
		projects: store.projects.map((item) => (item.projectId === projectId ? normalize({ ...item, ...patch, projectId: item.projectId }) : item)),
	};
}

export function blankProject(projectId: string, title: string, unknownRun: boolean): LocalProject {
	return {
		projectId,
		title: title || "未命名寻源项目",
		runId: null,
		pendingRunKey: null,
		demandRevisionAtCompile: null,
		compiledAnalysisVersion: null,
		historySynthetic: null,
		submittedText: null,
		lastStatusLabel: "未开始",
		unknownRun,
		openedAt: new Date().toISOString(),
	};
}

export function loadDraft(projectId: string): string {
	try {
		return sessionStorage.getItem(`${DRAFT_PREFIX}${projectId}`) ?? "";
	} catch {
		return "";
	}
}

export function saveDraft(projectId: string, text: string): void {
	try {
		const key = `${DRAFT_PREFIX}${projectId}`;
		if (!text) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, text);
	} catch {
		/* The draft is a convenience. Quota failures leave the field as typed. */
	}
}
