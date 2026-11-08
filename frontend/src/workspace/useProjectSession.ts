import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
	COMPILE_WAIT_TIMEOUT,
	NO_RECOGNIZABLE_DEMAND,
	compileErrorMessage,
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
import { ApiError, type CompileJob, type Pipeline, type PipelineListItem, type PipelineStage, type Project, type ProjectRunSummary, type ProjectSummary, type Run, type StartedPipeline } from "../api/types";
import { pipelineProblemLine, pipelineProgressLine } from "../view/pipeline";
import { loadDraft, saveDraft } from "../storage";
import { newIdempotencyKey, readPipelineId, readPipelineKey, writePipelineId, writePipelineKey } from "./pipelineState";
import { COMPILE_TIMEOUT_MS, POLL_INTERVAL_MS, pollUntil, sleep } from "./poll";
import type { HistoryNote } from "./types";
import type { RunPort } from "./useRunWatch";

const ACTIVE_KEY = "psi.activeProjectId";
const DEMAND_CHANGED = "需求刚更新过，请确认后再开始。";
const ANALYSIS_NOT_STARTED = "分析没能启动。";
/** The report starts right after the decision snapshot. It is not waited for forever. */
const REPORT_START_POLLS = 20;

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
	onSample: () => Promise<void>;
	sampleBusy: boolean;
	runHistory: ProjectRunSummary[];
	selectRun: (runId: string) => void;
	pipelineLine: string | null;
	pipelineNote: string | null;
	pipelineActive: boolean;
	pipelineStatus: string | null;
	/** When the open project's latest known compile job failed. Null after a newer pipeline starts. */
	compileFailedAt: string | null;
	/** Run that the current pipeline status describes. A different run keeps its own heading. */
	pipelineRunId: string | null;
	pipelineStages: PipelineStage[];
	reportStatus: string | null;
	startOffer: "retry" | null;
};

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

