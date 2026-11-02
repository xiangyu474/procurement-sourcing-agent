import { sanitizePublicText } from "../api/adapter";
import type { Report } from "../api/types";

export type ReportPhase = "hidden" | "blocked" | "ready" | "generating" | "failed";

export function selectReport(reports: Report[], runId: string): Report | null {
	const mine = reports.filter((report) => report.run_id === runId);
	return (
		mine.find((report) => report.status === "COMPLETED" && report.download_path) ??
		mine.find((report) => report.status === "QUEUED" || report.status === "RUNNING") ??
		mine[0] ??
		null
	);
}

export function reportFileName(title: string, runCreatedAt: string): string {
	const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "寻源报告";
	const date = new Date(runCreatedAt);
	if (Number.isNaN(date.getTime())) return `${safe}.docx`;
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${safe}-${month}月${day}日${hour}时${minute}分.docx`;
}

export function reportFailure(error: string | null): string {
	const cleaned = error ? sanitizePublicText(error) : "";
	if (!cleaned || /^[A-Za-z0-9_]+$/.test(cleaned)) return "生成失败。";
	return `生成失败。${cleaned}`;
}

/** The download control. A long list cannot start a report. */
export function reportPhase(input: { runStatus: string | null; decisionsReady: boolean; report: Report | null; pending: boolean }): ReportPhase {
	const finished = input.runStatus === "COMPLETED" || input.runStatus === "PARTIAL";
	if (!finished) return "hidden";
	if (!input.decisionsReady) return "blocked";
	if (input.pending || input.report?.status === "QUEUED" || input.report?.status === "RUNNING") return "generating";
	if (input.report?.status === "COMPLETED" && input.report.download_path) return "ready";
	if (input.report?.status === "FAILED") return "failed";
	return "ready";
}
