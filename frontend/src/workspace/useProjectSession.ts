import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
	COMPILE_STILL_WAITING,
	COMPILE_WAIT_TIMEOUT,
	hasDemandSource,
	interpretCompilation,
	isAbort,
	latestSource,
	listStatus,
	messageForApiError,
	validateUpload,
	type CompileView,
	type UiError,
} from "../api/adapter";
import type { ApiClient } from "../api/client";
import { ApiError, type Project, type Run } from "../api/types";
import {
	blankProject,
	loadDraft,
	loadStore,
	patchProject,
	saveDraft,
	saveStore,
	upsertProject,
	type LocalProject,
	type WorkspaceStore,
} from "../storage";
import { COMPILE_TIMEOUT_MS, COMPILE_UNCERTAIN_AFTER_MS, POLL_INTERVAL_MS, pollUntil } from "./poll";
import type { HistoryNote } from "./types";
import type { RunPort } from "./useRunWatch";

export type ProjectSession = {
	store: WorkspaceStore;
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
};

function entryOf(store: WorkspaceStore, projectId: string): LocalProject | null {
	return store.projects.find((item) => item.projectId === projectId) ?? null;
}

export function useProjectSession(clientRef: MutableRefObject<ApiClient>, runs: RunPort): ProjectSession {
	const [store, setStore] = useState<WorkspaceStore>(() => loadStore());
	const [project, setProject] = useState<Project | null>(null);
	const [text, setText] = useState("");
	const [activity, setActivity] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<UiError | null>(null);
	const [compileView, setCompileView] = useState<CompileView | null>(null);
	const [historyNote, setHistoryNote] = useState<HistoryNote | null>(null);
	const storeRef = useRef(store);
	const textRef = useRef(text);
	const abortRef = useRef<AbortController | null>(null);
	const runsRef = useRef(runs);
	storeRef.current = store;
	textRef.current = text;
	runsRef.current = runs;

	useEffect(() => {
		saveStore(store);
	}, [store]);

	function commit(next: WorkspaceStore): void {
		storeRef.current = next;
		setStore(next);
	}

	function updateEntry(projectId: string, patch: Partial<LocalProject>): void {
		commit(patchProject(storeRef.current, projectId, patch));
	}

	function replaceAbort(): AbortSignal {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		return controller.signal;
	}

	function noteRun(next: Run): void {
		updateEntry(next.project_id, { lastStatusLabel: listStatus(next.status, null), runId: next.id, unknownRun: false });
	}

	async function refreshProject(projectId: string, signal?: AbortSignal): Promise<Project> {
		const loaded = await clientRef.current.getProject(projectId, { signal });
		setProject(loaded);
		updateEntry(projectId, { title: loaded.title });
		return loaded;
	}

	useEffect(() => {
		const projectId = store.activeProjectId;
		runsRef.current.reset();
		if (!projectId) {
			setProject(null);
			setCompileView(null);
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
				setText(loadDraft(projectId));
				const entry = entryOf(storeRef.current, projectId);
				if (entry && entry.title !== loaded.title) updateEntry(projectId, { title: loaded.title });
				if (entry && entry.compiledAnalysisVersion != null && entry.demandRevisionAtCompile === loaded.demand_revision) {
					const requirements = await clientRef.current.getRequirements(projectId, { signal });
					if (!signal.aborted) {
						setCompileView(requirements.state === "ready" ? interpretCompilation(requirements.body, entry.compiledAnalysisVersion) : null);
					}
				} else if (!signal.aborted) {
					setCompileView(null);
				}
				if (signal.aborted) return;
				const runId = entryOf(storeRef.current, projectId)?.runId;
				if (runId) {
					setActivity(null);
					await runsRef.current.watch(runId, signal, noteRun);
					return;
				}
			} catch (caught) {
				if (!isAbort(caught)) setError(messageForApiError(caught));
			}
		})();
		return () => abortRef.current?.abort();
		// Reload only when the selected project changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [store.activeProjectId]);

	const onCreate = async (title: string) => {
		if (busy) return false;
		setBusy(true);
		setError(null);
		try {
			const created = await clientRef.current.createProject(title);
			commit(upsertProject(storeRef.current, blankProject(created.project_id, title.trim() || "未命名寻源项目", false)));
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
			const loaded = await clientRef.current.getProject(id);
			const existing = entryOf(storeRef.current, loaded.id);
			const entry = existing ? { ...existing, title: loaded.title } : blankProject(loaded.id, loaded.title, true);
			commit(upsertProject(storeRef.current, entry));
			return true;
		} catch (caught) {
			setError(messageForApiError(caught));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const onSelect = (projectId: string) => {
		if (projectId === storeRef.current.activeProjectId) return;
		commit({ ...storeRef.current, activeProjectId: projectId });
	};

	const onText = (value: string) => {
		setText(value);
		const projectId = storeRef.current.activeProjectId;
		if (projectId) saveDraft(projectId, value);
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
			const loaded = await refreshProject(project.id);
			if (purpose === "REQUIREMENT") {
				updateEntry(loaded.id, { demandRevisionAtCompile: null, compiledAnalysisVersion: null });
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
			updateEntry(projectId, { historySynthetic: imported.is_synthetic });
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
		if (currentRun && currentRun.project_id === project.id && (currentRun.status === "QUEUED" || currentRun.status === "RUNNING")) return;
		const signal = replaceAbort();
		setBusy(true);
		setError(null);
		let startedRunId: string | null = null;
		try {
			let current = project;
			const draft = textRef.current.trim();
			const entry = entryOf(storeRef.current, current.id);
			if (draft && draft !== entry?.submittedText) {
				await clientRef.current.addRequirementText(current.id, draft, { signal });
				current = await refreshProject(current.id, signal);
				updateEntry(current.id, {
					submittedText: draft,
					demandRevisionAtCompile: null,
					compiledAnalysisVersion: null,
				});
			}
			if (!hasDemandSource(current.sources, "")) {
				setError({ summary: "请填写需求或上传 PPTX。" });
				return;
			}
			const stamped = entryOf(storeRef.current, current.id);
			if (stamped?.demandRevisionAtCompile !== current.demand_revision) {
				setActivity("正在整理需求");
				updateEntry(current.id, { lastStatusLabel: "整理需求" });
				const queued = await clientRef.current.compile(current.id, { signal });
				const compileStarted = Date.now();
				let outcome: CompileView;
				try {
					outcome = await pollUntil<CompileView>({
						intervalMs: POLL_INTERVAL_MS,
						timeoutMs: COMPILE_TIMEOUT_MS,
						signal,
						tick: async () => {
							if (Date.now() - compileStarted >= COMPILE_UNCERTAIN_AFTER_MS) setActivity(COMPILE_STILL_WAITING);
							const requirements = await clientRef.current.getRequirements(current.id, { signal });
							if (requirements.state === "missing") return null;
							const view = interpretCompilation(requirements.body, queued.analysis_version);
							return view.phase === "pending" ? null : view;
						},
					});
				} catch (caught) {
					if (caught instanceof ApiError && caught.code === "timeout") {
						setError({ summary: COMPILE_WAIT_TIMEOUT });
						return;
					}
					throw caught;
				}
				if (outcome.phase === "failed") {
					setCompileView(outcome);
					updateEntry(current.id, { lastStatusLabel: "未能完成" });
					setError({
						summary: "需求整理失败。",
						technical: outcome.issues.join("\n") || undefined,
					});
					return;
				}
				setCompileView(outcome);
				updateEntry(current.id, {
					demandRevisionAtCompile: current.demand_revision,
					compiledAnalysisVersion: queued.analysis_version,
					lastStatusLabel: "待寻源",
				});
			}
			setActivity("正在启动寻源");
			const pending = entryOf(storeRef.current, current.id);
			const key = pending?.pendingRunKey || crypto.randomUUID();
			updateEntry(current.id, { pendingRunKey: key });
			try {
				const started = await clientRef.current.startRun(current.id, key, { signal });
				startedRunId = started.run_id;
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
				updateEntry(current.id, {
					runId: started.run_id,
					pendingRunKey: null,
					unknownRun: false,
					lastStatusLabel: "进行中",
				});
			} catch (caught) {
				if (caught instanceof ApiError && (caught.code === "network" || caught.code === "timeout")) {
					throw caught;
				}
				updateEntry(current.id, { pendingRunKey: null });
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

	return {
		store,
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
	};
}