export function useProjectSession(clientRef: MutableRefObject<ApiClient>, runs: RunPort, ready: boolean): ProjectSession {
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
	const [pipelineLine, setPipelineLine] = useState<string | null>(null);
	const [pipelineNote, setPipelineNote] = useState<string | null>(null);
	const [pipelineActive, setPipelineActive] = useState(false);
	const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);
	const [failedCompiles, setFailedCompiles] = useState<Record<string, string>>({});
	const [pipelineRunId, setPipelineRunId] = useState<string | null>(null);
	const [pipelineStages, setPipelineStages] = useState<PipelineStage[]>([]);
	const pipelineStatusRef = useRef<string | null>(null);
	const sampleBusyRef = useRef(false);
	const pinnedPipelineRef = useRef<{ projectId: string; pipelineId: string } | null>(null);
	const [reportStatus, setReportStatus] = useState<string | null>(null);
	const [startOffer, setStartOffer] = useState<"retry" | null>(null);
	const [sampleBusy, setSampleBusy] = useState(false);
	const runHistoryRef = useRef<ProjectRunSummary[]>([]);
	const pipelineActiveRef = useRef(false);
	const followedRunRef = useRef<string | null>(null);
	const activeRef = useRef(activeProjectId);
	const textRef = useRef(text);
	const serverTextRef = useRef("");
	const listAbortRef = useRef<AbortController | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const runsRef = useRef(runs);
	activeRef.current = activeProjectId;
	textRef.current = text;
	runsRef.current = runs;
	pipelineStatusRef.current = pipelineStatus;

	function replaceAbort(): AbortSignal {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		return controller.signal;
	}

	function markPipelineActive(active: boolean): void {
		pipelineActiveRef.current = active;
		setPipelineActive(active);
	}

	function rememberRun(next: Run): void {
		noteRun(next);
		const summary: ProjectRunSummary = {
			id: next.id,
			status: next.status,
			current_stage: next.current_stage,
			last_error: next.last_error,
			stop_reason_code: null,
			artifact_key_present: Boolean(next.artifact_key),
			created_at: next.created_at,
			updated_at: next.updated_at,
		};
		const nextHistory = [summary, ...runHistoryRef.current.filter((item) => item.id !== summary.id)];
		runHistoryRef.current = nextHistory;
		setRunHistory(nextHistory);
	}

	function showPipeline(snapshot: Pipeline): void {
		setPipelineStatus(snapshot.status);
		setPipelineRunId(snapshot.run_id);
		setPipelineStages(snapshot.stages);
		setPipelineLine(pipelineProgressLine(snapshot.status, snapshot.stage, snapshot.report_status, snapshot.stages));
		setPipelineNote(pipelineProblemLine(snapshot.status, snapshot.error, snapshot.stages));
		setReportStatus(snapshot.report_status);
	}

	/** The runs row can appear after the pipeline id. A 404 means the row is not there yet. */
	async function ensureRun(runId: string, signal: AbortSignal): Promise<"ready" | "missing" | "unavailable"> {
		if (followedRunRef.current === runId) return "ready";
		try {
			const loaded = await clientRef.current.getRun(runId, { signal });
			if (signal.aborted) return "unavailable";
			rememberRun(loaded);
			followedRunRef.current = runId;
			void runsRef.current.watch(runId, signal, noteRun).catch((caught) => {
				if (!isAbort(caught) && !signal.aborted) setError(messageForApiError(caught));
			});
			return "ready";
		} catch (caught) {
			if (isAbort(caught) || signal.aborted) return "unavailable";
			if (caught instanceof ApiError && caught.status === 404) return "missing";
			setError(messageForApiError(caught));
			return "unavailable";
		}
	}

	/** A finished sample has a pipeline and a snapshot, and may have no runs row. */
	function runFromPipeline(snapshot: Pipeline): Run {
		const status = snapshot.status === "PARTIAL" || snapshot.status === "FAILED" ? snapshot.status : "COMPLETED";
		return {
			id: snapshot.run_id,
			project_id: snapshot.project_id,
			status,
			current_stage: snapshot.stage ?? status,
			artifact_key: null,
			last_error: null,
			created_at: snapshot.created_at,
			updated_at: snapshot.updated_at,
		};
	}

	/** Poll the saved pipeline. Returns false when the task is gone, so the caller can fall back. */
	async function followPipeline(projectId: string, pipelineId: string, signal: AbortSignal): Promise<boolean> {
		followedRunRef.current = null;
		let missedRun = 0;
		let reportWait = 0;
		let pollFailed = false;
		while (!signal.aborted) {
			let snapshot: Pipeline;
			try {
				snapshot = await clientRef.current.getPipeline(projectId, pipelineId, { signal });
			} catch (caught) {
				if (isAbort(caught) || signal.aborted) return true;
				if (caught instanceof ApiError && caught.status === 404) {
					writePipelineId(projectId, null);
					markPipelineActive(false);
					setPipelineStatus(null);
					setPipelineRunId(null);
					setPipelineStages([]);
					setPipelineLine(null);
					setPipelineNote(null);
					setReportStatus(null);
					return false;
				}
				// A read that failed once is not a broken task. The line stays and the
				// error is taken away when the next read succeeds.
				if (!pollFailed) {
					pollFailed = true;
					setError(messageForApiError(caught));
				}
				try {
					await sleep(POLL_INTERVAL_MS, signal);
				} catch (sleepError) {
					if (isAbort(sleepError) || signal.aborted) return true;
				}
				continue;
			}
			if (signal.aborted) return true;
			if (pollFailed) {
				pollFailed = false;
				setError(null);
			}
			showPipeline(snapshot);
			const terminal = snapshot.status === "COMPLETED" || snapshot.status === "PARTIAL" || snapshot.status === "FAILED";
			markPipelineActive(snapshot.status === "QUEUED" || snapshot.status === "RUNNING");
			const bound = snapshot.run_id ? await ensureRun(snapshot.run_id, signal) : "ready";
			if (signal.aborted) return true;
			if (terminal) {
				if (bound === "missing" && snapshot.run_id) {
					const adopted = runFromPipeline(snapshot);
					runsRef.current.adopt(adopted);
					rememberRun(adopted);
					followedRunRef.current = snapshot.run_id;
				} else if (snapshot.run_id && bound !== "ready") {
					missedRun += 1;
					if (missedRun >= 20) return true;
					try {
						await sleep(POLL_INTERVAL_MS, signal);
					} catch (caught) {
						if (isAbort(caught) || signal.aborted) return true;
					}
					continue;
				}
				// The report has its own status. A finished analysis is not a finished
				// report, so the task keeps being read until the report settles.
				const reportRunning = snapshot.report_status === "QUEUED" || snapshot.report_status === "RUNNING";
				const reportSettled = snapshot.report_status === "COMPLETED" || snapshot.report_status === "FAILED";
				if (snapshot.status === "FAILED") return true;
				if (reportRunning) {
					try {
						await sleep(POLL_INTERVAL_MS, signal);
					} catch (caught) {
						if (isAbort(caught) || signal.aborted) return true;
					}
					continue;
				}
				if (!reportSettled) {
					reportWait += 1;
					if (reportWait >= REPORT_START_POLLS) return true;
					try {
						await sleep(POLL_INTERVAL_MS, signal);
					} catch (caught) {
						if (isAbort(caught) || signal.aborted) return true;
					}
					continue;
				}
				return true;
			}
			try {
				await sleep(POLL_INTERVAL_MS, signal);
			} catch (caught) {
				if (isAbort(caught) || signal.aborted) return true;
			}
		}
		return true;
	}

	/**
	 * Find the task of this project again after a refresh. The backend lists the
	 * tasks, so the page does not depend on what the tab happened to remember.
	 */
	async function recoverPipeline(projectId: string, signal: AbortSignal): Promise<boolean> {
		let items: PipelineListItem[] = [];
		try {
			items = await clientRef.current.listProjectPipelines(projectId, { active: true, limit: 20 }, { signal });
		} catch (caught) {
			if (isAbort(caught) || signal.aborted) return true;
			return false;
		}
		if (items.length === 0) {
			try {
				// The most recent task of the project, running or not. Its state and
				// its reason are shown again after a refresh.
				const recent = await clientRef.current.listProjectPipelines(projectId, { limit: 20 }, { signal });
				items = recent;
			} catch (caught) {
				if (isAbort(caught) || signal.aborted) return true;
				items = [];
			}
		}
		const target = items[0];
		if (!target) return false;
		setPipelineStatus(target.status);
		setPipelineRunId(target.run_id);
		markPipelineActive(target.status === "QUEUED" || target.status === "RUNNING");
		const followed = await followPipeline(projectId, target.pipeline_id, signal);
		if (followed) writePipelineId(projectId, target.pipeline_id);
		return followed;
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
		if (!ready) return;
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
	}, [ready]);

	useEffect(() => {
		const projectId = activeProjectId;
		runsRef.current.reset();
		if (!projectId || !ready) {
			setProject(null);
			setCompileView(null);
			setText("");
			runHistoryRef.current = [];
			setRunHistory([]);
			markPipelineActive(false);
			setPipelineLine(null);
			setPipelineNote(null);
			setPipelineStatus(null);
			setPipelineRunId(null);
			setPipelineStages([]);
			setReportStatus(null);
			setStartOffer(null);
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
				const pinned = pinnedPipelineRef.current;
				if (pinned?.projectId === projectId) {
					pinnedPipelineRef.current = null;
					writePipelineId(projectId, pinned.pipelineId);
					const followed = await followPipeline(projectId, pinned.pipelineId, signal);
					if (signal.aborted || followed) return;
				}
				// A refresh must find the task again. The backend lists it; the tab
				// memory is only a fallback.
				const recovered = await recoverPipeline(projectId, signal);
				if (signal.aborted || recovered) return;
				const savedPipeline = readPipelineId(projectId);
				if (savedPipeline) {
					const followed = await followPipeline(projectId, savedPipeline, signal);
					if (signal.aborted || followed) return;
				}
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
	}, [activeProjectId, ready]);

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

	const onSample = async () => {
		if (busy || sampleBusyRef.current) return;
		sampleBusyRef.current = true;
		setSampleBusy(true);
		setError(null);
		try {
			const sample = await clientRef.current.copySample();
			const listed = await refreshList();
			if (!listed.some((item) => item.id === sample.project_id)) {
				const loaded = await clientRef.current.getProject(sample.project_id);
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
					...current.filter((item) => item.id !== loaded.id),
				]);
			}
			pinnedPipelineRef.current = { projectId: sample.project_id, pipelineId: sample.pipeline_id };
			writePipelineId(sample.project_id, sample.pipeline_id);
			remember(sample.project_id);
		} catch (caught) {
			if (!isAbort(caught)) setError(messageForApiError(caught));
		} finally {
			sampleBusyRef.current = false;
			setSampleBusy(false);
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

	async function postPipeline(projectId: string, revision: number, signal: AbortSignal): Promise<StartedPipeline> {
		let key = readPipelineKey(projectId, revision) ?? newIdempotencyKey();
		writePipelineKey(projectId, revision, key);
		try {
			return await clientRef.current.startPipeline(projectId, key, revision, { signal });
		} catch (caught) {
			if (!(caught instanceof ApiError) || caught.code !== "idempotency_conflict") throw caught;
			key = newIdempotencyKey();
			writePipelineKey(projectId, revision, key);
			try {
				return await clientRef.current.startPipeline(projectId, key, revision, { signal });
			} catch (again) {
				if (again instanceof ApiError && again.code === "idempotency_conflict") {
					key = newIdempotencyKey();
					writePipelineKey(projectId, revision, key);
				}
				throw again;
			}
		}
	}

	const onStart = async () => {
		if (!project || busy || pipelineActiveRef.current) return;
		const pipelineNow = pipelineStatusRef.current;
		const pipelineTerminal = pipelineNow === "COMPLETED" || pipelineNow === "PARTIAL" || pipelineNow === "FAILED";
		const currentRun = runsRef.current.runRef.current;
		if (!pipelineTerminal && currentRun && currentRun.project_id === project.id && !isTerminalRun(currentRun.status)) return;
		const signal = replaceAbort();
		setBusy(true);
		setError(null);
		setPipelineNote(null);
		let accepted: StartedPipeline | null = null;
		let acceptedProjectId = "";
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
					const projectId = current.id;
					setFailedCompiles((known) => ({ ...known, [projectId]: new Date().toISOString() }));
					setError({ summary: compileErrorMessage(job.error) });
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
				current = await refreshProject(current.id, signal);
				writeStamp(current.id, current.demand_revision);
			}
			setActivity("正在开始分析");
			const revision = current.demand_revision;
			try {
				accepted = await postPipeline(current.id, revision, signal);
			} catch (caught) {
				if (caught instanceof ApiError && caught.code === "idempotency_conflict") return;
				if (caught instanceof ApiError && caught.code === "demand_revision_changed") {
					writePipelineKey(current.id, revision, null);
					sessionStorage.removeItem(stampKey(current.id));
					await refreshProject(current.id, signal);
					setStartOffer(null);
					setError({ summary: DEMAND_CHANGED });
					return;
				}
				if (caught instanceof ApiError && caught.code === "workflow_start_failed") {
					setStartOffer("retry");
					setError({ summary: ANALYSIS_NOT_STARTED });
					return;
				}
				throw caught;
			}
			writePipelineKey(current.id, revision, null);
			writePipelineId(current.id, accepted.pipeline_id);
			acceptedProjectId = current.id;
			setFailedCompiles((known) => {
				if (!(current.id in known)) return known;
				const next = { ...known };
				delete next[current.id];
				return next;
			});
			setStartOffer(null);
			setPipelineStatus(accepted.status);
			setPipelineRunId(accepted.run_id);
			setPipelineLine(pipelineProgressLine(accepted.status, null, null));
			markPipelineActive(accepted.status === "QUEUED" || accepted.status === "RUNNING");
		} catch (caught) {
			if (!isAbort(caught)) setError(messageForApiError(caught));
		} finally {
			setActivity(null);
			setBusy(false);
		}
		if (!accepted || !acceptedProjectId || signal.aborted) return;
		try {
			await followPipeline(acceptedProjectId, accepted.pipeline_id, signal);
		} catch (caught) {
			if (!isAbort(caught)) setError(messageForApiError(caught));
		}
	};

	const selectRun = (runId: string) => {
		const projectId = activeRef.current;
		if (!projectId || runsRef.current.runRef.current?.id === runId) return;
		if (!pipelineActiveRef.current) {
			setPipelineLine(null);
			setPipelineNote(null);
		}
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
		onSample,
		sampleBusy,
		runHistory,
		selectRun,
		pipelineLine,
		pipelineNote,
		pipelineActive,
		pipelineStatus,
		compileFailedAt: activeProjectId ? failedCompiles[activeProjectId] ?? null : null,
		pipelineRunId,
		pipelineStages,
		reportStatus,
		startOffer,
	};
}
