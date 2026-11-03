import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { isAbort, messageForApiError } from "../api/adapter";
import type { ApiClient } from "../api/client";
import { ApiError, type Report, type Run } from "../api/types";
import { COMPILE_TIMEOUT_MS, POLL_INTERVAL_MS, pollUntil } from "./poll";
import { PRIOR_REPORT_FAILURE, REPORT_NETWORK_FAILURE, reportFailure, reportFileName, selectReport } from "../view/report";

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

export function useReport(
	clientRef: MutableRefObject<ApiClient>,
	projectId: string | null,
	projectTitle: string,
	run: Run | null,
	decisionsReady: boolean,
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
		if (!projectId || !runId || !finished) return;
		const controller = new AbortController();
		abortRef.current = controller;
		const signal = controller.signal;
		const allowGenerate = decisionsReady;
		void (async () => {
			try {
				const listed = await clientRef.current.listReports(projectId, { signal }).catch((caught: unknown) => {
					if (caught instanceof ApiError && caught.status === 404) return [];
					throw caught;
				});
				if (signal.aborted) return;
				const selected = selectReport(listed, runId);
				setReport(selected);
				if (!allowGenerate) return;
				if (selected?.status === "FAILED") setNote(PRIOR_REPORT_FAILURE);
				if (selected && (selected.status === "QUEUED" || selected.status === "RUNNING")) {
					await settle(projectId, selected.report_id, signal);
				}
			} catch (caught) {
				if (!isAbort(caught)) setNote(noteFor(caught));
			}
		})();
		return () => controller.abort();
	}, [clientRef, projectId, runId, finished, decisionsReady]);

	async function settle(currentProject: string, reportId: string, signal: AbortSignal): Promise<Report | null> {
		setPending(true);
		setNote(null);
		try {
			const done = await pollUntil<Report>({
				intervalMs: POLL_INTERVAL_MS,
				timeoutMs: COMPILE_TIMEOUT_MS,
				signal,
				tick: async () => {
					const current = await clientRef.current.getReport(currentProject, reportId, { signal });
					if (current.status === "QUEUED" || current.status === "RUNNING") return null;
					return current;
				},
			});
			setReport(done);
			if (done.status === "COMPLETED" && done.download_path) {
				setNote(null);
				setPending(false);
				return done;
			}
			setNote(reportFailure(done.error));
			setPending(false);
			return null;
		} catch (caught) {
			if (isAbort(caught)) return null;
			const timeout = caught instanceof ApiError && caught.code === "timeout";
			setNote(timeout ? "报告超过 20 分钟仍未生成。" : noteFor(caught));
			setPending(false);
			return null;
		}
	}

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
		const controller = new AbortController();
		abortRef.current?.abort();
		abortRef.current = controller;
		try {
			const queued = await clientRef.current.createReport(projectId, run.id, { signal: controller.signal });
			setReport(queued);
			const done = await settle(projectId, queued.report_id, controller.signal);
			if (!done?.download_path || controller.signal.aborted) return;
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
	return messageForApiError(caught).summary;
}
