import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { isAbort, isTerminalRun, messageForApiError } from "../api/adapter";
import type { ApiClient } from "../api/client";
import type { EvidenceDetail, Run } from "../api/types";
import { buildCandidateRows, jobStatusLine, type CandidateRowView } from "../view/candidates";
import { POLL_INTERVAL_MS, pollUntil } from "./poll";

const JOB_TIMEOUT_MS = 20 * 60 * 1000;

export type CandidateModel = {
	rows: CandidateRowView[];
	statusLines: string[];
	loading: boolean;
	selectedId: string | null;
	select: (id: string) => void;
	evidence: EvidenceDetail | null;
	evidenceError: string | null;
	openEvidence: (evidenceId: string) => void;
};

export function useCandidates(clientRef: MutableRefObject<ApiClient>, projectId: string | null, run: Run | null): CandidateModel {
	const [rows, setRows] = useState<CandidateRowView[]>([]);
	const [statusLines, setStatusLines] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [evidence, setEvidence] = useState<EvidenceDetail | null>(null);
	const [evidenceError, setEvidenceError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const evidenceAbortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		abortRef.current?.abort();
		setSelectedId(null);
		setEvidence(null);
		setEvidenceError(null);
		if (!projectId || !run || run.project_id !== projectId || !isTerminalRun(run.status)) {
			setRows([]);
			setStatusLines([]);
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		abortRef.current = controller;
		const signal = controller.signal;
		const currentProject = projectId;
		const runId = run.id;
		setLoading(true);
		void (async () => {
			try {
				const [candidates, requirements] = await Promise.all([
					clientRef.current.listCandidates(currentProject, runId, { signal }),
					clientRef.current.getRequirements(currentProject, { signal }),
				]);
				if (signal.aborted) return;
				const document = requirements.state === "ready" ? requirements.body : null;
				setRows(buildCandidateRows({ candidates, assessments: [], decisions: [], requirements: document }));
				setLoading(false);
				const settle = async (kind: "spec" | "decision") => {
					const current = await clientRef.current.getJobStatus(currentProject, kind, { signal });
					if (current.status !== "QUEUED" && current.status !== "RUNNING") return current;
					try {
						return await pollUntil({
							intervalMs: POLL_INTERVAL_MS,
							timeoutMs: JOB_TIMEOUT_MS,
							signal,
							tick: async () => {
								const job = await clientRef.current.getJobStatus(currentProject, kind, { signal });
								if (job.status === "QUEUED" || job.status === "RUNNING") return null;
								return job;
							},
						});
					} catch (caught) {
						if (isAbort(caught)) throw caught;
						const waiting = kind === "spec" ? "技术核对超过 20 分钟仍未结束。" : "决策超过 20 分钟仍未结束。";
						return { status: "FAILED", job_id: current.job_id, demand_revision: current.demand_revision, error: waiting };
					}
				};
				const [specNow, decisionNow] = await Promise.all([
					clientRef.current.getJobStatus(currentProject, "spec", { signal }),
					clientRef.current.getJobStatus(currentProject, "decision", { signal }),
				]);
				if (signal.aborted) return;
				setStatusLines([jobStatusLine("spec", specNow), jobStatusLine("decision", decisionNow)].filter((line): line is string => Boolean(line)));
				const [specJob, decisionJob] = await Promise.all([
					specNow.status === "QUEUED" || specNow.status === "RUNNING" ? settle("spec") : Promise.resolve(specNow),
					decisionNow.status === "QUEUED" || decisionNow.status === "RUNNING" ? settle("decision") : Promise.resolve(decisionNow),
				]);
				if (signal.aborted) return;
				const [assessments, decisions] = await Promise.all([
					specJob.status === "COMPLETED" ? clientRef.current.listAssessments(currentProject, { signal }) : Promise.resolve([]),
					decisionJob.status === "COMPLETED" ? clientRef.current.listDecisions(currentProject, { signal }) : Promise.resolve([]),
				]);
				if (signal.aborted) return;
				setRows(buildCandidateRows({ candidates, assessments, decisions, requirements: document }));
				setStatusLines([jobStatusLine("spec", specJob), jobStatusLine("decision", decisionJob)].filter((line): line is string => Boolean(line)));
			} catch (caught) {
				if (!isAbort(caught)) {
					setRows([]);
					setStatusLines([messageForApiError(caught).summary]);
				}
			} finally {
				if (!signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [clientRef, projectId, run]);

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

	return { rows, statusLines, loading, selectedId, select, evidence, evidenceError, openEvidence };
}
