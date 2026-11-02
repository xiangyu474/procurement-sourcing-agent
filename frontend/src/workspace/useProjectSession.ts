import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
	COMPILE_WAIT_TIMEOUT,
	NO_RECOGNIZABLE_DEMAND,
	hasDemandSource,
	interpretCompilation,
	isAbort,
	isTerminalRun,
	latestSource,
	messageForApiError,
	validateUpload,
	type CompileView,
	type UiError,
} from "../api/adapter";
import type { ApiClient } from "../api/client";
import { ApiError, type CompileJob, type Project, type ProjectRunSummary, type ProjectSummary, type Run } from "../api/types";
import { loadDraft, saveDraft } from "../storage";
import { COMPILE_TIMEOUT_MS, POLL_INTERVAL_MS, pollUntil } from "./poll";
import type { HistoryNote } from "./types";
import type { RunPort } from "./useRunWatch";

const ACTIVE_KEY = "psi.activeProjectId";
const PENDING_KEY = "psi.pendingRuns.v1";

export type ProjectSession = {
	projects: ProjectSummary[];
	activeProjectId: string | null;
	project: Project | null;
	text: string;
	activity: string | null;
	busy: boolean;
	error: UiError | null;
	compileView: CompileView | null;
	historyNote: HistoryNote | null;
	onCreate: (title: string) => Promise<boolean>;
	onOpen: (projectId: string) => Promise<boolean>;
	onSelect: (projectId: string) => void;
	onText: (value: string) => void;
	onUpload: (purpose: "REQUIREMENT" | "HISTORY", file: File) => Promise<void>;
	onImportHistory: () => Promise<void>;
	onStart: () => Promise<void>;
	runHistory: ProjectRunSummary[];
	selectRun: (runId: string) => void;
};

function readPending(projectId: string): string | null {
	try {
		const parsed = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}") as Record<string, unknown>;
		const value = parsed[projectId];
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function writePending(projectId: string, key: string | null): void {
	try {
		const parsed = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}") as Record<string, unknown>;
		if (key) parsed[projectId] = key;
		else delete parsed[projectId];
		sessionStorage.setItem(PENDING_KEY, JSON.stringify(parsed));
	} catch {
		/* A lost idempotency key only risks a second run after a failed refresh. */
	}
}

function stampKey(projectId: string): string {
	return `psi.compileDemand.${projectId}`;
}

function readStamp(projectId: string): number | null {
	const value = Number(sessionStorage.getItem(stampKey(projectId)));
	return Number.isInteger(value) ? value : null;
}

function writeStamp(projectId: string, revision: number): void {
	sessionStorage.setItem(stampKey(projectId), String(revision));
}

