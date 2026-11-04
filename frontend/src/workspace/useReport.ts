import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { isAbort, messageForApiError } from "../api/adapter";
import type { ApiClient } from "../api/client";
import { ApiError, type AnalysisReport, type Report, type Run } from "../api/types";
import { COMPILE_TIMEOUT_MS, POLL_INTERVAL_MS, pollUntil } from "./poll";
import {
	PRIOR_REPORT_FAILURE,
	REPORT_NETWORK_FAILURE,
	REPORT_NOT_ALLOWED,
	reportFailure,
	reportFileName,
	reportFromAnalysis,
	selectReport,
} from "../view/report";

export type ReportModel = {
	report: Report | null;
	pending: boolean;
	note: string | null;
	download: () => Promise<void>;
};

function saveBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/**
 * The report of the run the user is looking at. The analysis carries the
 * status of that report, so the button follows the frozen version and never
 * a report of another run.
 */
export function useReport(
	clientRef: MutableRefObject<ApiClient>,
	projectId: string | null,
	projectTitle: string,
	run: Run | null,
	decisionsReady: boolean,
	analysisReport: AnalysisReport | null,
	pipelineId: string | null,
	canRequestReport: boolean,
): ReportModel {
	const [report, setReport] = useState<Report | null>(null);
	const [pending, setPending] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const runId = run?.project_id === projectId ? run.id : null;
	const finished = run?.status === "COMPLETED" || run?.status === "PARTIAL";

	useEffect(() => {
		abortRef.current?.abort();
		setReport(null);
		setNote(null);
		setPending(false);
		if (!projectId || !runId || !finished || !decisionsReady) return;
		const controller = new AbortController();
		abortRef.current = controller;
		const signal = controller.signal;
		const known = reportFromAnalysis(analysisReport, runId);
		if (known) {
			setReport(known);
			if (known.status === "FAILED") setNote(PRIOR_REPORT_FAILURE);
			// The report record carries the times. The analysis only carries the state.
			void clientRef.current.listReports(projectId, { signal }).then(
				(listed) => {
					if (signal.aborted) return;
					const selected = selectReport(listed, runId);
					if (selected && selected.status === known.status) setReport(selected);
				},
				() => undefined,
			);
			return;
		}
		if (!analysisReport) return;
		// The report of this version is being written. Wait for the file list to
		// show it and then for it to settle.
		setPending(true);
		void (async () => {
			try {
				const settled = await pollUntil<Report>({
					intervalMs: POLL_INTERVAL_MS,
					timeoutMs: COMPILE_TIMEOUT_MS,
					signal,
					tick: async () => {
						const listed = await clientRef.current.listReports(projectId, { signal });
						const selected = selectReport(listed, runId);
						if (!selected) return null;
						setReport(selected);
						if (selected.status === "QUEUED" || selected.status === "RUNNING") return null;
						return selected;
					},
				});
				setReport(settled);
				if (settled.status === "COMPLETED" && settled.download_path) setNote(null);
				else setNote(reportFailure(settled.error));
				setPending(false);
			} catch (caught) {
				if (isAbort(caught)) return;
				const timeout = caught instanceof ApiError && caught.code === "timeout";
				setNote(timeout ? "报告超过 20 分钟仍未生成。" : noteFor(caught));
				setPending(false);
			}
		})();
		return () => controller.abort();
	}, [clientRef, projectId, runId, finished, decisionsReady, analysisReport]);

	const download = async () => {
		if (!projectId || !run || !finished || !decisionsReady || pending) return;
		const filename = reportFileName(projectTitle, run.created_at);
		if (report?.status === "COMPLETED" && report.download_path) {
			try {
				const blob = await clientRef.current.downloadReport(report.download_path);
				saveBlob(blob, filename);
			} catch (caught) {
				if (!isAbort(caught)) setNote(noteFor(caught));
			}
			return;
		}
		if (!canRequestReport) {
			setNote(REPORT_NOT_ALLOWED);
			return;
		}
		const controller = new AbortController();
		abortRef.current?.abort();
		abortRef.current = controller;
		try {
			// A visitor may ask for a new report of a finished task. The task route
			// is the one a visitor is allowed to use.
			const queued = pipelineId
				? await clientRef.current.retryPipelineReport(projectId, pipelineId, { signal: controller.signal })
				: await clientRef.current.createReport(projectId, run.id, { signal: controller.signal });
			setReport(queued);
			const done = await pollUntil<Report>({
				intervalMs: POLL_INTERVAL_MS,
				timeoutMs: COMPILE_TIMEOUT_MS,
				signal: controller.signal,
				tick: async () => {
					const current = await clientRef.current.getReport(projectId, queued.report_id, { signal: controller.signal });
					if (current.status === "QUEUED" || current.status === "RUNNING") return null;
					return current;
				},
			});
			setReport(done);
			if (!done.download_path || controller.signal.aborted) {
				setNote(reportFailure(done.error));
				return;
			}
			const blob = await clientRef.current.downloadReport(done.download_path, { signal: controller.signal });
			if (controller.signal.aborted) return;
			saveBlob(blob, filename);
		} catch (caught) {
			if (!isAbort(caught)) setNote(noteFor(caught));
		}
	};

	return { report, pending, note, download };
}

function noteFor(caught: unknown): string {
	if (caught instanceof ApiError && caught.code === "network") return REPORT_NETWORK_FAILURE;
	if (caught instanceof ApiError && caught.code === "operation_unavailable") return REPORT_NOT_ALLOWED;
	return messageForApiError(caught).summary;
}
