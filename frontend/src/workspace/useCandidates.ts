import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { isAbort, isTerminalRun, messageForApiError } from "../api/adapter";
import type { ApiClient } from "../api/client";
import type { EvidenceDetail, JobStatus, Run, SourcingDecision, SpecAssessment } from "../api/types";
import { decisionCoversRun } from "../view/report";
import { buildCandidateRows, jobIsStalled, procurementLine, type CandidateRowView } from "../view/candidates";
import { POLL_INTERVAL_MS, pollUntil } from "./poll";

export type CandidateModel = {
	rows: CandidateRowView[];
	progressLine: string | null;
	listNote: string | null;
	loading: boolean;
	loadError: string | null;
	decisionsReady: boolean;
	reportBlockReason: string | null;
	selectedId: string | null;
	select: (id: string) => void;
	evidence: EvidenceDetail | null;
	evidenceError: string | null;
	openEvidence: (evidenceId: string) => void;
};

export function useCandidates(
	clientRef: MutableRefObject<ApiClient>,
	projectId: string | null,
	run: Run | null,
	demandRevision: number | null,
): CandidateModel {
	const [rows, setRows] = useState<CandidateRowView[]>([]);
	const [progressLine, setProgressLine] = useState<string | null>(null);
	const [listNote, setListNote] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [decisionsReady, setDecisionsReady] = useState(false);
	const [reportBlockReason, setReportBlockReason] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [evidence, setEvidence] = useState<EvidenceDetail | null>(null);
	const [evidenceError, setEvidenceError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const evidenceAbortRef = useRef<AbortController | null>(null);
	const runId = run?.project_id === projectId ? run.id : null;
	const runStatus = run?.project_id === projectId ? run.status : null;
	const runUpdatedAt = run?.project_id === projectId ? run.updated_at : null;

	useEffect(() => {
		abortRef.current?.abort();
		setSelectedId(null);
		setEvidence(null);
		setEvidenceError(null);
		setLoadError(null);
		setDecisionsReady(false);
		setReportBlockReason(null);
		if (!projectId || !runId || !runStatus) {
			setRows([]);
			setProgressLine(null);
			setListNote(null);
			setLoading(false);
			return;
		}
		if (!isTerminalRun(runStatus)) {
			setRows([]);
			setListNote(null);
			setLoading(false);
			setProgressLine(procurementLine({ runStatus, spec: null, decision: null, hasAssessments: false, hasDecisions: false }).line);
			return;
		}
		const controller = new AbortController();
		abortRef.current = controller;
		const signal = controller.signal;
		const currentProject = projectId;
		setLoading(true);
		void (async () => {
			try {
				const [candidates, requirements] = await Promise.all([
					clientRef.current.listCandidates(currentProject, runId, { signal }),
					clientRef.current.getRequirements(currentProject, { signal }),
				]);
				if (signal.aborted) return;
				const document = requirements.state === "ready" ? requirements.body : null;
				const watchJob = async (kind: "spec" | "decision"): Promise<JobStatus> => {
					const current = await clientRef.current.getJobStatus(currentProject, kind, { signal });
					if (current.status !== "QUEUED" && current.status !== "RUNNING") return current;
					if (!current.updated_at || jobIsStalled(current)) return current;
					return pollUntil({
						intervalMs: POLL_INTERVAL_MS,
						timeoutMs: 30 * 60 * 1000,
						signal,
						tick: async () => {
							const next = await clientRef.current.getJobStatus(currentProject, kind, { signal });
							if (jobIsStalled(next) || (next.status !== "QUEUED" && next.status !== "RUNNING")) return next;
							return null;
						},
					});
				};
				const loadList = async (job: JobStatus, load: () => Promise<SpecAssessment[] | SourcingDecision[]>) => {
					if (job.status !== "COMPLETED" && job.status !== "IDLE" && !jobIsStalled(job)) return [];
					return load();
				};
				const specTask = watchJob("spec").then(async (job) => ({
					job,
					rows: (await loadList(job, () => clientRef.current.listAssessments(currentProject, { signal }))) as SpecAssessment[],
				}));
				const decisionTask = watchJob("decision").then(async (job) => ({
					job,
					rows: (await loadList(job, () => clientRef.current.listDecisions(currentProject, { signal }))) as SourcingDecision[],
				}));
				const specResult = await specTask;
				if (signal.aborted) return;
				const paint = (assessments: SpecAssessment[], decisions: SourcingDecision[], spec: JobStatus, decision: JobStatus | null) => {
					const gate = decision
						? decisionCoversRun({ runUpdatedAt, projectDemandRevision: demandRevision, job: decision })
						: { ready: false, reason: "报告还没有生成" };
					const built = buildCandidateRows({
						candidates,
						assessments,
						decisions,
						requirements: document,
						decisionsReady: gate.ready,
					});
					const progress = procurementLine({
						runStatus,
						spec,
						decision,
						hasAssessments: assessments.length > 0,
						hasDecisions: gate.ready,
					});
					setRows(built);
					setProgressLine(progress.line);
					setListNote(built.length > 0 ? progress.listNote : null);
					setDecisionsReady(gate.ready);
					setReportBlockReason(runStatus === "COMPLETED" || runStatus === "PARTIAL" ? (gate.ready ? null : gate.reason) : null);
					setLoading(false);
				};
				paint(specResult.rows, [], specResult.job, null);
				const decisionResult = await decisionTask;
				if (signal.aborted) return;
				paint(specResult.rows, decisionResult.rows, specResult.job, decisionResult.job);
			} catch (caught) {
				if (!isAbort(caught)) {
					setRows([]);
					setListNote(null);
					setLoadError(messageForApiError(caught).summary);
					setProgressLine(messageForApiError(caught).summary);
				}
			} finally {
				if (!signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [clientRef, projectId, runId, runStatus, runUpdatedAt, demandRevision]);

	const select = (id: string) => {
		setSelectedId(id);
		setEvidence(null);
		setEvidenceError(null);
	};

	const openEvidence = (evidenceId: string) => {
		evidenceAbortRef.current?.abort();
		const controller = new AbortController();
		evidenceAbortRef.current = controller;
		setEvidenceError(null);
		void clientRef.current.getEvidence(evidenceId, { signal: controller.signal }).then(
			(detail) => {
				if (!controller.signal.aborted) setEvidence(detail);
			},
			(caught: unknown) => {
				if (!isAbort(caught)) setEvidenceError(messageForApiError(caught).summary);
			},
		);
	};

	return { rows, progressLine, listNote, loading, loadError, decisionsReady, reportBlockReason, selectedId, select, evidence, evidenceError, openEvidence };
}