export function useProjectSession(clientRef: MutableRefObject<ApiClient>, runs: RunPort): ProjectSession {
	const [projects, setProjects] = useState<ProjectSummary[]>([]);
	const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
	const [project, setProject] = useState<Project | null>(null);
	const [text, setText] = useState("");
	const [activity, setActivity] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<UiError | null>(null);
	const [compileView, setCompileView] = useState<CompileView | null>(null);
	const [historyNote, setHistoryNote] = useState<HistoryNote | null>(null);
	const [runHistory, setRunHistory] = useState<ProjectRunSummary[]>([]);
	const runHistoryRef = useRef<ProjectRunSummary[]>([]);
	const activeRef = useRef(activeProjectId);
	const textRef = useRef(text);
	const serverTextRef = useRef("");
	const listAbortRef = useRef<AbortController | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const runsRef = useRef(runs);
	activeRef.current = activeProjectId;
	textRef.current = text;
	runsRef.current = runs;

	function replaceAbort(): AbortSignal {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		return controller.signal;
	}

	function remember(projectId: string | null): void {
		activeRef.current = projectId;
		setActiveProjectId(projectId);
		if (projectId) sessionStorage.setItem(ACTIVE_KEY, projectId);
		else sessionStorage.removeItem(ACTIVE_KEY);
	}

	function noteRun(next: Run): void {
		setProjects((current) =>
			current.map((item) =>
				item.id === next.project_id
					? {
							...item,
							latest_run: {
								id: next.id,
								status: next.status,
								current_stage: next.current_stage,
								updated_at: next.updated_at,
							},
						}
					: item,
			),
		);
	}

	async function refreshList(signal?: AbortSignal): Promise<ProjectSummary[]> {
		const listed = await clientRef.current.listProjects({ signal });
		setProjects(listed);
		return listed;
	}

	async function refreshProject(projectId: string, signal?: AbortSignal): Promise<Project> {
		const loaded = await clientRef.current.getProject(projectId, { signal });
		setProject(loaded);
		setProjects((current) => current.map((item) => (item.id === loaded.id ? { ...item, title: loaded.title, history_availability: loaded.history_availability, demand_revision: loaded.demand_revision, analysis_version: loaded.analysis_version } : item)));
		return loaded;
	}

	useEffect(() => {
		const controller = new AbortController();
		listAbortRef.current = controller;
		void (async () => {
			try {
				const listed = await refreshList(controller.signal);
				if (controller.signal.aborted) return;
				const saved = sessionStorage.getItem(ACTIVE_KEY);
				if (saved && listed.some((item) => item.id === saved)) remember(saved);
			} catch (caught) {
				if (!isAbort(caught)) setError(messageForApiError(caught));
			}
		})();
		return () => controller.abort();
		// The catalogue is loaded once. Selecting a project has its own effect.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const projectId = activeProjectId;
		runsRef.current.reset();
		if (!projectId) {
			setProject(null);
			setCompileView(null);
			setText("");
			runHistoryRef.current = [];
			setRunHistory([]);
			return;
		}
		const signal = replaceAbort();
		void (async () => {
			try {
				setError(null);
				setHistoryNote(null);
				const loaded = await clientRef.current.getProject(projectId, { signal });
				if (signal.aborted) return;
				setProject(loaded);
				const savedDraft = loadDraft(projectId);
				const requirement = await clientRef.current.getRequirementText(projectId, { signal });
				if (signal.aborted) return;
				const serverText = requirement?.text ?? "";
				serverTextRef.current = serverText;
				setText(savedDraft || serverText);
				const requirements = await clientRef.current.getRequirements(projectId, { signal });
				if (!signal.aborted && requirements.state === "ready" && requirements.body.analysis_version === loaded.analysis_version) {
					const view = interpretCompilation(requirements.body, requirements.body.analysis_version);
					setCompileView(view);
					if (view.phase === "ready" && view.requirementCount > 0) writeStamp(projectId, loaded.demand_revision);
					else sessionStorage.removeItem(stampKey(projectId));
				} else if (!signal.aborted) {
					setCompileView(null);
				}
				if (signal.aborted) return;
				const listed = await clientRef.current.listRuns(projectId, { signal });
				runHistoryRef.current = listed;
				setRunHistory(listed);
				const latest = listed[0];
				if (!latest) return;
				setActivity(null);
				await runsRef.current.watch(latest.id, signal, noteRun, listed);
			} catch (caught) {
				if (!isAbort(caught)) setError(messageForApiError(caught));
			}
		})();
		return () => abortRef.current?.abort();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeProjectId]);

	const onCreate = async (title: string) => {
		if (busy) return false;
		setBusy(true);
		setError(null);
		try {
			const created = await clientRef.current.createProject(title);
			await refreshList();
			remember(created.project_id);
			return true;
		} catch (caught) {
			setError(messageForApiError(caught));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const onOpen = async (projectId: string) => {
		const id = projectId.trim();
		if (!id || busy) return false;
		setBusy(true);
		setError(null);
		try {
			await clientRef.current.getProject(id);
			const listed = await refreshList();
			if (!listed.some((item) => item.id === id)) {
				const loaded = await clientRef.current.getProject(id);
				setProjects((current) => [
					{
						id: loaded.id,
						title: loaded.title,
						history_availability: loaded.history_availability,
						demand_revision: loaded.demand_revision,
						analysis_version: loaded.analysis_version,
						created_at: loaded.created_at,
						latest_run: null,
					},
					...current,
				]);
			}
			remember(id);
			return true;
		} catch (caught) {
			setError(messageForApiError(caught));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const onSelect = (projectId: string) => {
		if (projectId === activeRef.current) return;
		remember(projectId);
	};

	const onText = (value: string) => {
		setText(value);
		if (activeRef.current) saveDraft(activeRef.current, value);
	};

	const onUpload = async (purpose: "REQUIREMENT" | "HISTORY", file: File) => {
		if (!project || busy) return;
		const invalid = validateUpload(purpose, file);
		if (invalid) {
			setError({ summary: invalid });
			return;
		}
		setBusy(true);
		setError(null);
		setActivity("正在上传");
		try {
			await clientRef.current.upload(project.id, purpose, file);
			await refreshProject(project.id);
			if (purpose === "REQUIREMENT") {
				sessionStorage.removeItem(stampKey(project.id));
				setCompileView(null);
			}
		} catch (caught) {
			if (!isAbort(caught)) setError(messageForApiError(caught));
		} finally {
			setActivity(null);
			setBusy(false);
		}
	};

	const onImportHistory = async () => {
		if (!project || busy) return;
		const source = latestSource(project.sources, (item) => item.purpose === "HISTORY");
		if (!source) {
			setError({ summary: "请先上传 XLSX。" });
			return;
		}
		const projectId = project.id;
		setBusy(true);
		setError(null);
		setActivity("正在导入历史数据");
		let failed = false;
		try {
			const imported = await clientRef.current.importHistory(projectId, source.id);
			setHistoryNote({ synthetic: imported.is_synthetic, rowCount: imported.row_count });
		} catch (caught) {
			failed = true;
			setHistoryNote(null);
			if (!isAbort(caught)) setError(messageForApiError(caught));
		} finally {
			try {
				await refreshProject(projectId);
			} catch (caught) {
				if (!failed && !isAbort(caught)) setError(messageForApiError(caught));
			}
			setActivity(null);
			setBusy(false);
		}
	};

	const onStart = async () => {
		if (!project || busy) return;
		const currentRun = runsRef.current.runRef.current;
		if (currentRun && currentRun.project_id === project.id && !isTerminalRun(currentRun.status)) return;
		const signal = replaceAbort();
		setBusy(true);
		setError(null);
		let startedRunId: string | null = null;
		try {
			let current = project;
			const draft = textRef.current.trim();
			if (draft && draft !== serverTextRef.current) {
				await clientRef.current.addRequirementText(current.id, draft, { signal });
				current = await refreshProject(current.id, signal);
				serverTextRef.current = draft;
				sessionStorage.removeItem(stampKey(current.id));
			}
			if (!hasDemandSource(current.sources, "")) {
				setError({ summary: "请填写需求或上传 PPTX。" });
				return;
			}
			if (readStamp(current.id) !== current.demand_revision) {
				setActivity("正在整理需求");
				const queued = await clientRef.current.compile(current.id, { signal });
				let job: CompileJob;
				try {
					job = await pollUntil<CompileJob>({
						intervalMs: POLL_INTERVAL_MS,
						timeoutMs: COMPILE_TIMEOUT_MS,
						signal,
						tick: async () => {
							const currentJob = await clientRef.current.getCompileJob(current.id, queued.compile_id, { signal });
							if (currentJob.status === "QUEUED" || currentJob.status === "RUNNING") return null;
							return currentJob;
						},
					});
				} catch (caught) {
					if (caught instanceof ApiError && caught.code === "timeout") {
						setError({ summary: COMPILE_WAIT_TIMEOUT });
						return;
					}
					throw caught;
				}
				if (job.status === "FAILED") {
					setError({ summary: job.error?.trim() || "需求整理失败。" });
					return;
				}
				const requirements = await clientRef.current.getRequirements(current.id, { signal });
				if (requirements.state !== "ready") {
					setError({ summary: "需求整理没有读到结果。" });
					return;
				}
				const view = interpretCompilation(requirements.body, requirements.body.analysis_version);
				setCompileView(view);
				if (view.phase !== "ready" || view.requirementCount === 0) {
					sessionStorage.removeItem(stampKey(current.id));
					setError({ summary: view.phase === "failed" ? "需求整理失败。" : NO_RECOGNIZABLE_DEMAND });
					return;
				}
				writeStamp(current.id, current.demand_revision);
			}
			setActivity("正在启动寻源");
			const key = readPending(current.id) || crypto.randomUUID();
			writePending(current.id, key);
			try {
				const started = await clientRef.current.startRun(current.id, key, { signal });
				startedRunId = started.run_id;
				writePending(current.id, null);
				const placeholder: Run = {
					id: started.run_id,
					project_id: current.id,
					status: started.status || "QUEUED",
					current_stage: "QUEUED",
					artifact_key: null,
					last_error: null,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				};
				runsRef.current.adopt(placeholder);
				noteRun(placeholder);
				const summary: ProjectRunSummary = {
					id: placeholder.id,
					status: placeholder.status,
					current_stage: placeholder.current_stage,
					last_error: null,
					stop_reason_code: null,
					artifact_key_present: false,
					created_at: placeholder.created_at,
					updated_at: placeholder.updated_at,
				};
				const nextHistory = [summary, ...runHistoryRef.current.filter((item) => item.id !== summary.id)];
				runHistoryRef.current = nextHistory;
				setRunHistory(nextHistory);
			} catch (caught) {
				if (caught instanceof ApiError && (caught.code === "network" || caught.code === "timeout")) throw caught;
				writePending(current.id, null);
				throw caught;
			}
		} catch (caught) {
			if (!isAbort(caught)) setError(messageForApiError(caught));
		} finally {
			setActivity(null);
			setBusy(false);
		}
		if (!startedRunId || signal.aborted) return;
		try {
			await runsRef.current.watch(startedRunId, signal, noteRun);
		} catch (caught) {
			if (!isAbort(caught)) setError(messageForApiError(caught));
		}
	};

	const selectRun = (runId: string) => {
		const projectId = activeRef.current;
		if (!projectId || runsRef.current.runRef.current?.id === runId) return;
		const signal = replaceAbort();
		void runsRef.current.watch(runId, signal, noteRun, runHistoryRef.current).catch((caught) => {
			if (!isAbort(caught)) setError(messageForApiError(caught));
		});
	};

	return {
		projects,
		activeProjectId,
		project,
		text,
		activity,
		busy,
		error,
		compileView,
		historyNote,
		onCreate,
		onOpen,
		onSelect,
		onText,
		onUpload,
		onImportHistory,
		onStart,
		runHistory,
		selectRun,
	};
}
